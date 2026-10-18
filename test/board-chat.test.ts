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
  expect(seen[0]).toBe(true);
  expect(seen.at(-1)).toBe(false);
});
