// Board: one-click session recovery and spending caps.
import { expect, test } from "bun:test";
import { Board, ConflictError, recoveryFor, SESSION_OPEN_MSG } from "../src/server/board";
import { FAKE, store, bus, board, liveSessions, setBoard, setup, readArgs, useBoardEnv } from "./board-env";

useBoardEnv();

// ---- One-click recovery: Start fresh session / Take over here ----

test("recoveryFor: lost session and open-in-terminal errors get a fix, others don't", () => {
  expect(recoveryFor("No conversation found with session ID: abc")).toBe("session_missing");
  expect(recoveryFor(SESSION_OPEN_MSG)).toBe("session_open");
  expect(recoveryFor("claude exited with code 1")).toBeNull();
  expect(recoveryFor(null)).toBeNull();
});

test("a linked ticket's lost session shows Start fresh session, which runs a new session in the same folder", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "x", body: "the task", status: "review" });
  const old = "11111111-2222-3333-4444-555555555555";
  await board.linkSession("p", t.id, old);
  store.addComment("p", t.id, "user", "please also do Y");
  process.env.FAKE_MODE = "nosession";
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  let got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("failed");
  expect(recoveryFor(got.error)).toBe("session_missing");

  process.env.FAKE_MODE = "ok";
  board.startFresh("p", t.id);
  await board.whenIdle();
  got = store.getTicket("p", t.id)!;
  expect(got.sessionId).not.toBe(old);
  expect(got.workdir).toBe(p.path);
  expect(got.freshSession).toBe(false);
  expect(got.outcome).toBe("done");
  expect(got.error).toBeNull();
  const call = readArgs().at(-1)!;
  expect(call.args).toContain("--session-id");
  expect(call.args).toContain(got.sessionId!);
  expect(call.cwd).toBe(p.path);
  expect(call.prompt).toContain("new Claude session");
  expect(call.prompt).toContain("the task");
  expect(call.prompt).toContain("please also do Y");
  expect(call.prompt).toContain("git log --oneline main..HEAD");
  expect(store.listComments("p", t.id).some((c) => c.author === "ai" && c.text.startsWith("Started a fresh session"))).toBe(true);
});

test("Start fresh session keeps the worktree and branch and hands Claude the last result", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const before = store.getTicket("p", t.id)!;
  store.updateTicket("p", t.id, { error: "No conversation found with session ID: x", outcome: "failed" });
  board.startFresh("p", t.id);
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBe(before.worktree);
  expect(got.branch).toBe(before.branch);
  expect(got.sessionId).not.toBe(before.sessionId);
  const call = readArgs().at(-1)!;
  expect(call.cwd).toBe(before.worktree!);
  expect(call.args).toContain("--session-id");
  expect(call.prompt).toContain("# Last result\nfake done");
  // The next run resumes the new session like any other.
  await board.chat("p", t.id, "more");
  await board.whenIdle();
  expect(readArgs().at(-1)!.args).toContain("--resume");
}, 15000);

test("Take over here closes the session in the board's terminal and the run resumes", async () => {
  let closed = 0;
  setBoard(new Board(store, bus, {
    claudeBin: FAKE,
    isSessionLive: async (s) => liveSessions.has(s),
    findOwnedSession: async (s) => (liveSessions.has(s) ? { pid: 1, close: async () => (closed++, liveSessions.delete(s), true) } : null),
  }));
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const id = store.getTicket("p", t.id)!.sessionId!;
  liveSessions.add(id);
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  expect(recoveryFor(store.getTicket("p", t.id)!.error)).toBe("session_open");
  expect(readArgs().length).toBe(1);

  const r = await board.takeOver("p", t.id);
  expect(r.external).toBe(false);
  await board.whenIdle();
  expect(closed).toBe(1);
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("done");
  expect(got.sessionId).toBe(id);
  expect(readArgs().at(-1)!.args).toContain("--resume");
  expect(store.listComments("p", t.id).some((c) => c.text.startsWith("Took over the session: closed it"))).toBe(true);
});

test("Take over here can't close an external terminal: nothing changes and the UI offers a fresh session", async () => {
  const id = "11111111-2222-3333-4444-555555555555";
  setBoard(new Board(store, bus, { claudeBin: FAKE, isSessionLive: async (s) => liveSessions.has(s), findOwnedSession: async () => null }));
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "review" });
  await board.linkSession("p", t.id, id);
  liveSessions.add(id);
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const r = await board.takeOver("p", t.id);
  expect(r.external).toBe(true);
  await board.whenIdle();
  expect(readArgs().length).toBe(0);
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(recoveryFor(got.error)).toBe("session_open");
  // Start fresh session works around it: a new session, so the open terminal doesn't block the run.
  board.startFresh("p", t.id);
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.outcome).toBe("done");
  expect(readArgs().at(-1)!.args).toContain("--session-id");
});

test("recovery actions refuse while Claude is working on the ticket", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(50);
  expect(() => board.startFresh("p", t.id)).toThrow(ConflictError);
  await expect(board.takeOver("p", t.id)).rejects.toThrow(ConflictError);
});

test("a run stops at its spending cap, waits blocked, and Continue with +$Y resumes it with that cap", async () => {
  const p = await setup();
  store.saveProfile({ ...p, runCapUsd: 0.05 });
  process.env.FAKE_MODE = "budget";
  const t = await board.createTicket("p", { title: "Capped", body: "desc", status: "ready" });
  await board.whenIdle();
  let got = store.getTicket("p", t.id)!;
  expect(readArgs()[0].args.join(" ")).toContain("--max-budget-usd 0.05");
  expect(got).toMatchObject({ status: "review", outcome: "blocked", error: "Stopped at $0.05 cap", capHit: { capUsd: 0.05 } });
  expect(store.listComments("p", t.id).at(-1)!.text).toStartWith("Stopped at $0.05 cap");

  process.env.FAKE_MODE = "ok";
  await board.continueAfterCap("p", t.id, 0.5);
  await board.whenIdle();
  got = store.getTicket("p", t.id)!;
  const call = readArgs().at(-1)!;
  expect(call.args).toContain("--resume");
  expect(call.args.join(" ")).toContain("--max-budget-usd 0.5");
  expect(got).toMatchObject({ outcome: "done", capHit: null, capNextUsd: null });
  await expect(board.continueAfterCap("p", t.id, 0)).rejects.toThrow("positive");
});

test("a ticket's own cap overrides the board's; 0 runs without one", async () => {
  const p = await setup();
  store.saveProfile({ ...p, runCapUsd: 5 });
  const a = await board.createTicket("p", { title: "Own cap", body: "desc", status: "backlog" });
  await board.updateTicket("p", a.id, { runCapUsd: 2 });
  await board.updateTicket("p", a.id, { status: "ready" });
  await board.whenIdle();
  expect(readArgs().at(-1)!.args.join(" ")).toContain("--max-budget-usd 2");
  const b = await board.createTicket("p", { title: "No cap", body: "desc", status: "backlog" });
  await board.updateTicket("p", b.id, { runCapUsd: 0 });
  await board.updateTicket("p", b.id, { status: "ready" });
  await board.whenIdle();
  expect(readArgs().at(-1)!.args).not.toContain("--max-budget-usd");
});
