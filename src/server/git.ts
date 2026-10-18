import { appendFileSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Profile } from "./types";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** timeoutMs: the command is killed after that long and fails (code -1, "timed out" in stderr). */
export async function run(cmd: string[], cwd: string, env?: Record<string, string>, timeoutMs?: number): Promise<RunResult> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: env ? { ...process.env, ...env } : undefined });
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      p.kill();
    }, timeoutMs) : null;
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]).finally(() => timer && clearTimeout(timer));
    if (timedOut) return { code: -1, stdout, stderr: `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}timed out after ${Math.round(timeoutMs! / 1000)}s` };
    return { code, stdout, stderr };
  } catch (e) {
    return { code: -1, stdout: "", stderr: (e as Error).message };
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const r = await run(["git", "rev-parse", "--is-inside-work-tree"], path);
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function detectBaseBranch(path: string): Promise<string> {
  const origin = await run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], path);
  if (origin.code === 0 && origin.stdout.trim()) return origin.stdout.trim().replace(/^origin\//, "");
  const cur = await run(["git", "branch", "--show-current"], path);
  if (cur.code === 0 && cur.stdout.trim()) return cur.stdout.trim();
  return "main";
}

async function isCommit(repo: string, ref: string): Promise<boolean> {
  if (!ref) return false;
  return (await run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo)).code === 0;
}

/** False in a fresh `git init` with no commits yet: HEAD names a branch that doesn't exist. */
export async function hasCommits(dir: string): Promise<boolean> {
  return isCommit(dir, "HEAD");
}

/**
 * The ref new worktrees branch from: the saved base branch if it still points at a commit, else the
 * first of the detected default branch, its origin/ copy, main, master or HEAD that does.
 * Null when the repo has no commits yet (fresh `git init`), so no worktree can be made.
 */
export async function resolveBaseBranch(repo: string, saved: string): Promise<string | null> {
  if (await isCommit(repo, saved)) return saved;
  const detected = await detectBaseBranch(repo);
  for (const ref of [detected, `origin/${detected}`, "main", "master", "HEAD"]) {
    if (ref !== saved && (await isCommit(repo, ref))) return ref;
  }
  return null;
}

export function worktreeDir(profile: Pick<Profile, "path" | "slug">, id: string): string {
  return join(dirname(profile.path), ".ckanban-worktrees", profile.slug, id);
}

/**
 * Prefix for ckanban's own git commands that check out files: the project's hooks (e.g. husky's post-checkout) are for
 * the user's checkouts, and in a fresh worktree they often fail on git-ignored files, failing a checkout that worked.
 */
export const NO_HOOKS = ["git", "-c", "core.hooksPath=/dev/null"];

export const FETCH_TIMEOUT_MS = 30_000;

export class FetchError extends Error {}

/**
 * Brings origin's copy of the base branch up to date and returns the ref new ticket branches start from:
 * `origin/<base>`, so a new ticket gets work other tickets already pushed even when the user's local base branch is
 * behind. Only remote-tracking refs change: never the user's checkout or local branches. Falls back to the local
 * base when origin has no such branch. Throws FetchError when origin can't be reached (offline, signed out).
 */
export function latestBase(repo: string, base: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  // Tickets starting together share one fetch: parallel fetches of the same ref fail on git's ref lock.
  const key = `${repo}\0${base}`;
  const running = fetches.get(key);
  if (running) return running;
  const p = fetchBase(repo, base, timeoutMs).finally(() => fetches.delete(key));
  fetches.set(key, p);
  return p;
}

const fetches = new Map<string, Promise<string>>();

async function fetchBase(repo: string, base: string, timeoutMs: number): Promise<string> {
  const name = base.replace(/^origin\//, "");
  if (name === "HEAD") return base;
  // No password prompts or ssh questions: a run has nobody to answer them, so they'd hang until the timeout.
  // The user's own ssh command (env or core.sshCommand, e.g. a custom key) wins: overriding it would break the fetch.
  const ownSsh = !!process.env.GIT_SSH_COMMAND || (await run(["git", "config", "--get", "core.sshCommand"], repo)).stdout.trim() !== "";
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", ...(ownSsh ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }) };
  const cmd = [...NO_HOOKS, "fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${name}:refs/remotes/origin/${name}`];
  let r = await run(cmd, repo, env, timeoutMs);
  // Someone else (the user, an editor) fetching at the same moment holds the ref lock: once more, then judge.
  if (r.code !== 0 && /cannot lock ref|\.lock'?: File exists/i.test(r.stderr)) {
    await Bun.sleep(500);
    r = await run(cmd, repo, env, timeoutMs);
  }
  if (r.code !== 0) {
    if (/couldn't find remote ref/i.test(r.stderr)) return base;
    const last = r.stderr.trim().split("\n").filter(Boolean).at(-1) ?? `git fetch exited with ${r.code}`;
    throw new FetchError(
      `Couldn't reach the online copy of your project to get its latest version (offline or signed out?). Check your connection or sign in, then send a message to retry.\n\n${last}`,
    );
  }
  return (await isCommit(repo, `origin/${name}`)) ? `origin/${name}` : base;
}

export async function addWorktree(repo: string, dir: string, branch: string, base: string): Promise<void> {
  mkdirSync(dirname(dir), { recursive: true });
  const exists = await branchExists(repo, branch);
  // --no-track: a branch made from origin/<base> would otherwise track it, and a plain `git push` would then refuse.
  const args = exists ? [...NO_HOOKS, "worktree", "add", dir, branch] : [...NO_HOOKS, "worktree", "add", "--no-track", "-b", branch, dir, base];
  const r = await run(args, repo);
  if (r.code !== 0) {
    throw new Error(`Could not create an isolated git worktree for this ticket from "${base}". Check the board's base branch in its settings, then send a message to retry.\n\ngit worktree add failed: ${r.stderr.trim()}`);
  }
}

/** beforeRemove runs once the worktree is known to be removable (the board's cleanup command); it must not throw. */
export async function removeWorktree(repo: string, dir: string, beforeRemove?: () => Promise<void>): Promise<{ removed: boolean; reason?: string }> {
  if (!existsSync(dir)) return { removed: true };
  const status = await run(["git", "status", "--porcelain"], dir);
  if (status.code !== 0) return { removed: false, reason: status.stderr.trim() };
  if (status.stdout.trim()) return { removed: false, reason: "worktree has uncommitted changes" };
  await beforeRemove?.().catch(() => {});
  const r = await run(["git", "worktree", "remove", dir], repo);
  if (r.code !== 0) return { removed: false, reason: r.stderr.trim() };
  return { removed: true };
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0;
}

/** Local branches starting with prefix, most recently committed first. */
export async function branchesWithPrefix(repo: string, prefix: string): Promise<string[]> {
  const r = await run(["git", "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/"], repo);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter((b) => b.startsWith(prefix));
}

/** Paths of the repo's linked worktrees (after pruning registrations whose folder is gone). */
export async function listWorktrees(repo: string): Promise<string[]> {
  await run(["git", "worktree", "prune"], repo);
  const r = await run(["git", "worktree", "list", "--porcelain"], repo);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length)).slice(1);
}

export async function which(bin: string): Promise<boolean> {
  return Bun.which(bin) !== null;
}

/**
 * A folder's version history as runs see it: no git at all, a git repo with no commits yet, one with commits but no
 * `origin` remote, or one with a remote. Only the last can push or open a pull request.
 */
export type RepoKind = "plain" | "empty" | "local" | "remote";

export async function repoKind(path: string): Promise<RepoKind> {
  if (!(await isGitRepo(path))) return "plain";
  if (!(await hasCommits(path))) return "empty";
  return (await run(["git", "remote", "get-url", "origin"], path)).code === 0 ? "remote" : "local";
}

/** Files bigger than this stay out of the first snapshot (listed in the ignore file by path). */
export const SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;

const SNAPSHOT_IGNORE = [
  "# Written by ckanban when version history was turned on. Edit freely.",
  ".env*", "node_modules/", ".DS_Store", "*.log",
  "dist/", "build/", "out/", ".next/", ".nuxt/", ".cache/", "coverage/", "target/", "__pycache__/", ".venv/", "venv/",
];

export const SNAPSHOT_MESSAGE = "Initial snapshot (ckanban)";

/**
 * Turns on version history for a folder: `git init` (unless it is a repo already), a .gitignore when it has none,
 * a local identity only when git has none, then one commit of everything. Never pushes. A repo that already has
 * commits is left alone (changed: false).
 */
export async function enableVersionHistory(dir: string): Promise<{ changed: boolean; sha: string | null; ignored: string[] }> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`This folder doesn't exist: ${dir}`);
  const real = realpathSync(dir);
  // A whole home folder or disk would sweep up every private file (keys, mail, other projects) into one snapshot.
  if (real === "/" || real === realpathSync(homedir()) || dirname(real) === "/") {
    throw new Error("Choose a project folder: version history can't be turned on for your whole home folder or disk.");
  }
  const must = async (cmd: string[]) => {
    const r = await run(cmd, dir);
    if (r.code !== 0) throw new Error(`${cmd.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout;
  };
  // Only a repo rooted at this folder is used as is; inside an outer repo with no commits, the folder gets its own
  // (else `git add -A` would snapshot the outer repo's other files too).
  const top = (await run(["git", "rev-parse", "--show-toplevel"], dir)).stdout.trim();
  const own = !!top && realpathSync(top) === real;
  if (top && (await hasCommits(dir))) return { changed: false, sha: (await must(["git", "rev-parse", "HEAD"])).trim(), ignored: [] };
  if (!own) await must(["git", "init", "-q"]);
  const gitignore = join(dir, ".gitignore");
  const fresh = !existsSync(gitignore);
  if (fresh) writeFileSync(gitignore, `${SNAPSHOT_IGNORE.join("\n")}\n`);
  // Big files (videos, exports, archives) would bloat the history: listed by path, in .gitignore when ckanban wrote
  // it, else in the repo's own exclude file so the user's .gitignore stays untouched.
  const untracked = (await must(["git", "ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
  // Files already staged in a repo with no commits count too; they are unstaged below so the ignore list applies.
  const staged = (await must(["git", "diff", "-z", "--cached", "--name-only"])).split("\0").filter(Boolean);
  const big = [...untracked, ...staged].filter((f) => {
    try {
      return statSync(join(dir, f)).size > SNAPSHOT_MAX_BYTES;
    } catch {
      return false;
    }
  });
  if (big.length) {
    const lines = `\n# Files over 50 MB, kept out of version history\n${big.map((f) => `/${f.replace(/([*?[\]\\#! ])/g, "\\$1")}`).join("\n")}\n`;
    const target = fresh ? gitignore : join((await must(["git", "rev-parse", "--absolute-git-dir"])).trim(), "info", "exclude");
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, lines);
    const stagedBig = big.filter((f) => staged.includes(f));
    if (stagedBig.length) await must(["git", "rm", "-q", "--cached", "--", ...stagedBig]);
  }
  for (const [key, value] of [["user.name", "ckanban"], ["user.email", "ckanban@localhost"]]) {
    if (!(await run(["git", "config", key], dir)).stdout.trim()) await must(["git", "config", key, value]);
  }
  await must(["git", "add", "-A"]);
  // No signing: a passphrase prompt would hang the request.
  await must(["git", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--no-verify", "-m", SNAPSHOT_MESSAGE]);
  return { changed: true, sha: (await must(["git", "rev-parse", "HEAD"])).trim(), ignored: big };
}
