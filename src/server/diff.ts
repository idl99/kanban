import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./git";

export type DiffStatus = "A" | "M" | "D" | "R";

export interface DiffLine {
  type: "ctx" | "add" | "del";
  text: string;
  /** Line number in the base version (null for added lines). */
  old: number | null;
  /** Line number in the worktree version (null for deleted lines). */
  new: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  /** Previous path of a rename. */
  oldPath?: string;
  status: DiffStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Too many changed lines to show; hunks are left out. */
  tooLarge: boolean;
  hunks: DiffHunk[];
}

export interface TicketDiff {
  /** The ref the merge-base was taken with (e.g. "main" or "origin/main"). */
  base: string;
  mergeBase: string;
  branch: string | null;
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** Shown instead of files when the changes can't be worked out (e.g. the folder's history was rewritten). */
  note?: string;
}

export class DiffError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Files whose patch is longer than this many lines are listed without content. */
export const MAX_FILE_LINES = 3000;

/**
 * The merge-base of HEAD with the base branch. Both the local branch and its origin/ copy are tried
 * and the newer merge-base wins, so a branch rebased onto a freshly fetched origin/main doesn't show
 * commits the local main hasn't caught up with yet.
 */
async function mergeBase(dir: string, base: string): Promise<{ ref: string; sha: string } | null> {
  const refs = [...new Set([base, base.startsWith("origin/") ? "" : `origin/${base}`].filter(Boolean))];
  let best: { ref: string; sha: string } | null = null;
  for (const ref of refs) {
    const r = await run(["git", "merge-base", "HEAD", ref], dir);
    const sha = r.stdout.trim();
    if (r.code !== 0 || !sha) continue;
    if (!best) best = { ref, sha };
    else if (sha !== best.sha && (await run(["git", "merge-base", "--is-ancestor", best.sha, sha], dir)).code === 0) best = { ref, sha };
  }
  return best;
}

/**
 * The worktree's changes against the merge-base with `base`: commits on the branch plus staged,
 * unstaged and untracked (not ignored) files. Untracked files are picked up by staging everything
 * into a throwaway index, so the real index is never touched.
 */
export async function ticketDiff(dir: string, base: string, opts: { ignoreWhitespace?: boolean } = {}): Promise<TicketDiff> {
  if (!existsSync(dir)) throw new DiffError(404, "the ticket's worktree no longer exists");
  const mb = await mergeBase(dir, base);
  if (!mb) throw new DiffError(400, `no common ancestor with the base branch "${base}"`);
  return diffFrom(dir, mb, opts);
}

/** Says why a folder's changes can't be shown since `sha`. */
export const REWRITTEN_NOTE = "The project folder's version history changed since this ticket started (for example a branch switch or a reset), so its changes can't be shown here. Claude's summary lists the files it changed.";

/**
 * A ticket that works in the board's folder itself: everything there (commits, staged, unstaged and untracked)
 * since `sha`, the folder's HEAD at the ticket's first run. If `sha` is no longer an ancestor of HEAD, a note
 * replaces the files.
 */
export async function folderDiff(dir: string, sha: string, opts: { ignoreWhitespace?: boolean } = {}): Promise<TicketDiff> {
  if (!existsSync(dir)) throw new DiffError(404, "the board's folder no longer exists");
  const ref = sha.slice(0, 7);
  if ((await run(["git", "merge-base", "--is-ancestor", sha, "HEAD"], dir)).code !== 0) {
    const branch = (await run(["git", "branch", "--show-current"], dir)).stdout.trim() || null;
    return { base: ref, mergeBase: sha, branch, files: [], additions: 0, deletions: 0, note: REWRITTEN_NOTE };
  }
  return diffFrom(dir, { ref, sha }, opts);
}

async function diffFrom(dir: string, mb: { ref: string; sha: string }, opts: { ignoreWhitespace?: boolean }): Promise<TicketDiff> {
  const branch = (await run(["git", "branch", "--show-current"], dir)).stdout.trim() || null;

  const index = join(tmpdir(), `ckanban-diff-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    let r = await run(["git", "read-tree", "HEAD"], dir, env);
    if (r.code === 0) r = await run(["git", "add", "-A"], dir, env);
    if (r.code !== 0) throw new DiffError(500, `git failed: ${r.stderr.trim()}`);
    const args = ["git", "-c", "core.quotePath=false", "diff", "--cached", "-M", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];
    if (opts.ignoreWhitespace) args.push("-w");
    r = await run([...args, mb.sha], dir, env);
    if (r.code !== 0) throw new DiffError(500, `git diff failed: ${r.stderr.trim()}`);
    const files = parseDiff(r.stdout);
    return {
      base: mb.ref, mergeBase: mb.sha, branch, files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

/** Undo git's C-style quoting of a path ("a/t\303\251st" etc.). */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes: number[] = [];
  const s = p.slice(1, -1);
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, "\\": 92 };
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") {
      bytes.push(...new TextEncoder().encode(s[i]));
      continue;
    }
    const n = s[++i];
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(esc[n] ?? n.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** A path from a ---/+++ line: "a/x", "b/x" or /dev/null (git may add a tab after names with spaces). */
function side(rest: string): string | null {
  const p = unquote(rest.replace(/\t$/, ""));
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

/** Parse `git diff` patch output into files, hunks and numbered lines. */
export function parseDiff(out: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let patchLines = 0;
  const finish = () => {
    if (f?.tooLarge) f.hunks = [];
  };
  const lines = out.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finish();
      // "a/P b/P": for an unrenamed file both halves are equal, so the path is the middle split.
      const rest = line.slice(11);
      const half = rest.length >= 5 ? unquote(rest.slice(0, (rest.length - 1) / 2)) : "";
      f = { path: half.replace(/^a\//, ""), status: "M", additions: 0, deletions: 0, binary: false, tooLarge: false, hunks: [] };
      files.push(f);
      hunk = null;
      patchLines = 0;
      continue;
    }
    if (!f) continue;
    if (!hunk) {
      if (line.startsWith("new file mode")) f.status = "A";
      else if (line.startsWith("deleted file mode")) f.status = "D";
      else if (line.startsWith("rename from ")) { f.status = "R"; f.oldPath = unquote(line.slice(12)); }
      else if (line.startsWith("rename to ")) f.path = unquote(line.slice(10));
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") f.binary = true;
      else if (line.startsWith("--- ")) {
        const p = side(line.slice(4));
        if (p && f.status !== "R") f.path = p;
      } else if (line.startsWith("+++ ")) {
        const p = side(line.slice(4));
        if (p) f.path = p;
      }
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { header: line, lines: [] };
      f.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const c = line[0];
    if (c === "\\") continue; // "\ No newline at end of file"
    if (++patchLines > MAX_FILE_LINES) f.tooLarge = true;
    const text = line.slice(1);
    if (c === "+") {
      f.additions++;
      if (!f.tooLarge) hunk.lines.push({ type: "add", text, old: null, new: newNo });
      newNo++;
    } else if (c === "-") {
      f.deletions++;
      if (!f.tooLarge) hunk.lines.push({ type: "del", text, old: oldNo, new: null });
      oldNo++;
    } else {
      if (!f.tooLarge) hunk.lines.push({ type: "ctx", text, old: oldNo, new: newNo });
      oldNo++;
      newNo++;
    }
  }
  finish();
  return files;
}
