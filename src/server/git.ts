import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Profile } from "./types";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string[], cwd: string, env?: Record<string, string>): Promise<RunResult> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: env ? { ...process.env, ...env } : undefined });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
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

export async function addWorktree(repo: string, dir: string, branch: string, base: string): Promise<void> {
  mkdirSync(dirname(dir), { recursive: true });
  const exists = await branchExists(repo, branch);
  const args = exists ? ["git", "worktree", "add", dir, branch] : ["git", "worktree", "add", "-b", branch, dir, base];
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
