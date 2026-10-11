import { beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { makeRepo } from "./helpers";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, detectBaseBranch, enableVersionHistory, isGitRepo, removeWorktree, repoKind, resolveBaseBranch, run, SNAPSHOT_MAX_BYTES, worktreeDir } from "../src/server/git";
import { tempDir } from "./helpers";

let repo: string;

beforeAll(async () => {
  repo = await makeRepo();
});

test("isGitRepo", async () => {
  expect(await isGitRepo(repo)).toBe(true);
  expect(await isGitRepo(mkdtempSync(join(tmpdir(), "ck-plain-")))).toBe(false);
});

test("detectBaseBranch", async () => {
  expect(await detectBaseBranch(repo)).toBe("main");
});

test("worktreeDir location", () => {
  const d = worktreeDir({ path: "/a/b/repo", slug: "p" } as any, "t_1");
  expect(d).toBe("/a/b/.ckanban-worktrees/p/t_1");
});

test("add and remove clean worktree", async () => {
  const dir = join(repo + "-wt", "t1");
  await addWorktree(repo, dir, "ck/t1-x", "main");
  expect(existsSync(join(dir, "README.md"))).toBe(true);
  const r = await run(["git", "branch", "--show-current"], dir);
  expect(r.stdout.trim()).toBe("ck/t1-x");
  expect(await removeWorktree(repo, dir)).toEqual({ removed: true });
  expect(existsSync(dir)).toBe(false);
});

test("dirty worktree not removed", async () => {
  const dir = join(repo + "-wt", "t2");
  await addWorktree(repo, dir, "ck/t2-x", "main");
  writeFileSync(join(dir, "new.txt"), "x");
  const r = await removeWorktree(repo, dir);
  expect(r.removed).toBe(false);
  expect(existsSync(dir)).toBe(true);
});

test("addWorktree failure throws with stderr", async () => {
  await expect(addWorktree(repo, join(repo + "-wt", "t3"), "ck/t3", "nope-branch")).rejects.toThrow();
});

test("resolveBaseBranch keeps a valid branch", async () => {
  expect(await resolveBaseBranch(repo, "main")).toBe("main");
});

test("resolveBaseBranch replaces a missing branch with the detected one", async () => {
  expect(await resolveBaseBranch(repo, "nope-branch")).toBe("main");
  expect(await resolveBaseBranch(repo, "")).toBe("main");
});

test("resolveBaseBranch falls back to master", async () => {
  const r = await makeRepo();
  await run(["git", "branch", "-m", "main", "master"], r);
  expect(await resolveBaseBranch(r, "main")).toBe("master");
});

test("resolveBaseBranch is null for a repo with no commits", async () => {
  const r = tempDir("ck-empty-");
  await run(["git", "init", "-q", "-b", "main"], r);
  expect(await resolveBaseBranch(r, "main")).toBeNull();
});

test("addWorktree failure explains itself", async () => {
  await expect(addWorktree(repo, join(repo + "-wt", "t4"), "ck/t4", "nope-branch")).rejects.toThrow(/Could not create an isolated git worktree[\s\S]*git worktree add failed/);
});

test("repoKind and enableVersionHistory: plain folder, repo with no commits, existing repo", async () => {
  const plain = tempDir("ck-plain-");
  expect(await repoKind(plain)).toBe("plain");
  writeFileSync(join(plain, "notes.txt"), "hi\n");
  writeFileSync(join(plain, "debug.log"), "x\n");
  // Over 50 MB: left out of the snapshot and listed by path in the new .gitignore (sparse, so it's quick).
  const big = Bun.file(join(plain, "video.mov"));
  await Bun.write(big, "");
  await run(["truncate", "-s", String(SNAPSHOT_MAX_BYTES + 1), join(plain, "video.mov")], plain);
  const r = await enableVersionHistory(plain);
  expect(r.changed).toBe(true);
  expect(r.ignored).toEqual(["video.mov"]);
  const ignore = readFileSync(join(plain, ".gitignore"), "utf8");
  for (const line of [".env*", "node_modules/", ".DS_Store", "*.log", "/video.mov"]) expect(ignore).toContain(line);
  expect((await run(["git", "ls-files"], plain)).stdout.trim().split("\n").sort()).toEqual([".gitignore", "notes.txt"]);
  expect(await repoKind(plain)).toBe("local");

  // A repo with no commits keeps its own .gitignore; it isn't re-initialised.
  const empty = tempDir("ck-empty-");
  await run(["git", "init", "-q", "-b", "trunk"], empty);
  writeFileSync(join(empty, ".gitignore"), "secret.txt\n");
  writeFileSync(join(empty, "secret.txt"), "s\n");
  writeFileSync(join(empty, "a.txt"), "a\n");
  expect(await repoKind(empty)).toBe("empty");
  expect((await enableVersionHistory(empty)).changed).toBe(true);
  expect(readFileSync(join(empty, ".gitignore"), "utf8")).toBe("secret.txt\n");
  expect((await run(["git", "branch", "--show-current"], empty)).stdout.trim()).toBe("trunk");
  expect((await run(["git", "ls-files"], empty)).stdout.trim().split("\n").sort()).toEqual([".gitignore", "a.txt"]);

  // An existing repo is left alone.
  const head = (await run(["git", "rev-parse", "HEAD"], repo)).stdout.trim();
  expect(await enableVersionHistory(repo)).toEqual({ changed: false, sha: head, ignored: [] });
  expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  await run(["git", "remote", "add", "origin", "https://example.com/x.git"], repo);
  expect(await repoKind(repo)).toBe("remote");
  await run(["git", "remote", "remove", "origin"], repo);
});

test("enableVersionHistory: a folder inside an outer repo with no commits gets its own; home and disk are refused", async () => {
  const outer = tempDir("ck-outer-");
  await run(["git", "init", "-q"], outer);
  writeFileSync(join(outer, "secret-outside.txt"), "s\n");
  mkdirSync(join(outer, "proj"));
  writeFileSync(join(outer, "proj", "a.txt"), "a\n");
  // Staged in the outer repo already: must not leak into the project's snapshot.
  await run(["git", "add", "."], outer);
  expect((await enableVersionHistory(join(outer, "proj"))).changed).toBe(true);
  expect((await run(["git", "ls-files"], join(outer, "proj"))).stdout.trim().split("\n").sort()).toEqual([".gitignore", "a.txt"]);
  expect(existsSync(join(outer, "proj", ".git"))).toBe(true);
  await expect(enableVersionHistory(homedir())).rejects.toThrow("whole home folder");
  await expect(enableVersionHistory("/")).rejects.toThrow("whole home folder");
});
