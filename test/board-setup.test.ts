// Board: a ticket's copy of the folder (worktree) starts from the remote's latest base, gets the board's files at once,
// and runs the setup command only when its Claude asks (`ckanban ticket setup`).
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { latestBase, run } from "../src/server/git";
import { tempDir, until } from "./helpers";
import { board, readArgs, restartBoard, setup, store, untilSpawned, useBoardEnv } from "./board-env";

useBoardEnv();

const git = (cwd: string, ...args: string[]) => run(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], cwd);
const head = async (cwd: string, ref = "HEAD") => (await run(["git", "rev-parse", ref], cwd)).stdout.trim();
/** The commit a ticket's branch started from (its run may have committed on top). */
const startedFrom = async (wt: string, base: string) => (await run(["git", "merge-base", "HEAD", base], wt)).stdout.trim();

/** Gives the repo an origin (a bare copy), then pushes a commit there from elsewhere: local main is now behind. */
async function behindRemote(repo: string): Promise<string> {
  const bare = join(tempDir("ck-remote-"), "origin.git");
  await run(["git", "clone", "-q", "--bare", repo, bare], repo);
  await git(repo, "remote", "add", "origin", bare);
  await git(repo, "fetch", "-q", "origin");
  const other = join(tempDir("ck-other-"), "clone");
  await run(["git", "clone", "-q", bare, other], repo);
  writeFileSync(join(other, "lock.txt"), "next@16.4\n");
  await git(other, "add", ".");
  await git(other, "commit", "-qm", "bump next");
  await git(other, "push", "-q", "origin", "main");
  return head(other);
}

test("a new copy gets the board's files but no install; the prompt says how to install", async () => {
  const p = await setup();
  writeFileSync(join(p.path, ".gitignore"), ".env\n");
  await git(p.path, "add", "-A");
  await git(p.path, "commit", "-qm", "ignore");
  writeFileSync(join(p.path, ".env"), "SECRET=1\n");
  store.saveProfile({ ...p, copyFiles: [".env", "missing.env"], setupCommand: "echo ran > installed.txt" });
  const t = await board.createTicket("p", { title: "Draft a message", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got).toMatchObject({ status: "review", setupPending: true });
  expect(readFileSync(join(got.worktree!, ".env"), "utf8")).toBe("SECRET=1\n");
  expect(existsSync(join(got.worktree!, "installed.txt"))).toBe(false);
  const prompt = readArgs()[0].prompt;
  expect(prompt).not.toContain("<ckanban-setup>");
  expect(prompt).toContain(`ticket setup p/${t.id}`);
  // A board without a setup command has nothing to say.
  store.saveProfile({ ...store.getProfile("p")!, setupCommand: "" });
  const t2 = await board.createTicket("p", { title: "Other", body: "", status: "ready" });
  await board.whenIdle();
  expect(store.getTicket("p", t2.id)!.setupPending).toBe(true);
  expect(readArgs().at(-1)!.prompt).not.toContain("ticket setup");
});

test("runSetup installs once: calls at the same time share it, later ones are already done", async () => {
  const p = await setup();
  store.saveProfile({ ...p, setupCommand: "sleep 0.3; echo x >> installs.txt; echo deps ok" });
  const t = await board.createTicket("p", { title: "Code", body: "", status: "ready" });
  await board.whenIdle();
  const wt = store.getTicket("p", t.id)!.worktree!;
  const [a, b] = await Promise.all([board.runSetup("p", t.id), board.runSetup("p", t.id)]);
  expect(a).toBe(b);
  expect(a).toMatchObject({ status: "ran", result: { ok: true, command: "sleep 0.3; echo x >> installs.txt; echo deps ok" } });
  if (a.status === "ran") expect(a.result.output).toContain("deps ok");
  expect(readFileSync(join(wt, "installs.txt"), "utf8")).toBe("x\n");
  expect(store.getTicket("p", t.id)).toMatchObject({ setupPending: false, lastActivity: null });
  expect(await board.runSetup("p", t.id)).toEqual({ status: "already-done" });
  // Installed: the next run's prompt no longer asks for it.
  await board.chat("p", t.id, "again");
  await board.whenIdle();
  expect(readArgs().at(-1)!.prompt).not.toContain("ticket setup");
});

test("while it runs the card says it is installing; a failed setup stays pending and can be retried", async () => {
  const p = await setup();
  const gate = join(tempDir("ck-gate-"), "go");
  store.saveProfile({ ...p, setupCommand: `while [ ! -f ${gate} ]; do sleep 0.05; done; echo cannot install; exit 7` });
  const t = await board.createTicket("p", { title: "Code", body: "", status: "ready" });
  await board.whenIdle();
  const pending = board.runSetup("p", t.id);
  await until(() => store.getTicket("p", t.id)!.lastActivity === "Installing project dependencies…");
  writeFileSync(gate, "");
  const r = await pending;
  expect(r).toMatchObject({ status: "ran", result: { ok: false, exitCode: 7 } });
  if (r.status === "ran") expect(r.result.output).toContain("cannot install");
  expect(store.getTicket("p", t.id)).toMatchObject({ setupPending: true, lastActivity: null });
  store.saveProfile({ ...store.getProfile("p")!, setupCommand: "true" });
  expect(await board.runSetup("p", t.id)).toMatchObject({ status: "ran", result: { ok: true } });
});

test("runSetup for a ticket without its own copy of the folder has nothing to do", async () => {
  const p = await setup({ git: false });
  store.saveProfile({ ...p, setupCommand: "echo hi" });
  const t = await board.createTicket("p", { title: "Plain", body: "", status: "ready" });
  await board.whenIdle();
  expect(await board.runSetup("p", t.id)).toEqual({ status: "no-worktree" });
  expect(readArgs()[0].prompt).not.toContain("ticket setup");
});

test("runSetup on a board without a setup command has nothing to do", async () => {
  const p = await setup();
  store.saveProfile({ ...p, setupCommand: "" });
  const t = await board.createTicket("p", { title: "No command", body: "", status: "ready" });
  await board.whenIdle();
  expect(await board.runSetup("p", t.id)).toEqual({ status: "no-command" });
});

test("stopping the ticket aborts a running setup", async () => {
  const p = await setup();
  store.saveProfile({ ...p, setupCommand: "sleep 30" });
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "Code", body: "", status: "ready" });
  await untilSpawned();
  const pending = board.runSetup("p", t.id);
  await until(() => store.getTicket("p", t.id)!.lastActivity === "Installing project dependencies…");
  board.stop("p", t.id);
  const r = await pending;
  expect(r).toMatchObject({ status: "ran", result: { ok: false } });
  expect(store.getTicket("p", t.id)!.setupPending).toBe(true);
}, 15000);

test("planning chats never get the setup note", async () => {
  const p = await setup();
  store.saveProfile({ ...p, setupCommand: "echo hi" });
  const t = await board.createTicket("p", { title: "idea", body: "", status: "planning" });
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.setupPending).toBe(true);
  expect(readArgs()[0].prompt).toContain("help refine");
  expect(readArgs()[0].prompt).not.toContain("ticket setup");
});

test("after a restart a pending setup is still pending; a done one stays done", async () => {
  const p = await setup();
  store.saveProfile({ ...p, setupCommand: "true" });
  const a = await board.createTicket("p", { title: "A", body: "", status: "ready" });
  const b = await board.createTicket("p", { title: "B", body: "", status: "ready" });
  await board.whenIdle();
  await board.runSetup("p", b.id);
  await board.shutdown();
  restartBoard();
  await board.chat("p", a.id, "go on");
  await board.whenIdle();
  expect(readArgs().at(-1)!.prompt).toContain(`ticket setup p/${a.id}`);
  await board.chat("p", b.id, "go on");
  await board.whenIdle();
  expect(readArgs().at(-1)!.prompt).not.toContain("ticket setup");
});

test("a chat on a Done ticket makes the copy again from its own branch, without installing", async () => {
  const p = await setup();
  store.saveProfile({ ...p, setupCommand: "echo x >> installs.txt" });
  const t = await board.createTicket("p", { title: "Shipped", body: "", status: "ready" });
  await board.whenIdle();
  const first = store.getTicket("p", t.id)!;
  await git(first.worktree!, "commit", "-q", "--allow-empty", "-m", "work");
  const tip = await head(first.worktree!);
  await board.updateTicket("p", t.id, { status: "done" });
  expect(existsSync(first.worktree!)).toBe(false);
  await board.chat("p", t.id, "one question");
  await board.whenIdle();
  const again = store.getTicket("p", t.id)!;
  expect(again.worktree).toBe(first.worktree);
  expect(await head(again.worktree!)).toBe(tip);
  expect(existsSync(join(again.worktree!, "installs.txt"))).toBe(false);
  expect(again.setupPending).toBe(true);
});

test("a new copy starts from the remote's latest base; the user's folder is untouched", async () => {
  const p = await setup();
  writeFileSync(join(p.path, "wip.txt"), "uncommitted\n");
  const localHead = await head(p.path);
  const remoteHead = await behindRemote(p.path);
  const t = await board.createTicket("p", { title: "Fix", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("done");
  expect(await startedFrom(got.worktree!, remoteHead)).toBe(remoteHead);
  expect(readFileSync(join(got.worktree!, "lock.txt"), "utf8")).toBe("next@16.4\n");
  // The user's checkout: same commit, same uncommitted work; the board's base branch name is unchanged.
  expect(await head(p.path)).toBe(localHead);
  expect(await head(p.path, "main")).toBe(localHead);
  expect(readFileSync(join(p.path, "wip.txt"), "utf8")).toBe("uncommitted\n");
  expect(store.getProfile("p")!.baseBranch).toBe("main");
  // The ticket's branch doesn't track origin/main, so a plain `git push` isn't refused.
  expect((await run(["git", "rev-parse", "--abbrev-ref", "@{upstream}"], got.worktree!)).code).not.toBe(0);
});

test("an unreachable remote blocks a new ticket with a plain message; a message retries", async () => {
  const p = await setup();
  const bare = join(tempDir("ck-remote-"), "origin.git");
  await run(["git", "clone", "-q", "--bare", p.path, bare], p.path);
  await git(p.path, "remote", "add", "origin", join(tempDir("ck-gone-"), "missing.git"));
  const t = await board.createTicket("p", { title: "Fix", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got).toMatchObject({ status: "review", outcome: "blocked", worktree: null });
  expect(got.error).toContain("Couldn't reach the online copy of your project");
  expect(readArgs().length).toBe(0);
  await git(p.path, "remote", "set-url", "origin", bare);
  await board.chat("p", t.id, "try again");
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.outcome).toBe("done");
  expect(existsSync(store.getTicket("p", t.id)!.worktree!)).toBe(true);
});

test("a remote without the base branch falls back to the local one", async () => {
  const p = await setup();
  const bare = join(tempDir("ck-remote-"), "origin.git");
  await run(["git", "init", "-q", "--bare", bare], p.path);
  await git(p.path, "remote", "add", "origin", bare);
  const t = await board.createTicket("p", { title: "Fix", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("done");
  expect(await startedFrom(got.worktree!, "main")).toBe(await head(p.path));
});

test("a repo without a remote branches from the local base as before", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "Local", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("done");
  expect(await startedFrom(got.worktree!, "main")).toBe(await head(p.path));
});

test("tickets starting together share one fetch of the base branch", async () => {
  const p = await setup();
  const remoteHead = await behindRemote(p.path);
  const a = latestBase(p.path, "main");
  const b = latestBase(p.path, "main");
  expect(a).toBe(b);
  expect(await a).toBe("origin/main");
  expect(await head(p.path, "origin/main")).toBe(remoteHead);
});
