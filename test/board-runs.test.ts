// Board runs: start, finish, fail, stop, sessions and recovery of a single ticket.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { store, bus, board, setup, readArgs, untilSpawned, useBoardEnv } from "./board-env";

useBoardEnv();

test("ready ticket runs to review with PR and AI comment", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Add thing", body: "desc", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("done");
  expect(got.prUrl).toBe("https://github.com/x/y/pull/7");
  expect(got.runCount).toBe(1);
  expect(got.worktree).not.toBeNull();
  expect(existsSync(got.worktree!)).toBe(true);
  expect(got.branch).toStartWith(`ck/${t.id}-add-thing`);
  expect(got.lastActivity).toBe("Finished");
  const comments = store.listComments("p", t.id);
  expect(comments.at(-1)).toMatchObject({ author: "ai", text: "fake done" });
  const call = readArgs()[0];
  expect(call.args).toContain("--session-id");
  expect(call.args).toContain(got.sessionId!);
  expect(call.cwd).toBe(got.worktree!);
  const activity = store.readActivity("p", t.id);
  // The run marker, then the fake claude's events.
  expect(activity[0].event).toEqual({ type: "ckanban_run", kind: "work" });
  expect(activity.length).toBe(6);
});

test("maxParallel limits concurrent runs", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  await untilSpawned();
  expect(board.running("p")).toBe(1);
  expect(store.getTicket("p", b.id)!.status).toBe("ready");
}, 15000);

test("failed run marks outcome failed with stderr", async () => {
  await setup();
  process.env.FAKE_MODE = "fail";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("failed");
  expect(got.error).toContain("boom");
});

test("blocked result marks outcome blocked", async () => {
  await setup();
  process.env.FAKE_MODE = "blocked";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.outcome).toBe("blocked");
});

test("no result line still done with final text comment", async () => {
  await setup();
  process.env.FAKE_MODE = "noresult";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.outcome).toBe("done");
  expect(store.listComments("p", t.id).at(-1)!.text).toBe("All done, no result line.");
});

test("rework resumes session with new user comments", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  await Bun.sleep(5);
  board.addComment("p", t.id, "please use blue");
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(2);
  expect(calls[1].args).toContain("--resume");
  const prompt = calls[1].prompt;
  expect(prompt).toContain("please use blue");
  expect(calls[1].cwd).toBe(calls[0].cwd);
  expect(store.getTicket("p", t.id)!.runCount).toBe(2);
});

test("moving running ticket out of in_progress stops the run", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await untilSpawned();
  expect(board.running("p")).toBe(1);
  await board.updateTicket("p", t.id, { status: "backlog" });
  await board.whenIdle();
  expect(board.running("p")).toBe(0);
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("backlog");
  expect(got.outcome).toBe("stopped");
}, 15000);

test("stop moves to review with stopped outcome", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await untilSpawned();
  board.stop("p", t.id);
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("stopped");
}, 15000);

test("stop during worktree setup shows Stopping… and never spawns claude", async () => {
  await setup();
  const seen: (string | null)[] = [];
  bus.on((e) => { if (e.type === "ticket.updated") seen.push(e.ticket.lastActivity); });
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  expect(board.stop("p", t.id)).toBe(true);
  expect(store.getTicket("p", t.id)!.lastActivity).toBe("Stopping…");
  await board.whenIdle();
  expect(readArgs().length).toBe(0);
  expect(seen).toContain("Stopping…");
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("stopped");
  expect(got.lastActivity).toBeNull();
});

test("stop keeps Stopping… on the card while the process shuts down", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await untilSpawned();
  board.stop("p", t.id);
  expect(store.getTicket("p", t.id)!.lastActivity).toBe("Stopping…");
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.lastActivity).toBeNull();
}, 15000);

test("stop on an in_progress ticket with no live run clears it", async () => {
  await setup();
  const t = store.createTicket("p", { title: "x", body: "", status: "in_progress" });
  expect(board.stop("p", t.id)).toBe(true);
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("stopped");
  expect(store.listComments("p", t.id).some((c) => c.text === "Run stopped by user.")).toBe(true);
});

test("a run stopped before its session was saved doesn't break the next runs", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  process.env.FAKE_NO_SAVE = "1";
  try {
    const t = await board.createTicket("p", { title: "x", body: "", status: "ready", mode: "interview" });
    await untilSpawned();
    board.stop("p", t.id);
    await board.whenIdle();
  } finally {
    delete process.env.FAKE_NO_SAVE;
  }
  process.env.FAKE_MODE = "ok";
  const t = store.listTickets("p")[0];
  // Moving the card to Planning starts the interview, in a new session.
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(2);
  expect(calls[1].args).toContain("--session-id");
  expect(calls[1].args).not.toContain("--resume");
  expect(calls[1].args[calls[1].args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  expect(calls[1].args[calls[1].args.indexOf("--disallowedTools") + 1]).toStartWith("Edit,Write,NotebookEdit,");
  const got = store.getTicket("p", t.id)!;
  expect(got.error).toBeNull();
  expect(got.status).toBe("planning");
  // That session was saved, so the next message resumes it.
  await board.chat("p", t.id, "more");
  await board.whenIdle();
  expect(readArgs()[2].args).toContain("--resume");
}, 15000);

test("a ticket stuck on a missing session heals: the next run starts a new session", async () => {
  await setup();
  const t = store.createTicket("p", { title: "x", body: "", status: "review" });
  // Saved by an older version: marked started, but Claude never saved the session.
  store.updateTicket("p", t.id, { sessionId: crypto.randomUUID(), sessionStarted: true, runCount: 1, error: "No conversation found with session ID: x", outcome: "failed" });
  await board.chat("p", t.id, "go on");
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(1);
  expect(calls[0].args).toContain("--session-id");
  expect(calls[0].args).not.toContain("--resume");
  const got = store.getTicket("p", t.id)!;
  expect(got.error).toBeNull();
  expect(store.listComments("p", t.id).some((c) => c.text.startsWith("Run failed"))).toBe(false);
});

test("Claude not finding a session it should have: retried once in a new session", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const old = store.getTicket("p", t.id)!.sessionId;
  process.env.FAKE_MODE = "nosession";
  await board.chat("p", t.id, "go on");
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(3);
  expect(calls[1].args).toContain("--resume");
  expect(calls[2].args).toContain("--session-id");
  const got = store.getTicket("p", t.id)!;
  expect(got.sessionId).not.toBe(old);
  expect(calls[2].args).toContain(got.sessionId!);
  expect(got.error).toBeNull();
  expect(store.listComments("p", t.id).some((c) => c.text.startsWith("Run failed"))).toBe(false);
});

test("stop with nothing running is a no-op", async () => {
  await setup();
  const t = store.createTicket("p", { title: "x", body: "", status: "backlog" });
  expect(board.stop("p", t.id)).toBe(false);
  expect(store.getTicket("p", t.id)!.status).toBe("backlog");
});

test("recover moves in_progress back to ready and runs", async () => {
  await setup();
  const t = store.createTicket("p", { title: "x", body: "", status: "in_progress" });
  board.recover();
  await Bun.sleep(50);
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(store.listComments("p", t.id)[0].text).toContain("Interrupted by daemon restart");
});

test("non-git profile runs in profile path without worktree", async () => {
  const p = await setup({ git: false });
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBeNull();
  expect(readArgs()[0].cwd).toBe(p.path);
  const prompt = readArgs()[0].prompt;
  expect(prompt).toContain("no version history");
  expect(prompt).not.toContain('report status "blocked"');
});
