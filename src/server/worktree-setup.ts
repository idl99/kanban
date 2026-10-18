import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { isGitRepo, run } from "./git";
import type { Store } from "./store";
import type { Profile, SetupDetection } from "./types";

/**
 * Worktree setup: a fresh git worktree lacks git-ignored files (.env, node_modules). The board copies the board's
 * copyFiles from the main checkout when it makes the worktree, and runs its setupCommand there only when the ticket's
 * Claude asks for it (`ckanban ticket setup`), so tickets that never build or test don't wait for an install. Both are
 * auto-detected.
 */

export const SETUP_TIMEOUT_MS = 10 * 60_000;
export const CLEANUP_TIMEOUT_MS = 2 * 60_000;
/** Output lines kept for the prompt and the chat row. */
export const SETUP_TAIL_LINES = 40;

/** Folders never scanned for lockfiles or .env files: dependencies, build output, caches. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage", "tmp", "__pycache__"]);

/** Per ecosystem, the first lockfile found in a folder decides its install command. */
const LOCKFILES: { file: string; command: string }[][] = [
  [
    { file: "bun.lock", command: "bun install" },
    { file: "bun.lockb", command: "bun install" },
    { file: "pnpm-lock.yaml", command: "pnpm install" },
    { file: "yarn.lock", command: "yarn install" },
    { file: "package-lock.json", command: "npm ci" },
  ],
  [
    { file: "uv.lock", command: "uv sync" },
    { file: "poetry.lock", command: "poetry install" },
  ],
  [{ file: "Gemfile.lock", command: "bundle install" }],
];

const shQuote = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The root ("") and its first-level subfolders worth scanning, sorted. */
function scanDirs(root: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name))
      .map((d) => d.name)
      .sort();
  } catch {}
  return ["", ...names];
}

function files(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

/** Which of these repo-relative paths git ignores (folders end in "/"). */
async function ignored(repo: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const r = await run(["git", "check-ignore", "--", ...paths], repo);
  // Exit 1: none ignored; 128: not a repo.
  return new Set(r.code === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : []);
}

/** Which of these repo-relative file paths git tracks. */
async function trackedFiles(repo: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const r = await run(["git", "ls-files", "--", ...paths], repo);
  return new Set(r.code === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : []);
}

/** Looks at the folder: git-ignored .env* files to copy and lockfiles that say how to install dependencies. */
export async function detectSetup(repo: string): Promise<SetupDetection> {
  const at = new Date().toISOString();
  // Only git boards get worktrees, so only they need setup.
  if (!(await isGitRepo(repo))) return { at, copyFiles: [], setupCommand: "", setupFrom: [] };
  const all = scanDirs(repo);
  const dirIgnored = await ignored(repo, all.filter(Boolean).map((d) => `${d}/`));
  const dirs = all.filter((d) => !d || (!dirIgnored.has(`${d}/`) && !dirIgnored.has(d)));

  const envs = dirs.flatMap((d) => files(join(repo, d)).filter((f) => /^\.env/.test(f)).map((f) => (d ? `${d}/${f}` : f)));
  const ignoredEnvs = await ignored(repo, envs);
  const copyFiles = envs.filter((f) => ignoredEnvs.has(f));

  // Only lockfiles in version history: a ticket's copy has no untracked folders, so a command for one would fail.
  const candidates = dirs.flatMap((d) => files(join(repo, d)).filter((f) => LOCKFILES.some((g) => g.some((l) => l.file === f))).map((f) => (d ? `${d}/${f}` : f)));
  const tracked = await trackedFiles(repo, candidates);
  const commands: string[] = [];
  const setupFrom: string[] = [];
  for (const d of dirs) {
    const present = new Set(files(join(repo, d)).filter((f) => tracked.has(d ? `${d}/${f}` : f)));
    for (const group of LOCKFILES) {
      const hit = group.find((l) => present.has(l.file));
      if (!hit) continue;
      commands.push(d ? `(cd ${shQuote(d)} && ${hit.command})` : hit.command);
      setupFrom.push(d ? `${d}/${hit.file}` : hit.file);
    }
  }
  return { at, copyFiles, setupCommand: commands.join(" && "), setupFrom };
}

/** Profile fields detection fills in: only those never set, so the user's own values stay. */
export function applyDetection(p: Profile, d: SetupDetection, overwrite = false): Profile {
  return {
    ...p,
    copyFiles: overwrite || p.copyFiles === undefined ? d.copyFiles : p.copyFiles,
    setupCommand: overwrite || p.setupCommand === undefined ? d.setupCommand : p.setupCommand,
    setupDetected: d,
  };
}

/**
 * On daemon start: boards made before worktree setup existed are detected once, keeping any values already set. A
 * setup command still equal to an earlier guess (the user never edited it) is guessed again, so a fixed guess (only
 * folders in version history) reaches boards that have one; a command the user edited stays.
 */
export async function detectMissing(store: Store, onUpdated: (p: Profile) => void): Promise<void> {
  for (const p of store.listProfiles()) {
    const guessed = !!p.setupDetected && p.setupCommand === p.setupDetected.setupCommand;
    if ((p.setupDetected !== undefined && !guessed) || !existsSync(p.path)) continue;
    try {
      const d = await detectSetup(p.path);
      const now = store.getProfile(p.slug);
      if (!now) continue;
      let next: Profile;
      if (now.setupDetected === undefined) next = applyDetection(now, d);
      else if (now.setupDetected && now.setupCommand === now.setupDetected.setupCommand && d.setupCommand !== now.setupCommand) {
        next = { ...now, setupCommand: d.setupCommand, setupDetected: { ...now.setupDetected, at: d.at, setupCommand: d.setupCommand, setupFrom: d.setupFrom } };
      } else continue;
      store.saveProfile(next);
      onUpdated(next);
    } catch (e) {
      console.error(`profile ${p.slug}: worktree setup detection failed: ${(e as Error).message}`);
    }
  }
}

const GLOB = /[*?[\]{}]/;

/** Repo-relative path that stays inside the repo, or null. */
function inside(p: string): string | null {
  const n = normalize(p.trim()).replace(/\/+$/, "");
  if (!n || n === "." || isAbsolute(n) || n === ".." || n.startsWith(`..${sep}`)) return null;
  return n;
}

/**
 * Copies files (paths or globs relative to `from`) to the same place under `to`. Missing ones are skipped, files
 * already in the worktree (tracked ones) are left alone.
 */
export function copySetupFiles(from: string, to: string, patterns: string[]): { copied: string[]; missing: string[] } {
  const copied: string[] = [];
  const missing: string[] = [];
  for (const raw of patterns) {
    const pattern = inside(raw);
    if (!pattern) continue;
    let matches: string[];
    if (GLOB.test(pattern)) {
      try {
        matches = [...new Bun.Glob(pattern).scanSync({ cwd: from, dot: true, onlyFiles: true })].map((m) => inside(m)).filter((m): m is string => !!m);
      } catch {
        matches = [];
      }
    } else {
      matches = existsSync(join(from, pattern)) && statSync(join(from, pattern)).isFile() ? [pattern] : [];
    }
    if (!matches.length) {
      missing.push(raw.trim());
      continue;
    }
    for (const m of matches.sort()) {
      const dest = join(to, m);
      if (existsSync(dest) || copied.includes(m)) continue;
      try {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(from, m), dest);
        copied.push(m);
      } catch {
        missing.push(m);
      }
    }
  }
  return { copied, missing };
}

export interface ShellResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Last lines of stdout + stderr, interleaved. */
  output: string;
  durationMs: number;
}

const MAX_OUTPUT = 64 * 1024;

/** The user's login shell (so PATH matches their terminal even under launchd). */
export function userShell(): string {
  const s = process.env.SHELL;
  return s && existsSync(s) ? s : existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
}

export function tailLines(text: string, n = SETUP_TAIL_LINES): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(-n).join("\n");
}

/** Runs a command in `cwd` via the user's shell; killed (with its children) after the timeout or on abort. */
export async function runShell(
  cwd: string,
  command: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; shell?: string; env?: Record<string, string> } = {},
): Promise<ShellResult> {
  const started = Date.now();
  let buf = "";
  let timedOut = false;
  const append = (s: string) => {
    buf += s;
    if (buf.length > MAX_OUTPUT * 2) buf = buf.slice(-MAX_OUTPUT);
  };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([opts.shell ?? userShell(), "-lc", command], {
      cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
      env: { ...process.env, ...opts.env },
    } as any);
  } catch (e) {
    return { ok: false, exitCode: null, timedOut: false, output: (e as Error).message, durationMs: Date.now() - started };
  }
  const kill = () => {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      proc.kill();
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs ?? SETUP_TIMEOUT_MS);
  const onAbort = () => kill();
  opts.signal?.addEventListener("abort", onAbort);
  if (opts.signal?.aborted) kill();
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of s) append(dec.decode(chunk, { stream: true }));
  };
  await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]).catch(() => {});
  const code = await proc.exited;
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);
  if (timedOut) append(`\n(timed out after ${Math.round((opts.timeoutMs ?? SETUP_TIMEOUT_MS) / 1000)}s)`);
  else if (opts.signal?.aborted) append("\n(stopped)");
  return { ok: code === 0 && !timedOut, exitCode: proc.signalCode ? null : code, timedOut, output: tailLines(buf.slice(-MAX_OUTPUT), 400), durationMs: Date.now() - started };
}

/** What preparing a new worktree did; shown as one row in the ticket chat and told to Claude. */
export interface SetupResult {
  copied: string[];
  missing: string[];
  command: string;
  /** Null when there was no command to run. */
  ok: boolean | null;
  exitCode: number | null;
  timedOut: boolean;
  /** Last SETUP_TAIL_LINES lines of the command's output. */
  output: string;
  durationMs: number;
}

/** Copies the board's files into a new worktree, then runs its setup command there. Never throws. */
export async function prepareWorktree(
  repo: string,
  dir: string,
  profile: Pick<Profile, "copyFiles" | "setupCommand">,
  opts: { timeoutMs?: number; signal?: AbortSignal; shell?: string; env?: Record<string, string> } = {},
): Promise<SetupResult | null> {
  const patterns = profile.copyFiles ?? [];
  const command = (profile.setupCommand ?? "").trim();
  if (!patterns.length && !command) return null;
  const started = Date.now();
  const { copied, missing } = copySetupFiles(repo, dir, patterns);
  if (!command) return { copied, missing, command, ok: null, exitCode: null, timedOut: false, output: "", durationMs: Date.now() - started };
  const r = await runShell(dir, command, opts);
  return { copied, missing, command, ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, output: tailLines(r.output), durationMs: Date.now() - started };
}

const SETUP_TAG = "ckanban-setup";
export const SETUP_BLOCK_RE = /<ckanban-setup>([\s\S]*?)<\/ckanban-setup>/;

/** The setup result as a block (ends `ckanban ticket setup`'s output): the data the chat's setup row is drawn from. */
export function setupBlock(r: SetupResult): string {
  // "<" escaped so command output can't close the tag early.
  const json = JSON.stringify(r).replace(/</g, "\\u003c");
  return `<${SETUP_TAG}>${json}</${SETUP_TAG}>`;
}

/** Adds board text to a prompt inside its board instructions (or new ones), so the chat doesn't show it as typed. */
export function withBoardText(prompt: string, text: string, note: string): string {
  return prompt.includes("<ckanban-context")
    ? `${prompt}\n\n${text}`
    : `${prompt}\n\n<ckanban-context note="${note}">\n${text}\n</ckanban-context>`;
}

/** What `ckanban ticket setup` got back from the daemon. */
export type SetupOutcome = { status: "ran"; result: SetupResult } | { status: "already-done" | "no-command" | "no-worktree" };

export function parseSetupBlock(text: string): SetupResult | null {
  const m = SETUP_BLOCK_RE.exec(text);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    if (!v || typeof v !== "object" || typeof v.command !== "string") return null;
    return {
      copied: Array.isArray(v.copied) ? v.copied.map(String) : [],
      missing: Array.isArray(v.missing) ? v.missing.map(String) : [],
      command: v.command,
      ok: typeof v.ok === "boolean" ? v.ok : null,
      exitCode: typeof v.exitCode === "number" ? v.exitCode : null,
      timedOut: !!v.timedOut,
      output: typeof v.output === "string" ? v.output : "",
      durationMs: typeof v.durationMs === "number" ? v.durationMs : 0,
    };
  } catch {
    return null;
  }
}
