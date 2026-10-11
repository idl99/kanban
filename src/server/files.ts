import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export class FileError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const MAX_VIEW_BYTES = 1024 * 1024;

export interface FileEntry {
  name: string;
  /** Relative to the profile folder, "/"-separated. */
  path: string;
  type: "dir" | "file";
}

/** Absolute real path of `rel` inside `root`, or a FileError if it is missing or escapes root (`..`, symlinks). */
export function resolveInside(root: string, rel: string): string {
  if (rel.includes("\0")) throw new FileError(400, "invalid path");
  if (rel.split(/[/\\]/).includes("..")) throw new FileError(400, "path must not contain ..");
  let realRoot: string, real: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new FileError(404, "board folder not found");
  }
  try {
    real = realpathSync(join(realRoot, rel));
  } catch {
    throw new FileError(404, "not found");
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new FileError(403, "path is outside the board folder");
  return real;
}

/**
 * Opens a file inside the profile folder with the system's default app (`open` on macOS, `xdg-open` elsewhere).
 * argv only, never a shell; the path is checked with resolveInside first.
 */
export function openWithSystem(root: string, rel: string, bin = process.platform === "darwin" ? "open" : "xdg-open"): string {
  const file = resolveInside(root, rel);
  try {
    Bun.spawn([bin, file], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch (e) {
    throw new FileError(500, `couldn't run ${bin}: ${(e as Error).message}`);
  }
  return file;
}

/** Entries of the given names (relative to root) that git ignores. Empty when root isn't a git repo. */
async function gitIgnored(root: string, rels: string[]): Promise<Set<string>> {
  if (!rels.length) return new Set();
  try {
    const p = Bun.spawn(["git", "check-ignore", "--stdin", "-z"], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    p.stdin.write(rels.join("\0") + "\0");
    p.stdin.end();
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    // 0 = some ignored, 1 = none ignored, 128 = not a repo / error.
    if (code !== 0) return new Set();
    return new Set(out.split("\0").filter(Boolean).map((s) => s.replace(/\/$/, "")));
  } catch {
    return new Set();
  }
}

/** One directory level: folders first, then files, each alphabetical. Hides .git and gitignored entries. */
export async function listDir(root: string, rel: string): Promise<FileEntry[]> {
  const dir = resolveInside(root, rel);
  if (!statSync(dir).isDirectory()) throw new FileError(400, "not a directory");
  const base = relative(realpathSync(root), dir).split(sep).filter(Boolean).join("/");
  const entries: FileEntry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name === ".git") continue;
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        isDir = statSync(join(dir, d.name)).isDirectory();
      } catch {}
    }
    entries.push({ name: d.name, path: base ? `${base}/${d.name}` : d.name, type: isDir ? "dir" : "file" });
  }
  const ignored = await gitIgnored(dir, entries.map((e) => (e.type === "dir" ? `${e.name}/` : e.name)));
  return entries
    .filter((e) => !ignored.has(e.name))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

export interface FileContent {
  path: string;
  size: number;
  /** null when the file is binary or too large to show. */
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
}

export function readFileForView(root: string, rel: string): FileContent {
  const file = resolveInside(root, rel);
  const st = statSync(file);
  if (!st.isFile()) throw new FileError(400, "not a file");
  const out: FileContent = { path: rel, size: st.size, content: null, binary: false, tooLarge: st.size > MAX_VIEW_BYTES };
  if (out.tooLarge) return out;
  const buf = Buffer.alloc(st.size);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, st.size, 0);
  } finally {
    closeSync(fd);
  }
  if (buf.subarray(0, 8192).includes(0)) {
    out.binary = true;
    return out;
  }
  out.content = buf.toString("utf8");
  return out;
}
