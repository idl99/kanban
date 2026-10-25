// Board chat: steering a running Claude, queued messages and replies waiting for a slot.
import { expect, test } from "bun:test";
import { ConflictError } from "../src/server/board";
import { until } from "./helpers";
import { store, bus, board, restartBoard, setup, readArgs, untilSpawned, replays, useBoardEnv } from "./board-env";

useBoardEnv();

test("chat while Claude works steers the run instead of restarting it", async () => {
  await setup();
  process.env.FAKE_STEP_MS = "200";
  try {
    const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
    await untilSpawned();
    expect(board.isRunning("p", t.id)).toBe(true);
    await board.chat("p", t.id, "also add a test for X");
    await board.chat("p", t.id, "and Y");
    await board.whenIdle();
    expect(readArgs().length).toBe(1);
    const steered = replays(t.id).slice(1);
    expect(steered.map((m) => m.split("\n")[0])).toEqual(["also add a test for X", "and Y"]);
    expect(steered[0]).toContain("<ckanban-context");
    const got = store.getTicket("p", t.id)!;
    expect(got.status).toBe("review");
    expect(got.outcome).toBe("done");
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
}, 15000);

test("/effort sets, shows and resets the ticket's effort; a run passes --effort (ticket over board)", async () => {
  const profile = await setup();
  store.saveProfile({ ...profile, effort: "medium" });
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  expect((await board.chat("p", t.id, "/effort")).notice).toContain("board's effort (medium)");
  await expect(board.chat("p", t.id, "/effort loud")).rejects.toThrow(/not an effort level/);
  expect((await board.chat("p", t.id, "/effort low")).effort).toBe("low");
  expect((await board.chat("p", t.id, "/effort")).notice).toContain("effort low");
  await board.updateTicket("p", t.id, { status: "ready" });
  await untilSpawned();
  await board.whenIdle();
  let args = readArgs()[0].args;
  expect(args[args.indexOf("--effort") + 1]).toBe("low");
  const reset = await board.chat("p", t.id, "/effort default");
  expect(reset.effort).toBeNull();
  expect(reset.notice).toContain("board's effort (medium)");
  await board.updateTicket("p", t.id, { status: "ready" });
  await untilSpawned(2);
  await board.whenIdle();
  args = readArgs()[1].args;
  expect(args[args.indexOf("--effort") + 1]).toBe("medium");
});

test("chat sent while the run is still starting is delivered once claude is up", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  // Worktree setup is still running: there is no claude process yet.
  await board.chat("p", t.id, "early note");
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
  expect(replays(t.id).slice(1).map((m) => m.split("\n")[0])).toEqual(["early note"]);
});

test("chat that arrives as the run finishes gets a follow-up reply", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  let sent = false;
  bus.on((e) => {
    if (e.type === "activity" && e.id === t.id && (e.event as any)?.type === "result" && !sent) {
      sent = true;
      board.chat("p", t.id, "late thought");
    }
  });
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(2);
  expect(calls[1].args).toContain("--resume");
  expect(calls[1].prompt.startsWith("late thought")).toBe(true);
  expect(store.getTicket("p", t.id)!.status).toBe("review");
});

test("chat is rejected while Claude is stopping", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.chat("p", t.id, "hi");
  await untilSpawned();
  board.stop("p", t.id);
  await expect(board.chat("p", t.id, "again")).rejects.toThrow(/stopping/);
}, 15000);

test("steering messages are saved on the ticket until Claude reads them", async () => {
  await setup();
  process.env.FAKE_STEP_MS = "300";
  try {
    const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
    await untilSpawned();
    const after = await board.chat("p", t.id, "also X");
    expect(after.queued).toMatchObject([{ text: "also X", state: "queued" }]);
    expect(store.getTicket("p", t.id)!.queued).toHaveLength(1);
    await board.whenIdle();
    expect(store.getTicket("p", t.id)!.queued).toEqual([]);
    expect(replays(t.id).slice(1).map((m) => m.split("\n")[0])).toEqual(["also X"]);
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
}, 15000);

test("Stop keeps unread messages as unsent; send or discard them later", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await untilSpawned();
  await board.chat("p", t.id, "first");
  await board.chat("p", t.id, "second");
  board.stop("p", t.id);
  await board.whenIdle();
  const q = store.getTicket("p", t.id)!.queued!;
  expect(q.map((m) => [m.text, m.state])).toEqual([["first", "unsent"], ["second", "unsent"]]);

  board.discardQueued("p", t.id, q[1].id);
  expect(store.getTicket("p", t.id)!.queued!.map((m) => m.text)).toEqual(["first"]);

  process.env.FAKE_MODE = "ok";
  await board.sendQueued("p", t.id, q[0].id);
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.queued).toEqual([]);
  const calls = readArgs();
  expect(calls.at(-1)!.prompt.startsWith("first")).toBe(true);
  expect(() => board.discardQueued("p", t.id, q[0].id)).toThrow(/not found/);
}, 15000);

test("Stop before Claude reads the message that started its reply keeps it unsent", async () => {
  await setup();
  process.env.FAKE_START_MS = "3000";
  try {
    const t = await board.createTicket("p", { title: "x", body: "", status: "review" });
    const sent = await board.chat("p", t.id, "oops, wrong message");
    expect(sent.queued).toMatchObject([{ text: "oops, wrong message", state: "queued" }]);
    await untilSpawned();
    board.stop("p", t.id);
    await board.whenIdle();
    const q = store.getTicket("p", t.id)!.queued!;
    expect(q.map((m) => [m.text, m.state])).toEqual([["oops, wrong message", "unsent"]]);

    board.discardQueued("p", t.id, q[0].id);
    expect(store.getTicket("p", t.id)!.queued).toEqual([]);
  } finally {
    delete process.env.FAKE_START_MS;
  }
}, 15000);

test("a reply whose message Claude read leaves nothing queued", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "review" });
  await board.chat("p", t.id, "what did you change?");
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.queued).toEqual([]);
  expect(readArgs().at(-1)!.prompt.startsWith("what did you change?")).toBe(true);
});

test("daemon restart keeps unread messages and delivers them after recovery", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const work = await board.createTicket("p", { title: "work", body: "", status: "ready" });
  await untilSpawned();
  await board.chat("p", work.id, "keep going with Y");
  await board.shutdown();
  expect(store.getTicket("p", work.id)!.queued).toMatchObject([{ text: "keep going with Y", state: "queued" }]);
  // A chat reply that was cut off too, on a ticket recover() does not resume.
  const chatTicket = await board.createTicket("p", { title: "chat", body: "", status: "review" });
  store.updateTicket("p", chatTicket.id, { queued: [{ id: "m1", text: "what about Z?", at: new Date().toISOString(), state: "queued" }] });

  process.env.FAKE_MODE = "ok";
  restartBoard();
  board.recover();
  await board.whenIdle();
  expect(store.getTicket("p", work.id)!.queued).toEqual([]);
  expect(replays(work.id).some((m) => m.startsWith("keep going with Y"))).toBe(true);
  expect(store.getTicket("p", chatTicket.id)!.queued).toEqual([]);
  expect(readArgs().some((c) => c.prompt?.startsWith("what about Z?"))).toBe(true);
}, 20000);

test("a chat reply that resumes work waits for a free slot, then starts before Ready tickets", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const r = await board.createTicket("p", { title: "r", body: "", status: "review" });
  await untilSpawned();
  await board.chat("p", r.id, "go on with it");
  const waiting = store.getTicket("p", r.id)!;
  expect(board.isRunning("p", r.id)).toBe(false);
  expect(waiting.status).toBe("in_progress");
  expect(waiting.slotWait?.from).toEqual({ status: "review", outcome: null });
  expect(waiting.queued).toMatchObject([{ text: "go on with it", state: "queued" }]);
  expect(board.running("p")).toBe(1);
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });

  board.stop("p", a.id);
  await untilSpawned(2);
  expect(board.isRunning("p", r.id)).toBe(true);
  expect(board.holdsSlot("p", r.id)).toBe(true);
  expect(store.getTicket("p", r.id)!.slotWait).toBeNull();
  expect(store.getTicket("p", b.id)!.status).toBe("ready");
  expect(board.running("p")).toBe(1);
  expect(readArgs().at(-1)!.prompt.startsWith("go on with it")).toBe(true);
}, 15000);

test("steering a running ticket takes no extra slot", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  await untilSpawned();
  await board.chat("p", a.id, "also do X");
  expect(board.running("p")).toBe(1);
  expect(store.getTicket("p", a.id)!.slotWait).toBeFalsy();
}, 15000);

test("Stop on a reply waiting for a slot puts the card back and keeps the message unsent", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const r = await board.createTicket("p", { title: "r", body: "", status: "review" });
  await untilSpawned();
  await board.chat("p", r.id, "go on with it");
  expect(board.stop("p", r.id)).toBe(true);
  const got = store.getTicket("p", r.id)!;
  expect(got.status).toBe("review");
  expect(got.slotWait).toBeNull();
  expect(got.queued).toMatchObject([{ text: "go on with it", state: "unsent" }]);

  board.stop("p", a.id);
  await board.whenIdle();
  expect(board.isRunning("p", r.id)).toBe(false);
  expect(readArgs().some((c) => c.prompt?.startsWith("go on with it"))).toBe(false);
}, 15000);

test("a reply waiting for a slot can be edited; Claude gets the edited text", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const r = await board.createTicket("p", { title: "r", body: "", status: "review" });
  await untilSpawned();
  await board.chat("p", r.id, "go on with it");
  const [msg] = store.getTicket("p", r.id)!.queued!;
  expect(() => board.editQueued("p", r.id, msg.id, "  ")).toThrow(/empty/);
  board.editQueued("p", r.id, msg.id, "go on, and add a test");
  expect(store.getTicket("p", r.id)!.queued).toMatchObject([{ id: msg.id, text: "go on, and add a test", state: "queued" }]);

  board.stop("p", a.id);
  await untilSpawned(2);
  expect(board.isRunning("p", r.id)).toBe(true);
  expect(readArgs().at(-1)!.prompt.startsWith("go on, and add a test")).toBe(true);
  // Now it is Claude's prompt: too late to change it.
  expect(() => board.editQueued("p", r.id, msg.id, "other")).toThrow();
}, 15000);

test("discarding the only reply waiting for a slot puts the card back", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const r = await board.createTicket("p", { title: "r", body: "", status: "review" });
  await untilSpawned();
  await board.chat("p", r.id, "go on with it");
  const [msg] = store.getTicket("p", r.id)!.queued!;
  const got = board.discardQueued("p", r.id, msg.id);
  expect(got).toMatchObject({ status: "review", slotWait: null, queued: [] });
}, 15000);

test("a message steered into a running Claude can't be edited; an unsent one can", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await untilSpawned();
  await board.chat("p", t.id, "first");
  const [msg] = store.getTicket("p", t.id)!.queued!;
  expect(() => board.editQueued("p", t.id, msg.id, "changed")).toThrow(ConflictError);
  expect(() => board.discardQueued("p", t.id, msg.id)).toThrow(ConflictError);
  board.stop("p", t.id);
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.queued).toMatchObject([{ id: msg.id, state: "unsent" }]);
  board.editQueued("p", t.id, msg.id, "first, fixed");
  process.env.FAKE_MODE = "ok";
  await board.sendQueued("p", t.id, msg.id);
  await board.whenIdle();
  expect(readArgs().at(-1)!.prompt.startsWith("first, fixed")).toBe(true);
  expect(() => board.editQueued("p", t.id, "nope", "x")).toThrow(/not found/);
}, 15000);

test("a peer message waiting for a slot can't be edited", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "review" });
  store.updateTicket("p", t.id, { queued: [{ id: "m1", text: "from a peer", at: new Date().toISOString(), state: "queued", peer: true }] });
  expect(() => board.editQueued("p", t.id, "m1", "changed")).toThrow(ConflictError);
});

test("after a restart, waiting replies still respect maxParallel", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const r = await board.createTicket("p", { title: "r", body: "", status: "review" });
  await untilSpawned();
  await board.chat("p", r.id, "go on with it");
  await board.shutdown();
  // A message a restart left undelivered on another Review card.
  const c = await board.createTicket("p", { title: "c", body: "", status: "review" });
  store.updateTicket("p", c.id, { queued: [{ id: "m1", text: "what about Z?", at: new Date().toISOString(), state: "queued" }] });

  restartBoard();
  board.recover();
  await untilSpawned(2);
  expect(board.running("p")).toBe(1);
  // The waiting reply goes first; the interrupted work run and the other reply wait.
  expect(board.isRunning("p", r.id)).toBe(true);
  expect(store.getTicket("p", a.id)!.status).toBe("ready");
  expect(board.isRunning("p", c.id)).toBe(false);
  expect(store.getTicket("p", c.id)!).toMatchObject({ status: "in_progress", slotWait: { from: { status: "review" } } });
}, 20000);

test("refine chat does not take a queue slot", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "plan", body: "", status: "backlog" });
  await board.chat("p", a.id, "hi");
  const b = await board.createTicket("p", { title: "work", body: "", status: "ready" });
  await until(() => store.getTicket("p", b.id)!.status === "in_progress");
  expect(store.getTicket("p", b.id)!.status).toBe("in_progress");
}, 15000);

test("last ticket event after a chat reply reports it idle", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  const seen: boolean[] = [];
  bus.on((e) => { if (e.type === "ticket.updated" && e.ticket.id === t.id) seen.push(board.isRunning("p", t.id)); });
  await board.chat("p", t.id, "hi");
  await board.whenIdle();
  expect(seen).toContain(true);
  expect(seen.at(-1)).toBe(false);
});

test("a peer message or a running plan's child keeps a Backlog card in Backlog", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.chat("p", t.id, "a note from another ticket", { peer: true });
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.status).toBe("backlog");
  const planner = await board.createTicket("p", { title: "plan", body: "", status: "review" });
  const kid = await board.createTicket("p", { title: "kid", body: "", status: "backlog" });
  store.updateTicket("p", kid.id, { parentId: planner.id, mode: "interview" });
  const plan = (state: "running" | "paused") => ({ state, maxConcurrent: 1, wakeups: 0, startedAt: new Date().toISOString(), originalCount: 1, inbox: [], seen: {}, retries: {}, awaiting: null });
  // The running plan moves its children itself.
  store.updateTicket("p", planner.id, { plan: plan("running") });
  expect((await board.chat("p", kid.id, "a question")).status).toBe("backlog");
  await board.stop("p", kid.id);
  await board.whenIdle();
  // A paused plan's child is the user's to shape: it moves like any other card.
  store.updateTicket("p", planner.id, { plan: plan("paused") });
  store.updateTicket("p", kid.id, { status: "backlog" });
  await board.chat("p", kid.id, "shape this");
  await board.whenIdle();
  expect(store.getTicket("p", kid.id)!.status).toBe("planning");
});

test("the user asks a Review card's own chat to mark it done: it moves once the reply ends", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.status).toBe("review");
  process.env.FAKE_STEP_MS = "200";
  try {
    // Not the user's message (another ticket's Claude): refused.
    await board.chat("p", t.id, "mark yourself done", { peer: true });
    await until(() => board.isRunning("p", t.id));
    expect(board.requestSelfMove("p", t.id, "done")).toBe(false);
    await board.whenIdle();
    expect(store.getTicket("p", t.id)!.status).toBe("review");

    await board.chat("p", t.id, "looks good, mark this done");
    await until(() => board.isRunning("p", t.id));
    expect(board.requestSelfMove("p", t.id, "done")).toBe(true);
    // The reply goes on; the card moves only afterwards.
    expect(board.isRunning("p", t.id)).toBe(true);
    expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
    await board.whenIdle();
    await until(() => store.getTicket("p", t.id)!.status === "done");
    expect(store.listComments("p", t.id).at(-1)!.text).toBe("Moved it to done by its own chat (user request).");
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
}, 20000);

test("a self move is dropped when the user stops the reply or moves the card meanwhile", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  process.env.FAKE_STEP_MS = "300";
  try {
    await board.chat("p", t.id, "put it back in Backlog");
    await until(() => board.isRunning("p", t.id));
    expect(board.requestSelfMove("p", t.id, "backlog")).toBe(true);
    await board.stop("p", t.id);
    await board.whenIdle();
    expect(store.getTicket("p", t.id)!.status).not.toBe("backlog");

    await board.chat("p", t.id, "mark this done");
    await until(() => board.isRunning("p", t.id));
    expect(board.requestSelfMove("p", t.id, "done")).toBe(true);
    await board.updateTicket("p", t.id, { status: "review" });
    await board.whenIdle();
    expect(store.getTicket("p", t.id)!.status).toBe("review");
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
}, 20000);
