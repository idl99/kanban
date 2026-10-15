// Board: shutdown, linked sessions, outputs and chat in Planning / Review.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { store, bus, board, liveSessions, setup, readArgs, untilSpawned, useBoardEnv } from "./board-env";

useBoardEnv();

test("shutdown leaves running ticket in_progress for recovery", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await untilSpawned();
  await board.shutdown();
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
}, 15000);

test("moving a running ticket to ready restarts it and keeps in_progress", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await untilSpawned();
  await board.updateTicket("p", t.id, { status: "ready" });
  await Bun.sleep(200);
  expect(board.isRunning("p", t.id)).toBe(true);
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
}, 15000);

test("shutdown during worktree setup never spawns claude", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.shutdown();
  await Bun.sleep(300);
  expect(readArgs().length).toBe(0);
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
});

test("body update with stale expectedBody is rejected", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "old", status: "planning" });
  store.updateTicket("p", t.id, { body: "plan from claude" });
  await expect(board.updateTicket("p", t.id, { body: "mine", expectedBody: "old" })).rejects.toThrow(/changed/);
  expect(store.getTicket("p", t.id)!.body).toBe("plan from claude");
  await board.updateTicket("p", t.id, { body: "mine", expectedBody: "plan from claude" });
  expect(store.getTicket("p", t.id)!.body).toBe("mine");
});

test("linked session runs in profile folder with --resume and no worktree", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "OS status", body: "", status: "review" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  const linked = store.getTicket("p", t.id)!;
  expect(linked.sessionId).toBe("11111111-2222-3333-4444-555555555555");
  expect(linked.workdir).toBe(p.path);
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const call = readArgs()[0];
  expect(call.cwd).toBe(p.path);
  expect(call.args).toContain("--resume");
  expect(call.args).toContain("11111111-2222-3333-4444-555555555555");
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBeNull();
  expect(got.status).toBe("review");
});

test("run refuses when the linked session is still open in a terminal", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "review" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  liveSessions.add("11111111-2222-3333-4444-555555555555");
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  expect(readArgs().length).toBe(0);
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("blocked");
  expect(store.listComments("p", t.id).at(-1)!.text).toContain("still open in a terminal");
});

test("done on linked ticket never removes the profile folder", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "review" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  await board.updateTicket("p", t.id, { status: "done" });
  expect(existsSync(p.path)).toBe(true);
});

test("cannot link while running", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await untilSpawned();
  await expect(board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555")).rejects.toThrow(/running/);
}, 15000);

test("interview ticket asking questions lands in review as needs_input", async () => {
  await setup();
  process.env.FAKE_MODE = "questions";
  const t = await board.createTicket("p", { title: "explore", body: "", status: "ready", mode: "interview" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.mode).toBe("interview");
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("needs_input");
  expect(got.interviewed).toBe(true);
  expect(readArgs()[0].prompt).toContain("interview first");
  const c = store.listComments("p", t.id).at(-1)!;
  expect(c.text).toContain("Work complete.");
  expect(c.text).not.toContain("CKANBAN_RESULT");
});

test("runs get an outputs folder and deliverables are listed", async () => {
  await setup();
  process.env.FAKE_OUTPUT = "# Report\nTL;DR";
  try {
    const t = await board.createTicket("p", { title: "research", body: "", status: "ready" });
    await board.whenIdle();
    const outs = store.listOutputs("p", t.id);
    expect(outs.map((o) => o.name)).toEqual(["report.md"]);
    expect(store.outputPath("p", t.id, "report.md")).not.toBeNull();
    expect(store.outputPath("p", t.id, "../ticket.md")).toBeNull();
  } finally {
    delete process.env.FAKE_OUTPUT;
  }
});

test("chat in Planning refines read-only and keeps the card in place", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "App idea", body: "habit tracker", status: "backlog" });
  await board.chat("p", t.id, "Help me shape this idea");
  expect(board.isRunning("p", t.id)).toBe(true);
  expect(board.running("p")).toBe(0);
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("backlog");
  expect(got.runCount).toBe(0);
  expect(got.sessionStarted).toBe(true);
  const call = readArgs()[0];
  expect(call.args[call.args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  expect(call.args[call.args.indexOf("--disallowedTools") + 1]).toStartWith("Edit,Write,NotebookEdit,");
  // The planning tools come from the board's own MCP server, whatever the user registered.
  expect(JSON.parse(call.args[call.args.indexOf("--mcp-config") + 1]).mcpServers.ckanban.args.at(-1)).toBe("mcp");
  const prompt = call.prompt;
  expect(prompt.startsWith("Help me shape this idea")).toBe(true);
  expect(prompt).toContain("<ckanban-context");
  expect(prompt).toContain("propose_ticket");
  expect(prompt).toContain("<ckanban-ticket>");
  // second message resumes the same session
  await board.chat("p", t.id, "Just for me");
  await board.whenIdle();
  expect(readArgs()[1].args).toContain("--resume");
});

test("planning replies save their mockup blocks to outputs/mockups; work runs don't", async () => {
  await setup();
  process.env.FAKE_EXTRA = '\n<ckanban-mockup name="a-compact.html"><!doctype html><p>A</p></ckanban-mockup>';
  try {
    const t = await board.createTicket("p", { title: "New sidebar", body: "d", status: "backlog" });
    await board.chat("p", t.id, "Show me options");
    await board.whenIdle();
    const file = join(store.outputsDir("p", t.id), "mockups", "a-compact.html");
    expect(readFileSync(file, "utf8")).toBe("<!doctype html><p>A</p>\n");
    const w = await board.createTicket("p", { title: "Work", body: "d", status: "review" });
    await board.chat("p", w.id, "tweak it");
    await board.whenIdle();
    expect(existsSync(join(store.outputsDir("p", w.id), "mockups"))).toBe(false);
  } finally {
    delete process.env.FAKE_EXTRA;
  }
});

test("runStartedAt is set while Claude works and cleared after, for runs and chat replies", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Timed", body: "d", status: "backlog" });
  const started: (string | null | undefined)[] = [];
  bus.on((e) => { if (e.type === "ticket.updated" && e.ticket.id === t.id) started.push(e.ticket.runStartedAt); });
  await board.chat("p", t.id, "Shape it");
  expect(store.getTicket("p", t.id)!.runStartedAt).toBeString();
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.runStartedAt).toBeNull();
  expect(started.at(-1)).toBeNull();
  const r = await board.createTicket("p", { title: "Queued", body: "d", status: "ready" });
  expect(store.getTicket("p", r.id)!.runStartedAt).toBeString();
  await board.whenIdle();
  const got = store.getTicket("p", r.id)!;
  expect(got.status).toBe("review");
  expect(got.runStartedAt).toBeNull();
});

test("chat in Review acts right away: In Progress then back to Review", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  await board.chat("p", t.id, "Please also add tests");
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.runCount).toBe(2);
  const call = readArgs()[1];
  expect(call.args).toContain("--resume");
  expect(call.args[call.args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  expect(call.args).not.toContain("--disallowedTools");
  expect(call.prompt.startsWith("Please also add tests")).toBe(true);
});
