// Board: Planning auto-start, chat-driven card moves, drafts, cut-off replies and restarts.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { until } from "./helpers";
import { store, bus, board, liveSessions, restartBoard, setup, readArgs, untilSpawned, useBoardEnv } from "./board-env";

useBoardEnv();

test("creating a ticket in Planning starts the refine interview automatically", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "app idea", body: "gym tracker", status: "planning" });
  expect(board.isRunning("p", t.id)).toBe(true);
  await board.whenIdle();
  const call = readArgs()[0];
  expect(call.args[call.args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  expect(call.args[call.args.indexOf("--disallowedTools") + 1]).toStartWith("Edit,Write,NotebookEdit,");
  expect(call.prompt.startsWith("<ckanban-context")).toBe(true);
  expect(call.prompt).toContain("gym tracker");
  const got = store.getTicket("p", t.id)!;
  expect(got.refineStarted).toBe(true);
  expect(got.status).toBe("planning");
});

test("moving into Planning auto-starts only the first time; Backlog never does", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.whenIdle();
  expect(readArgs().length).toBe(0);
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
  await board.updateTicket("p", t.id, { status: "backlog" });
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
});

test("a manual refine chat also counts as started", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.chat("p", t.id, "thoughts?");
  await board.whenIdle();
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
});

test("linking a session moves the card to Review", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  const linked = await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  expect(linked.status).toBe("review");
});

test("linked ticket moved into Planning does not auto-start an interview", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  expect(readArgs().length).toBe(0);
});

test("chat still works while the linked session is open in a terminal", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  liveSessions.add("11111111-2222-3333-4444-555555555555");
  await board.chat("p", t.id, "what's the status?");
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
  expect(store.getTicket("p", t.id)!.outcome).not.toBe("blocked");
});

test("planning-only message in Review: Claude marks it and the card moves to Planning", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  process.env.FAKE_EXTRA = '\n1. idea\n<ckanban-move to="planning"/>';
  try {
    await board.chat("p", t.id, "Audit the UI and list 5 improvements. Don't change anything yet.");
    await board.whenIdle();
  } finally {
    delete process.env.FAKE_EXTRA;
  }
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("planning");
  expect(got.outcome).toBeNull();
  // The reply's summary is still recorded, like any other reply.
  expect(store.listComments("p", t.id).at(-1)).toMatchObject({ author: "ai", text: "fake done" });
  const prompt = readArgs()[1].prompt;
  expect(prompt).toContain('<ckanban-move to="planning"/>');
});

test("tickets-only message in Done: Claude marks it and the card stays in Done", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  await board.updateTicket("p", t.id, { status: "done" });
  process.env.FAKE_EXTRA = "\nProposed a follow-up.\n<ckanban-stay/>";
  try {
    await board.chat("p", t.id, "create a follow-up ticket for the docs");
    await board.whenIdle();
  } finally {
    delete process.env.FAKE_EXTRA;
  }
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("done");
  expect(got.outcome).toBe("done");
  expect(readArgs().at(-1)!.prompt).toContain("<ckanban-stay/>");
});

test("normal Review chat still lands back in Review", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  await board.chat("p", t.id, "make the button blue");
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.status).toBe("review");
});

test("streams Claude's text as draft events without persisting them", async () => {
  await setup();
  const drafts: string[] = [];
  bus.on((e) => { if (e.type === "draft") drafts.push(e.text); });
  process.env.FAKE_STREAM_DELAY = "200";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  delete process.env.FAKE_STREAM_DELAY;
  expect(drafts.length).toBeGreaterThan(0);
  expect(drafts.some((d) => d.startsWith("Work "))).toBe(true);
  expect(drafts.at(-1)).toBe("");
  expect(store.readActivity("p", t.id).some((a) => a.event?.type === "stream_event")).toBe(false);
});

test("prompts get image file paths; deleting the ticket deletes its images", async () => {
  await setup({ git: false });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  const { saveAttachment } = await import("../src/server/attachments");
  const inBody = saveAttachment(store.attachmentsDir, "png", png);
  const inComment = saveAttachment(store.attachmentsDir, "png", png);
  const other = saveAttachment(store.attachmentsDir, "png", png);
  const t = await board.createTicket("p", { title: "x", body: `see ![image](/api/attachments/${inBody})`, status: "ready" });
  await board.whenIdle();
  const prompt = readArgs()[0].prompt;
  expect(prompt).toContain(join(store.attachmentsDir, inBody));
  expect(prompt).toContain("Read tool");
  store.addComment("p", t.id, "user", `![image](/api/attachments/${inComment})`);
  await board.deleteTicket("p", t.id);
  expect(existsSync(join(store.attachmentsDir, inBody))).toBe(false);
  expect(existsSync(join(store.attachmentsDir, inComment))).toBe(false);
  expect(existsSync(join(store.attachmentsDir, other))).toBe(true);
});

test("a finished run lands on top of Review; dragging to Ready keeps the drop slot", async () => {
  await setup();
  const old = await board.createTicket("p", { title: "old", body: "", status: "review" });
  await board.createTicket("p", { title: "older", body: "", status: "review" });
  const t = await board.createTicket("p", { title: "new", body: "", status: "ready" });
  await board.whenIdle();
  const review = store.listTickets("p").filter((x) => x.status === "review").map((x) => x.title);
  expect(review).toEqual(["new", "older", "old"]);
  await board.updateTicket("p", old.id, { order: 100 });
  expect(store.getTicket("p", old.id)!.order).toBe(100);
  await board.updateTicket("p", t.id, { status: "backlog", order: 7 });
  expect(store.getTicket("p", t.id)!.order).toBe(7);
});

test("restart mid-reply: planning chat keeps its partial text and recover() resumes it in plan mode", async () => {
  await setup();
  process.env.FAKE_MODE = "partial";
  const drafts: string[] = [];
  bus.on((e) => { if (e.type === "draft") drafts.push(e.text); });
  const t = await board.createTicket("p", { title: "plan", body: "", status: "backlog" });
  await board.chat("p", t.id, "what next?");
  await until(() => drafts.includes("Half a repl"));
  await board.shutdown();
  const cut = store.getTicket("p", t.id)!;
  expect(cut.status).toBe("planning");
  expect(cut.interrupted).toMatchObject({ mode: "refine", partial: "Half a repl" });
  expect(cut.interrupted!.prompt).toBeUndefined();
  expect(cut.lastActivity).toBeNull();
  expect(cut.runStartedAt).toBeNull();

  process.env.FAKE_MODE = "ok";
  restartBoard();
  board.recover();
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(2);
  expect(calls[1].prompt).toContain("Reply interrupted by daemon restart");
  expect(calls[1].args.join(" ")).toContain("--disallowedTools Edit,Write,NotebookEdit,");
  expect(calls[1].args).toContain(cut.sessionId!);
  expect(store.listComments("p", t.id).map((c) => c.text)).toContain("Reply interrupted by daemon restart; resuming.");
  const after = store.getTicket("p", t.id)!;
  expect(after.interrupted ?? null).toBeNull();
  expect(after.status).toBe("planning");
}, 20000);

test("recover() starts nothing when no reply was cut off", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "plan", body: "", status: "backlog" });
  await board.chat("p", t.id, "hi");
  await board.whenIdle();
  await board.shutdown();
  restartBoard();
  board.recover();
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
  expect(store.listComments("p", t.id).some((c) => c.text.includes("interrupted"))).toBe(false);
});

test("cut-off reply with a queued message: one reply that answers the message", async () => {
  await setup();
  process.env.FAKE_MODE = "partial";
  const drafts: string[] = [];
  bus.on((e) => { if (e.type === "draft") drafts.push(e.text); });
  const t = await board.createTicket("p", { title: "plan", body: "", status: "backlog" });
  await board.chat("p", t.id, "first");
  await until(() => drafts.includes("Half a repl"));
  await board.shutdown();
  store.updateTicket("p", t.id, { queued: [{ id: "m1", text: "and also this", at: new Date().toISOString(), state: "queued" }] });

  process.env.FAKE_MODE = "ok";
  restartBoard();
  board.recover();
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(2);
  expect(calls[1].prompt!.startsWith("and also this")).toBe(true);
  expect(store.getTicket("p", t.id)!.queued).toEqual([]);
  expect(store.getTicket("p", t.id)!.interrupted ?? null).toBeNull();
}, 20000);

test("a chat cut off before claude started gets its message again, not a 'continue'", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "plan", body: "", status: "backlog" });
  await board.chat("p", t.id, "my question");
  await board.shutdown(); // still setting up the worktree: claude never spawned
  // Claude never read it: it stays queued on the ticket, and recover() answers it.
  expect(store.getTicket("p", t.id)!.queued).toMatchObject([{ text: "my question", state: "queued" }]);
  restartBoard();
  board.recover();
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(1);
  expect(calls[0].prompt!.startsWith("my question")).toBe(true);
});

test("requested restart waits for active runs and holds new ones until recover()", async () => {
  await setup();
  process.env.FAKE_STEP_MS = "300";
  try {
    const work = await board.createTicket("p", { title: "work", body: "", status: "ready" });
    await untilSpawned();
    let restarted = false;
    const restartEvents: { pending: boolean; waiting: number }[] = [];
    const off = bus.on((e) => { if (e.type === "restart.updated") restartEvents.push({ pending: e.pending, waiting: e.waiting }); });
    expect(board.restartState()).toEqual({ pending: false, waiting: 1 });
    expect(board.requestRestart(() => { restarted = true; }).running).toBe(1);
    expect(board.restartState()).toEqual({ pending: true, waiting: 1 });
    expect(restartEvents).toEqual([{ pending: true, waiting: 1 }]);
    expect(board.requestRestart(() => {}).alreadyPending).toBe(true);
    // Nothing new starts while the restart waits.
    const next = await board.createTicket("p", { title: "next", body: "", status: "ready" });
    const plan = await board.createTicket("p", { title: "plan", body: "", status: "planning" });
    const chat = await board.createTicket("p", { title: "chat", body: "", status: "backlog" });
    await board.chat("p", chat.id, "hello?");
    expect(board.isRunning("p", next.id) || board.isRunning("p", plan.id) || board.isRunning("p", chat.id)).toBe(false);
    expect(store.getTicket("p", chat.id)!.queued).toMatchObject([{ text: "hello?", state: "queued" }]);
    expect(store.getTicket("p", plan.id)!.interrupted).toMatchObject({ held: true });
    expect(restarted).toBe(false);
    await board.whenIdle();
    await until(() => restarted);
    expect(restarted).toBe(true);
    expect(store.getTicket("p", work.id)!.status).toBe("review");
    // The UI hears when the last run it waited for is gone.
    expect(restartEvents.at(-1)).toEqual({ pending: true, waiting: 0 });
    off();

    await board.shutdown();
    const before = readArgs().length;
    restartBoard();
    board.recover();
    await Bun.sleep(50);
    await board.whenIdle();
    const prompts = readArgs().slice(before).map((c) => c.prompt ?? "");
    expect(prompts.length).toBe(3);
    expect(prompts.some((p) => p.startsWith("hello?"))).toBe(true);
    expect(prompts.some((p) => p.includes("Board asked Claude to help refine"))).toBe(true);
    expect(store.getTicket("p", next.id)!.status).toBe("review");
    expect(store.listComments("p", plan.id).some((c) => c.text.includes("interrupted"))).toBe(false);
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
}, 30000);

test("requested restart gives up waiting after the timeout", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  await board.createTicket("p", { title: "work", body: "", status: "ready" });
  await untilSpawned();
  let restarted = false;
  board.requestRestart(() => { restarted = true; }, 500);
  await until(() => restarted);
  expect(restarted).toBe(true);
}, 15000);

test("a reply cut off by Stop hands its streamed text over, so the chat doesn't drop it", async () => {
  await setup();
  process.env.FAKE_MODE = "partial";
  const drafts: { text: string; final?: string }[] = [];
  bus.on((e) => { if (e.type === "draft") drafts.push({ text: e.text, final: e.final }); });
  try {
    const t = await board.createTicket("p", { title: "plan", body: "", status: "backlog" });
    await board.chat("p", t.id, "what next?");
    await until(() => drafts.some((d) => d.text === "Half a repl"));
    board.stop("p", t.id);
    await board.whenIdle();
    expect(drafts.at(-1)).toEqual({ text: "", final: "Half a repl" });
  } finally {
    process.env.FAKE_MODE = "ok";
  }
}, 20000);
