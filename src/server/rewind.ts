import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { hasCommits, run } from "./git";

/** Rewind: go back to an earlier message of the ticket chat, with the project files as they were just before it. */

/** Snapshots live under this ref folder, so they never show up as branches or touch the user's own history. */
export const REWIND_REFS = "refs/ckanban/rewind";

const IDENTITY = {
  GIT_AUTHOR_NAME: "ckanban", GIT_AUTHOR_EMAIL: "ckanban@localhost",
  GIT_COMMITTER_NAME: "ckanban", GIT_COMMITTER_EMAIL: "ckanban@localhost",
};

/** Same text as the chat shows for a message: attachment links reduce to the file name. */
const norm = (s: string) => s.trim().replace(/\S*\/attachments\/([0-9a-f]{32}\.\w+)/g, "$1");

/** Short fingerprint of a message's text, to tell which snapshot belongs to which message. */
export function textKey(text: string): string {
  return createHash("sha1").update(norm(text)).digest("hex").slice(0, 12);
}

/** Runs f with a throwaway git index, so the folder's own staged changes are never touched. */
async function withIndex<T>(f: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ck-rewind-"));
  try {
    return await f({ GIT_INDEX_FILE: join(dir, "index"), ...IDENTITY });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GIT = ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];

/** The repo's top folder when `dir` has version history (a repo with at least one commit), else null. */
async function historyTop(dir: string): Promise<string | null> {
  if (!existsSync(dir) || !(await hasCommits(dir))) return null;
  const top = await run(["git", "rev-parse", "--show-toplevel"], dir);
  return top.code === 0 && top.stdout.trim() ? top.stdout.trim() : null;
}

/** Tree of everything in `dir` right now (new and changed files included, ignored files left out). */
async function currentTree(dir: string, env: Record<string, string>): Promise<string | null> {
  const add = await run([...GIT, "add", "-A", "--", "."], dir, env);
  if (add.code !== 0) return null;
  const tree = await run([...GIT, "write-tree"], dir, env);
  return tree.code === 0 ? tree.stdout.trim() : null;
}

/**
 * Saves how the folder looks right now as a hidden snapshot, tied to the message about to be sent.
 * Null when there is no version history (nothing to undo later) or the snapshot failed: rewind then leaves files alone.
 */
export async function takeSnapshot(dir: string, ticketId: string, text: string, at = Date.now()): Promise<string | null> {
  try {
    if (!(await historyTop(dir))) return null;
    return await withIndex(async (env) => {
      const tree = await currentTree(dir, env);
      if (!tree) return null;
      const commit = await run([...GIT, "commit-tree", tree, "-m", `ckanban rewind snapshot for ${ticketId}`], dir, env);
      if (commit.code !== 0) return null;
      const ref = `${REWIND_REFS}/${ticketId}/${at}-${textKey(text)}`;
      const set = await run(["git", "update-ref", ref, commit.stdout.trim()], dir);
      return set.code === 0 ? ref : null;
    });
  } catch {
    return null;
  }
}

export interface Snapshot {
  ref: string;
  at: number;
  key: string;
}

export async function listSnapshots(dir: string, ticketId: string): Promise<Snapshot[]> {
  if (!existsSync(dir)) return [];
  const r = await run(["git", "for-each-ref", "--format=%(refname)", `${REWIND_REFS}/${ticketId}/`], dir);
  if (r.code !== 0) return [];
  const out: Snapshot[] = [];
  for (const ref of r.stdout.split("\n")) {
    const m = ref.trim().match(/\/(\d+)-([0-9a-f]{12})$/);
    if (m) out.push({ ref: ref.trim(), at: Number(m[1]), key: m[2] });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The snapshot taken for a message: the latest one before Claude read it that has the same text. */
export function snapshotFor(snaps: Snapshot[], text: string, readAt: string): Snapshot | null {
  const key = textKey(text);
  const t = Date.parse(readAt);
  const own = snaps.filter((s) => s.key === key && (Number.isNaN(t) || s.at <= t + 1000));
  return own.at(-1) ?? null;
}

export type FileChange = { path: string; status: "A" | "D" | "M" };

/** Files that differ between the snapshot and the folder now. A: new since, D: deleted since, M: edited since. */
export async function changesSince(dir: string, ref: string): Promise<FileChange[] | null> {
  const top = await historyTop(dir);
  if (!top) return null;
  return withIndex(async (env) => {
    const tree = await currentTree(dir, env);
    if (!tree) return null;
    const d = await run(["git", "diff-tree", "-r", "-z", "--name-status", "--no-renames", ref, tree], dir);
    if (d.code !== 0) return null;
    const parts = d.stdout.split("\0").filter((x) => x !== "");
    const out: FileChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const s = parts[i][0];
      out.push({ path: parts[i + 1], status: s === "A" || s === "D" ? s : "M" });
    }
    return out;
  });
}

/** Puts the folder's files back as the snapshot has them. Returns the files that changed back. */
export async function restoreSnapshot(dir: string, ref: string): Promise<FileChange[]> {
  const top = await historyTop(dir);
  if (!top) throw new Error("This folder has no version history, so files can't be changed back.");
  const changes = await changesSince(dir, ref);
  if (!changes) throw new Error("Couldn't compare the files with the earlier point.");
  const inside = (p: string) => {
    const abs = resolve(top, p);
    return abs.startsWith(top + sep) ? abs : null;
  };
  const back = changes.filter((c) => c.status !== "A");
  await withIndex(async (env) => {
    const read = await run([...GIT, "read-tree", ref], top, env);
    if (read.code !== 0) throw new Error(`Couldn't read the earlier point: ${read.stderr.trim()}`);
    for (let i = 0; i < back.length; i += 100) {
      const chunk = back.slice(i, i + 100).map((c) => c.path);
      const r = await run([...GIT, "checkout-index", "-f", "--", ...chunk], top, env);
      if (r.code !== 0) throw new Error(`Couldn't restore files: ${r.stderr.trim()}`);
    }
  });
  for (const c of changes) {
    if (c.status !== "A") continue;
    const abs = inside(c.path);
    if (!abs) continue;
    try {
      unlinkSync(abs);
    } catch {
      continue;
    }
    // Folders the removed file leaves empty go too, never the project folder itself.
    for (let d = dirname(abs); d.startsWith(top + sep) && d !== top; d = dirname(d)) {
      try {
        if (readdirSync(d).length) break;
        rmdirSync(d);
      } catch {
        break;
      }
    }
  }
  return changes;
}

/** Drops the snapshots newer than `keep` (they belonged to messages that are gone now). */
export async function pruneSnapshots(dir: string, ticketId: string, keep: Snapshot | null): Promise<void> {
  for (const s of await listSnapshots(dir, ticketId)) {
    if (!keep || s.at > keep.at) await run(["git", "update-ref", "-d", s.ref], dir);
  }
}

export interface Cut {
  /** Lines the session keeps. */
  kept: number;
  /** True when nothing of the conversation is left. */
  empty: boolean;
}

/**
 * The session text up to (not including) the user message `uuid`. Null when that message isn't a plain user
 * message in the file (a message sent while Claude worked sits mid-turn, and cutting there would leave a tool call without result).
 */
export function cutSession(raw: string, uuid: string): { text: string; cut: Cut } | null {
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    let ev: any;
    try {
      ev = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (ev?.uuid !== uuid) continue;
    if (ev.type !== "user" || ev.isSidechain) return null;
    const content = ev.message?.content;
    if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) return null;
    const kept = lines.slice(0, i).filter(Boolean);
    const empty = !kept.some((l) => {
      try {
        const k = JSON.parse(l);
        return (k?.type === "user" || k?.type === "assistant") && !k.isSidechain;
      } catch {
        return false;
      }
    });
    return { text: kept.length ? `${kept.join("\n")}\n` : "", cut: { kept: kept.length, empty } };
  }
  return null;
}

/** Cuts the session file before the message. The original stays beside it as `<file>.before-rewind`. */
export function rewindSessionFile(file: string, uuid: string): Cut {
  const raw = readFileSync(file, "utf8");
  const r = cutSession(raw, uuid);
  if (!r) throw new Error("This message can't be rewound to.");
  copyFileSync(file, `${file}.before-rewind`);
  writeFileSync(file, r.text);
  return r.cut;
}

export interface RewindPreview {
  /** Files that would change back; null when they can't be (filesReason says why). */
  files: FileChange[] | null;
  filesReason: "no-history" | "no-snapshot" | null;
}

/** What going back to the message would change in the folder. `dir` is null while the ticket's folder isn't known yet. */
export async function previewRewind(dir: string | null, ticketId: string, entry: { text: string; at: string }): Promise<RewindPreview> {
  const snap = dir ? snapshotFor(await listSnapshots(dir, ticketId), entry.text, entry.at) : null;
  const files = dir && snap ? await changesSince(dir, snap.ref) : null;
  if (files) return { files, filesReason: null };
  return { files: null, filesReason: dir && (await hasCommits(dir)) ? "no-snapshot" : "no-history" };
}

/**
 * Goes back to the message: files first (when asked and a saved copy exists, so a failure leaves the chat whole),
 * then the chat is cut before it. Returns how many files changed back and what is left of the conversation.
 */
export async function applyRewind(
  o: { dir: string | null; ticketId: string; entry: { uuid: string; text: string; at: string }; sessionFile: string; files: boolean },
): Promise<{ restored: number; cut: Cut }> {
  const snap = o.dir ? snapshotFor(await listSnapshots(o.dir, o.ticketId), o.entry.text, o.entry.at) : null;
  let restored = 0;
  if (o.files && o.dir && snap) restored = (await restoreSnapshot(o.dir, snap.ref)).length;
  const cut = rewindSessionFile(o.sessionFile, o.entry.uuid);
  if (o.dir && snap) await pruneSnapshots(o.dir, o.ticketId, snap).catch(() => {});
  return { restored, cut };
}
