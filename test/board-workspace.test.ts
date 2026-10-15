// Board workspaces: in-folder vs worktree runs, reopening, sweeping worktrees.
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, worktreeDir } from "../src/server/git";
import { tempDir } from "./helpers";
import { store, bus, board, setup, readArgs, untilSpawned, useBoardEnv } from "./board-env";

useBoardEnv();

test("tickets that edit the folder in place run one at a time; a waiting card says why", async () => {
  await setup({ git: false, maxParallel: 3 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  await untilSpawned();
  await Bun.sleep(300);
  expect(board.isRunning("p", a.id)).toBe(true);
  expect(board.isRunning("p", b.id)).toBe(false);
  expect(board.folderWait("p", store.getTicket("p", b.id)!)).toBe(true);
  expect(board.folderWait("p", store.getTicket("p", a.id)!)).toBe(false);
  process.env.FAKE_MODE = "ok";
  board.stop("p", a.id);
  await board.whenIdle();
  expect(store.getTicket("p", b.id)!.outcome).toBe("done");
  const calls = readArgs();
  expect(calls.length).toBe(2);
  expect(calls[1].cwd).toBe(calls[0].cwd);
}, 20000);

test("a reply that would edit the folder while another ticket does waits for it", async () => {
  await setup({ git: false, maxParallel: 3 });
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  await board.whenIdle();
  process.env.FAKE_MODE = "slow";
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  await untilSpawned();
  expect(board.isRunning("p", b.id)).toBe(true);
  const waiting = await board.chat("p", a.id, "one more change");
  expect(board.isRunning("p", a.id)).toBe(false);
  expect(waiting.lastActivity).toBe("waiting: another ticket is using the folder");
  expect(board.folderWait("p", waiting)).toBe(true);
  process.env.FAKE_MODE = "ok";
  board.stop("p", b.id);
  await board.whenIdle();
  expect(readArgs().at(-1)!.prompt).toContain("one more change");
}, 20000);

test("a reply to another session (a huddle) also waits for the folder, without moving the card", async () => {
  await setup({ git: false, maxParallel: 3 });
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  await board.whenIdle();
  process.env.FAKE_MODE = "slow";
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  await untilSpawned();
  expect(board.isRunning("p", b.id)).toBe(true);
  const waiting = await board.chat("p", a.id, "message from a huddle", { peer: true });
  expect(board.isRunning("p", a.id)).toBe(false);
  expect(waiting.status).toBe("review");
  expect(board.folderWait("p", waiting)).toBe(true);
  process.env.FAKE_MODE = "ok";
  board.stop("p", b.id);
  await board.whenIdle();
  expect(readArgs().at(-1)!.prompt).toContain("message from a huddle");
  expect(store.getTicket("p", a.id)!.status).toBe("review");
  expect(store.getTicket("p", a.id)!.slotWait ?? null).toBeNull();
}, 20000);

test("a board with no Workspace setting gives each ticket a worktree", async () => {
  const p = await setup();
  expect(p.workspace).toBeUndefined();
  const t = await board.createTicket("p", { title: "Default", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBe(worktreeDir(p, t.id));
  expect(got.branch).toStartWith(`ck/${t.id}-`);
  expect(readArgs()[0].cwd).toBe(got.worktree!);
});

test("Work in the project folder: no worktree or branch, the folder's HEAD is recorded, no branch or PR instructions", async () => {
  const p = await setup();
  store.saveProfile({ ...p, workspace: "folder" });
  const head = (await run(["git", "rev-parse", "HEAD"], p.path)).stdout.trim();
  const t = await board.createTicket("p", { title: "In folder", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBeNull();
  expect(got.branch).toBeNull();
  expect(got.baseSha).toBe(head);
  expect(existsSync(worktreeDir(p, t.id))).toBe(false);
  expect((await run(["git", "branch", "--list", "ck/*"], p.path)).stdout.trim()).toBe("");
  const { cwd, prompt } = readArgs()[0];
  expect(cwd).toBe(p.path);
  expect(prompt).toContain("Don't create or switch branches");
  expect(prompt).toContain("to the current branch");
  expect(prompt).toContain("uncommitted changes you didn't make");
  expect(prompt).not.toContain("gh pr create");
  expect(prompt).not.toContain("push the branch");
  expect(prompt).not.toContain("feature branch");
  expect(prompt).not.toContain("merge --no-edit");
});

test("Work in the project folder runs tickets one at a time", async () => {
  const p = await setup({ maxParallel: 3 });
  store.saveProfile({ ...p, workspace: "folder" });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  await untilSpawned();
  await Bun.sleep(300);
  expect(board.isRunning("p", a.id)).toBe(true);
  expect(board.isRunning("p", b.id)).toBe(false);
  expect(board.folderWait("p", store.getTicket("p", b.id)!)).toBe(true);
  process.env.FAKE_MODE = "ok";
  board.stop("p", a.id);
  await board.whenIdle();
  expect(store.getTicket("p", b.id)!.outcome).toBe("done");
  expect(readArgs().map((c) => c.cwd)).toEqual([p.path, p.path]);
}, 20000);

test("switching Workspace affects new tickets only: existing worktrees stay, switching back brings worktrees back", async () => {
  const p = await setup({ maxParallel: 3 });
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  await board.whenIdle();
  const wt = store.getTicket("p", a.id)!.worktree!;
  expect(wt).toBe(worktreeDir(p, a.id));
  store.saveProfile({ ...p, workspace: "folder" });
  // The worktree ticket isn't one that edits the folder, so it doesn't hold folder tickets back.
  expect(board.runsInFolder("p", store.getTicket("p", a.id)!)).toBe(false);
  await board.chat("p", a.id, "one more change");
  await board.whenIdle();
  expect(readArgs().at(-1)!.cwd).toBe(wt);
  expect(store.getTicket("p", a.id)!.worktree).toBe(wt);
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  await board.whenIdle();
  expect(store.getTicket("p", b.id)!.worktree).toBeNull();
  expect(readArgs().at(-1)!.cwd).toBe(p.path);
  store.saveProfile({ ...p, workspace: "worktree" });
  const c = await board.createTicket("p", { title: "c", body: "", status: "ready" });
  await board.whenIdle();
  expect(store.getTicket("p", c.id)!.worktree).toBe(worktreeDir(p, c.id));
  // b already worked in the folder: its session belongs there, so it stays.
  await board.chat("p", b.id, "again");
  await board.whenIdle();
  expect(readArgs().at(-1)!.cwd).toBe(p.path);
  expect(store.getTicket("p", b.id)!.worktree).toBeNull();
}, 20000);

test("tickets with worktrees of their own still run side by side", async () => {
  await setup({ maxParallel: 3 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  await untilSpawned(2);
  expect(board.isRunning("p", a.id) && board.isRunning("p", b.id)).toBe(true);
  expect(board.folderWait("p", store.getTicket("p", b.id)!)).toBe(false);
}, 20000);

test("repo with no commits runs in the folder with a notice, then worktrees once it has a commit", async () => {
  const p = await setup({ git: false });
  await run(["git", "init", "-q", "-b", "main"], p.path);
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("done");
  expect(got.worktree).toBeNull();
  expect(got.notice).toContain("no commits yet");
  expect(readArgs()[0].cwd).toBe(p.path);

  // A follow-up run stays in the folder: its Claude session lives there.
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  expect(readArgs()[1].cwd).toBe(p.path);

  writeFileSync(join(p.path, "a.txt"), "a\n");
  await run(["git", "add", "."], p.path);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], p.path);
  const t2 = await board.createTicket("p", { title: "y", body: "", status: "ready" });
  await board.whenIdle();
  const got2 = store.getTicket("p", t2.id)!;
  expect(got2.worktree).toBeTruthy();
  expect(readArgs()[2].cwd).toBe(got2.worktree!);
  expect(got2.notice ?? null).toBeNull();
});

test("wrong saved base branch is corrected from the repo", async () => {
  const p = await setup();
  await run(["git", "branch", "-m", "main", "master"], p.path);
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("done");
  expect(got.worktree).toBeTruthy();
  expect(store.getProfile("p")!.baseBranch).toBe("master");
  expect(got.notice).toContain('"master"');
  await board.updateTicket("p", t.id, { notice: null });
  expect(store.getTicket("p", t.id)!.notice).toBeNull();
});

test("refine that cannot start can be retried by moving into Planning again", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  // Make worktree creation fail: a branch nested under the ticket's branch name blocks creating it.
  const blocker = `ck/${t.id}-x/blocker`;
  await run(["git", "branch", blocker], p.path);
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  let got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("failed");
  expect(got.refineStarted).toBe(false);
  expect(store.listComments("p", t.id).at(-1)!.text).toContain("Could not start");
  await run(["git", "branch", "-D", blocker], p.path);
  await board.updateTicket("p", t.id, { status: "backlog" });
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBeTruthy();
  expect(got.refineStarted).toBe(true);
});

test("moving to done removes clean worktree", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const wt = store.getTicket("p", t.id)!.worktree!;
  await board.updateTicket("p", t.id, { status: "done" });
  expect(existsSync(wt)).toBe(false);
  expect(store.getTicket("p", t.id)!.worktree).toBeNull();
});

async function doneAndBack(id: string) {
  await board.updateTicket("p", id, { status: "done" });
  expect(store.getTicket("p", id)!.worktree).toBeNull();
  await board.updateTicket("p", id, { status: "ready" });
  await board.whenIdle();
}

test("a ticket moved back from done gets its worktree back on its branch and resumes its session", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "Reopen", body: "", status: "ready" });
  await board.whenIdle();
  const first = store.getTicket("p", t.id)!;
  await doneAndBack(t.id);
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBe(worktreeDir(p, t.id));
  expect(existsSync(got.worktree!)).toBe(true);
  expect(got.branch).toBe(first.branch);
  expect((await run(["git", "branch", "--show-current"], got.worktree!)).stdout.trim()).toBe(first.branch!);
  const call = readArgs().at(-1)!;
  expect(call.cwd).toBe(got.worktree!);
  expect(call.args).toContain("--resume");
  expect(call.args).toContain(first.sessionId!);
  expect(got.outcome).toBe("done");
});

test("a reopened ticket whose branch was renamed takes the renamed branch", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "Rename", body: "", status: "ready" });
  await board.whenIdle();
  const first = store.getTicket("p", t.id)!;
  await board.updateTicket("p", t.id, { status: "done" });
  await run(["git", "branch", "-m", first.branch!, `ck/${t.id}-renamed`], p.path);
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.branch).toBe(`ck/${t.id}-renamed`);
  expect(got.worktree).toBe(worktreeDir(p, t.id));
  expect(got.notice ?? null).toBeNull();
});

test("a reopened ticket whose branch is gone starts again from base with a notice", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "Gone", body: "", status: "ready" });
  await board.whenIdle();
  const first = store.getTicket("p", t.id)!;
  await board.updateTicket("p", t.id, { status: "done" });
  await run(["git", "branch", "-D", first.branch!], p.path);
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBe(worktreeDir(p, t.id));
  expect(got.branch).toBe(first.branch);
  expect(got.notice).toContain("was not found");
  expect(readArgs().at(-1)!.cwd).toBe(got.worktree!);
});

test("a ticket that ran in the project folder keeps running there", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "In place", body: "", status: "backlog" });
  store.updateTicket("p", t.id, { runCount: 1, sessionStarted: true });
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBeNull();
  expect(readArgs().at(-1)!.cwd).toBe(p.path);
});

test("startup sweep removes worktrees of done and deleted tickets, keeps dirty and active ones", async () => {
  const p = await setup({ maxParallel: 4 });
  const mk = async (title: string) => {
    const t = await board.createTicket("p", { title, body: "", status: "ready" });
    await board.whenIdle();
    return store.getTicket("p", t.id)!;
  };
  const done = await mk("Done");
  const dirty = await mk("Dirty");
  const review = await mk("Review");
  const deleted = await mk("Deleted");
  // Orphans: Done tickets whose folder outlived the cleanup, and a folder whose ticket is gone.
  store.updateTicket("p", done.id, { status: "done", worktree: null });
  writeFileSync(join(dirty.worktree!, "wip.txt"), "wip\n");
  store.updateTicket("p", dirty.id, { status: "done" });
  store.deleteTicket("p", deleted.id);
  // A worktree outside the board's folder is never touched.
  const outside = join(tempDir("ck-outside-"), "wt");
  await run(["git", "worktree", "add", "-q", "-b", "other", outside, "main"], p.path);

  await board.sweepWorktrees();
  expect(existsSync(done.worktree!)).toBe(false);
  expect(existsSync(deleted.worktree!)).toBe(false);
  expect(existsSync(dirty.worktree!)).toBe(true);
  expect(store.getTicket("p", dirty.id)!.worktree).toBe(dirty.worktree);
  expect(existsSync(review.worktree!)).toBe(true);
  expect(existsSync(outside)).toBe(true);
  // Branches stay: they are the undo.
  expect((await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${done.branch}`], p.path)).code).toBe(0);
  expect((await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${deleted.branch}`], p.path)).code).toBe(0);
}, 20000);

test("startup sweep clears the worktree of a done ticket once it is clean", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Later", body: "", status: "ready" });
  await board.whenIdle();
  const wt = store.getTicket("p", t.id)!.worktree!;
  store.updateTicket("p", t.id, { status: "done" });
  await board.sweepWorktrees();
  expect(existsSync(wt)).toBe(false);
  expect(store.getTicket("p", t.id)!.worktree).toBeNull();
});

test("planningCommand creates session + worktree", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Plan me", body: "", status: "planning" });
  const cmd = await board.planningCommand("p", t.id);
  const got = store.getTicket("p", t.id)!;
  expect(got.sessionId).not.toBeNull();
  expect(existsSync(got.worktree!)).toBe(true);
  expect(cmd).toContain(`--session-id ${got.sessionId}`);
  expect(cmd).toContain(store.ticketPath("p", t.id));
});

test("emits ticket.updated events", async () => {
  await setup();
  const seen: string[] = [];
  bus.on((e) => { if (e.type === "ticket.updated") seen.push(e.ticket.status); });
  await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  expect(seen).toContain("in_progress");
  expect(seen.at(-1)).toBe("review");
});
