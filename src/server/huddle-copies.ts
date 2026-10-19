// Huddle helpers' own copies of the ticket's folder, and the changes they hand in (see huddle.ts).
//
// A helper that can change files works in a copy of its own: in a repo with commits, a git worktree at a commit of the
// host folder as it is now (its uncommitted and new files included, the user's index and files untouched); in a plain
// folder or a repo with no commits, a plain copy of the folder. Either way the board writes down every file's hash
// when the copy is made (the base). A hand-in is the files that differ from the base, saved aside as they are then, so
// later edits in the copy don't change what was handed in. Accepting copies them into the host folder file by file:
// a file the host folder also changed since the copy was made is a conflict, and on any conflict nothing is written.
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { branchExists, NO_HOOKS, run as git } from "./git";
import type { HandInFile } from "./types";

/** Folders a plain copy leaves out (and a plain folder's changes ignore): version history and installed or cached files. */
export const COPY_SKIP = new Set([".git", "node_modules", ".DS_Store", "__pycache__", ".venv", "venv", ".next", ".nuxt", ".cache"]);

/** Path -> sha1 of the file's bytes. */
export type Manifest = Record<string, string>;

/** What the board keeps about a copy: the base it started from, and what the helper last handed in (for the close check). */
export interface CopyState {
  base: Manifest;
  handed: Manifest | null;
}

export const hashBytes = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");

function hashFile(file: string): string | null {
  try {
    const st = lstatSync(file);
    return st.isFile() ? hashBytes(readFileSync(file)) : null;
  } catch {
    return null;
  }
}

/** Every regular file under `dir` (paths with "/"), leaving out COPY_SKIP and symlinks. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const go = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (COPY_SKIP.has(n)) continue;
      const f = join(d, n);
      const st = lstatSync(f);
      if (st.isDirectory()) go(f);
      else if (st.isFile()) out.push(relative(dir, f).split(sep).join("/"));
    }
  };
  go(dir);
  return out.sort();
}

/** The files a copy's changes are counted over: git's own list in a worktree (so ignored build output doesn't count), else every file. */
async function listFiles(dir: string, kind: "git" | "folder"): Promise<string[]> {
  if (kind === "folder") return walk(dir);
  const r = await git(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], dir);
  if (r.code !== 0) throw new Error(`couldn't list the files of ${dir}: ${r.stderr.trim()}`);
  return [...new Set(r.stdout.split("\0").filter(Boolean))].sort();
}

export async function scan(dir: string, kind: "git" | "folder"): Promise<Manifest> {
  const out: Manifest = {};
  for (const f of await listFiles(dir, kind)) {
    const h = hashFile(join(dir, f));
    if (h) out[f] = h;
  }
  return out;
}

/** Files that differ between two manifests, as a hand-in lists them. */
export function changes(base: Manifest, now: Manifest): HandInFile[] {
  const out: HandInFile[] = [];
  for (const [path, hash] of Object.entries(now)) {
    if (base[path] === hash) continue;
    out.push({ path, change: base[path] ? "changed" : "added", base: base[path] ?? null, hash });
  }
  for (const [path, hash] of Object.entries(base)) if (!(path in now)) out.push({ path, change: "removed", base: hash, hash: null });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Where the board keeps a copy's base and hand-ins: next to the copy, never inside it (the helper's shell works there). */
export const stateFile = (copyDir: string) => `${copyDir}.copy.json`;
export const handInDir = (copyDir: string, id: string) => join(`${copyDir}.handins`, id);

export function readState(copyDir: string): CopyState | null {
  try {
    const s = JSON.parse(readFileSync(stateFile(copyDir), "utf8"));
    return s && typeof s.base === "object" ? { base: s.base, handed: s.handed ?? null } : null;
  } catch {
    return null;
  }
}

export function writeState(copyDir: string, s: CopyState) {
  mkdirSync(dirname(copyDir), { recursive: true });
  writeFileSync(stateFile(copyDir), JSON.stringify(s));
}

/**
 * Remove a copy and what the board kept about it. repo: the project, when the copy is a git worktree (its branch goes
 * too). keepHandIns: a fresh copy replaces it, and what was handed in stays readable.
 */
export async function removeCopy(copyDir: string, repo?: string, branch?: string | null, keepHandIns = false): Promise<void> {
  if (repo && existsSync(copyDir)) await git(["git", "worktree", "remove", "--force", copyDir], repo);
  rmSync(copyDir, { recursive: true, force: true });
  rmSync(stateFile(copyDir), { force: true });
  if (!keepHandIns) rmSync(`${copyDir}.handins`, { recursive: true, force: true });
  if (repo) {
    await git(["git", "worktree", "prune"], repo);
    if (branch && (await branchExists(repo, branch))) await git(["git", "branch", "-D", branch], repo);
  }
}

/**
 * A commit of `dir` as it is now, tracked changes and new (not ignored) files included, made with a temporary index
 * so the folder's own index, files and branches stay as they are. Its parent is HEAD.
 */
export async function snapshotCommit(dir: string): Promise<string> {
  const index = join(tmpdir(), `ck-index-${crypto.randomUUID()}`);
  const env = {
    GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "ckanban", GIT_AUTHOR_EMAIL: "ckanban@localhost", GIT_COMMITTER_NAME: "ckanban", GIT_COMMITTER_EMAIL: "ckanban@localhost",
  };
  try {
    const must = async (cmd: string[]) => {
      const r = await git(cmd, dir, env);
      if (r.code !== 0) throw new Error(`couldn't copy the ticket's folder (${cmd.slice(1, 3).join(" ")}): ${r.stderr.trim()}`);
      return r.stdout.trim();
    };
    await must(["git", "read-tree", "HEAD"]);
    await must(["git", "add", "-A"]);
    const tree = await must(["git", "write-tree"]);
    return await must(["git", "commit-tree", tree, "-p", "HEAD", "-m", "Copy of the ticket's folder for a huddle helper (ckanban)"]);
  } finally {
    rmSync(index, { force: true });
  }
}

/** A git copy: a worktree on `branch` at a snapshot of the host folder. Replaces an older copy at `dest`. */
export async function makeGitCopy(repo: string, hostDir: string, dest: string, branch: string): Promise<CopyState> {
  const sha = await snapshotCommit(hostDir);
  await removeCopy(dest, repo, branch, true);
  mkdirSync(dirname(dest), { recursive: true });
  const r = await git([...NO_HOOKS, "worktree", "add", "--no-track", "-b", branch, dest, sha], repo);
  if (r.code !== 0) throw new Error(`couldn't make a copy of the ticket's folder for the helper: ${r.stderr.trim()}`);
  const s = { base: await scan(dest, "git"), handed: null };
  writeState(dest, s);
  return s;
}

/** A plain copy of the host folder (without COPY_SKIP). Replaces an older copy at `dest`. */
export async function makeFolderCopy(hostDir: string, dest: string): Promise<CopyState> {
  await removeCopy(dest, undefined, null, true);
  mkdirSync(dirname(dest), { recursive: true });
  // Symlinks stay as they are: a relative one made absolute would point into the ticket's folder itself.
  cpSync(hostDir, dest, { recursive: true, verbatimSymlinks: true, filter: (src) => !COPY_SKIP.has(src.split(sep).at(-1)!) || src === hostDir });
  const s = { base: await scan(dest, "folder"), handed: null };
  writeState(dest, s);
  return s;
}

/**
 * The helper hands in what changed in its copy: those files are saved aside under `id` as they are now, and the copy
 * remembers them as handed in. Empty when nothing changed.
 */
export async function handIn(copyDir: string, kind: "git" | "folder", id: string): Promise<HandInFile[]> {
  const s = readState(copyDir);
  if (!s) throw new Error("the board lost track of this copy of the folder");
  const now = await scan(copyDir, kind);
  for (const f of Object.keys(now)) if (BAD_NAME.test(f) || !plainPath(copyDir, f)) delete now[f];
  const files = changes(s.base, now).filter((f) => !BAD_NAME.test(f.path));
  if (!files.length) return files;
  const dir = handInDir(copyDir, id);
  rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    if (!f.hash) continue;
    const bytes = readFileSync(join(copyDir, f.path));
    // Changed again between the scan and now: what is saved is what gets accepted.
    f.hash = hashBytes(bytes);
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), bytes);
  }
  writeState(copyDir, { ...s, handed: now });
  return files;
}

/** A path from a hand-in that stays inside `root` (no "..", not absolute, no control characters). */
function inside(root: string, path: string): string {
  const f = join(root, path);
  if (!path || path.startsWith("/") || BAD_NAME.test(path) || relative(root, f).split(sep)[0] === "..") throw new Error(`unsafe path in a hand-in: ${JSON.stringify(path)}`);
  return f;
}

/** Line breaks and other control characters: a file name with one could pass for another line where hand-ins are listed. */
const BAD_NAME = /[\u0000-\u001f\u007f\u2028\u2029]/;

/**
 * `path` under `root` is a plain file or nothing: no folder on the way is a symlink or a file, and the file itself
 * isn't a symlink, folder or device. Writing or reading through a symlink could reach outside the project.
 */
function plainPath(root: string, path: string): boolean {
  const parts = path.split("/");
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return true;
    }
    if (i < parts.length - 1 ? !st.isDirectory() || st.isSymbolicLink() : !st.isFile()) return false;
  }
  return true;
}

/**
 * Bring a hand-in into the host folder. A file the host folder changed since the copy was made (it is neither the
 * base nor already what was handed in) is a conflict; with any conflict nothing is written. Writing is all or nothing
 * too: a failed write puts back the files already written. Synchronous, so nothing else runs in between.
 */
export function accept(hostDir: string, copyDir: string, id: string, files: HandInFile[]): { conflicts: string[] } {
  const stash = handInDir(copyDir, id);
  // A symlink (or anything but a plain file) on the way in the ticket's folder counts as a conflict: nothing is written through it.
  const conflicts = files.filter((f) => {
    const file = inside(hostDir, f.path);
    if (!plainPath(hostDir, f.path)) return true;
    const cur = hashFile(file);
    return cur !== f.base && cur !== f.hash;
  }).map((f) => f.path);
  if (conflicts.length) return { conflicts };
  const done: { file: string; before: Buffer | null }[] = [];
  try {
    for (const f of files) {
      const file = inside(hostDir, f.path);
      const before = existsSync(file) ? readFileSync(file) : null;
      if (f.hash) {
        const bytes = readFileSync(inside(stash, f.path));
        if (hashBytes(bytes) !== f.hash) throw new Error(`the handed-in ${f.path} changed after the hand-in`);
        mkdirSync(dirname(file), { recursive: true });
        done.push({ file, before });
        writeFileSync(file, bytes);
      } else if (before) {
        done.push({ file, before });
        unlinkSync(file);
      }
    }
  } catch (e) {
    for (const d of done.reverse()) {
      try {
        if (d.before) writeFileSync(d.file, d.before);
        else rmSync(d.file, { force: true });
      } catch {}
    }
    throw e;
  }
  // Later hand-ins count from what the host folder now has.
  const s = readState(copyDir);
  if (s) {
    for (const f of files) {
      if (f.hash) s.base[f.path] = f.hash;
      else delete s.base[f.path];
    }
    writeState(copyDir, s);
  }
  return { conflicts: [] };
}

/** Where changes a helper never handed in are saved before its copy is made again (see keepUnhanded). */
export const keptDir = (copyDir: string) => `${copyDir}.kept`;

/**
 * Before a copy is made again: save the files it changed since its last hand-in (or since it was made) under
 * keptDir/<label>, with a REMOVED.txt listing files it deleted. The path, or null when nothing was unsent.
 */
export async function keepUnhanded(copyDir: string, kind: "git" | "folder", label: string): Promise<string | null> {
  const s = readState(copyDir);
  if (!s || !existsSync(copyDir)) return null;
  const now = await scan(copyDir, kind);
  const files = changes(s.handed ?? s.base, now).filter((f) => !BAD_NAME.test(f.path) && plainPath(copyDir, f.path));
  if (!files.length) return null;
  const dest = join(keptDir(copyDir), label);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const f of files) {
    if (!f.hash) continue;
    mkdirSync(dirname(join(dest, f.path)), { recursive: true });
    writeFileSync(join(dest, f.path), readFileSync(join(copyDir, f.path)));
  }
  const removed = files.filter((f) => !f.hash).map((f) => f.path);
  if (removed.length) writeFileSync(join(dest, "REMOVED.txt"), `${removed.join("\n")}\n`);
  return dest;
}

/** The copy has changes the helper never handed in (closing keeps it then, so nothing is lost). */
export async function unhanded(copyDir: string, kind: "git" | "folder"): Promise<boolean> {
  const s = readState(copyDir);
  if (!s || !existsSync(copyDir)) return false;
  return changes(s.handed ?? s.base, await scan(copyDir, kind)).length > 0;
}
