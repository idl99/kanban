import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";
import { makeRepo, tempDir } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");

let store: Store;
let bus: Bus;
let board: Board;
let notes: string[];

beforeEach(async () => {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  notes = [];
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false, notify: (t) => notes.push(t), planWakeDelayMs: 300 });
  const p: Profile = { name: "P", slug: "p", path: await makeRepo(), baseBranch: "main", maxParallel: 5, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p);
  // Fake claude saves its sessions here, so runs can resume them.
  process.env.CLAUDE_CONFIG_DIR = tempDir("ck-claude-");
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_ARGS_FILE = join(tempDir("ck-args-"), "args.jsonl");
  delete process.env.FAKE_PR;
});

afterEach(async () => {
  await board.shutdown();
  delete process.env.FAKE_BLOCK_MATCH;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.FAKE_STEP_MS;
}, 15000);

/** Wait until no run is left and no wake-up is pending. */
async function settle(ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    await board.whenIdle();
    await Bun.sleep(500);
    if (!(board as any).runs.size) return;
    if (Date.now() > end) throw new Error("plan did not settle");
  }
}

test("a plan runs its children in dependency order, at most maxConcurrent at once, then the final check", async () => {
  process.env.FAKE_STEP_MS = "40";
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "backlog" });
  const mk = (title: string, planKey: string, dependsOn?: string[]) =>
    board.createTicket("p", { title, body: "", status: "backlog", parentId: planner.id, planKey, dependsOn });
  const a = await mk("A", "a");
  const b = await mk("B", "b", ["a"]);
  const c = await mk("C", "c", ["a"]);
  const d = await mk("D", "d", ["b", "c"]);
  const e = await mk("E", "e");
  const order: string[] = [];
  const live = new Set<string>();
  let peak = 0;
  bus.on((ev) => {
    if (ev.type !== "ticket.updated" || ev.ticket.parentId !== planner.id) return;
    if (ev.ticket.status === "in_progress" && !live.has(ev.ticket.id)) {
      live.add(ev.ticket.id);
      order.push(ev.ticket.title);
      peak = Math.max(peak, live.size);
    } else if (ev.ticket.status !== "in_progress") live.delete(ev.ticket.id);
  });

  board.startPlan("p", planner.id);
  expect(store.getTicket("p", b.id)!.mode).toBe("auto");
  await settle();

  expect(order.slice(0, 2).sort()).toEqual(["A", "E"]);
  expect(order.at(-1)).toBe("D");
  expect(order.indexOf("B")).toBeLessThan(order.indexOf("D"));
  expect(order.indexOf("C")).toBeLessThan(order.indexOf("D"));
  expect(peak).toBeLessThanOrEqual(2);
  for (const k of [a, b, c, d, e]) expect(store.getTicket("p", k.id)!.outcome).toBe("done");
  const p = store.getTicket("p", planner.id)!;
  expect(p.plan?.state).toBe("done");
  // Wake-ups put the planner back in its column and leave its own PR link alone.
  expect(p.status).toBe("backlog");
  expect(p.prUrl).toBeNull();
  // Only the final check woke the planner.
  expect(p.plan?.wakeups).toBe(1);
  expect(notes).toEqual(["Plan done: Plan"]);
});

test("children failing together wake the planner once; an unresolved dead end makes the plan stuck", async () => {
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "backlog" });
  await board.createTicket("p", { title: "X-fail", body: "", status: "backlog", parentId: planner.id });
  await board.createTicket("p", { title: "Y-fail", body: "", status: "backlog", parentId: planner.id });
  // Child runs (their prompt has "# Ticket: <title>") end blocked; the planner answers "done", so the dead end shows.
  process.env.FAKE_BLOCK_MATCH = "# Ticket: ";
  board.startPlan("p", planner.id);
  await settle();
  const p = store.getTicket("p", planner.id)!;
  expect(p.plan?.wakeups).toBe(1);
  expect(p.plan?.state).toBe("stuck");
  expect(p.plan?.reason).toContain("nothing can run");
  // A stuck plan needs the user: the Notifier (notify.ts) tells them, not a board banner.
  expect(notes).toEqual([]);
  const wake = store.listComments("p", planner.id).find((c) => c.text.startsWith("Plan stuck"));
  expect(wake).toBeDefined();
});

test("startPlan refuses cycles and plans without children", async () => {
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "backlog" });
  expect(() => board.startPlan("p", planner.id)).toThrow(/no child tickets/);
  await board.createTicket("p", { title: "X", body: "", status: "backlog", parentId: planner.id, planKey: "x", dependsOn: ["y"] });
  await board.createTicket("p", { title: "Y", body: "", status: "backlog", parentId: planner.id, planKey: "y", dependsOn: ["x"] });
  expect(() => board.startPlan("p", planner.id)).toThrow(/dependency cycle/);
  expect(store.getTicket("p", planner.id)!.plan).toBeUndefined();
});

/** A planner whose plan is stuck, with children in the given columns. */
async function stuckPlan(...statuses: ("backlog" | "review" | "done")[]) {
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "review" });
  const kids = [];
  for (const [i, s] of statuses.entries()) kids.push(await board.createTicket("p", { title: `K${i}`, body: "", status: s, parentId: planner.id }));
  store.updateTicket("p", planner.id, {
    plan: { state: "stuck", maxConcurrent: 2, wakeups: 1, startedAt: "", originalCount: kids.length, inbox: [], seen: {}, retries: {}, awaiting: null, reason: "the planner's run is blocked" },
  });
  return { planner, kids };
}

test("a stuck plan closes without a run once its last child is done", async () => {
  const { planner, kids } = await stuckPlan("done", "review");
  board.advancePlans("p");
  expect(store.getTicket("p", planner.id)!.plan?.state).toBe("stuck");
  await board.updateTicket("p", kids[1].id, { status: "done" });
  const p = store.getTicket("p", planner.id)!;
  expect(p.plan?.state).toBe("done");
  expect(p.plan?.reason).toBeNull();
  expect(p.runCount).toBe(0);
  expect(store.listComments("p", planner.id).at(-1)!.text).toContain("stuck plan was closed");
});

test("startup clears a stuck plan whose children are all done", async () => {
  const { planner } = await stuckPlan("done", "done");
  board.recover();
  expect(store.getTicket("p", planner.id)!.plan?.state).toBe("done");
  expect(store.getTicket("p", planner.id)!.runCount).toBe(0);
});

test("Mark plan done closes a stuck plan with open children, without waking the planner", async () => {
  const { planner, kids } = await stuckPlan("done", "backlog");
  const t = board.markPlanDone("p", planner.id);
  expect(t.plan?.state).toBe("done");
  expect(t.plan?.finishedAt).toBeTruthy();
  expect(t.runCount).toBe(0);
  expect(store.getTicket("p", kids[1].id)!.status).toBe("backlog");
  expect(store.listComments("p", planner.id).at(-1)!.text).toBe("Plan marked done.");
  expect(() => board.markPlanDone("p", kids[0].id)).toThrow(/no plan/);
});

/** Tracks which tickets are In progress at once (by title). */
function liveTracker() {
  const live = new Set<string>();
  const overlaps: string[][] = [];
  bus.on((ev) => {
    if (ev.type !== "ticket.updated") return;
    if (ev.ticket.status === "in_progress") live.add(ev.ticket.title);
    else live.delete(ev.ticket.title);
    overlaps.push([...live].sort());
  });
  return overlaps;
}

test("children that need the emulator run one at a time; a child without needs runs alongside", async () => {
  process.env.FAKE_STEP_MS = "60";
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "backlog" });
  const mk = (title: string, needs?: string[]) => board.createTicket("p", { title, body: "", status: "backlog", parentId: planner.id, needs });
  const kids = [await mk("E1", ["Emulator "]), await mk("E2", ["emulator"]), await mk("E3", ["emulator"]), await mk("Free")];
  expect(kids[0].needs).toEqual(["emulator"]);
  const seen = liveTracker();
  board.startPlan("p", planner.id, { maxConcurrent: 3 });
  // Right away: one E child holds the emulator (whichever the plan picked first), the other two wait for it in Backlog.
  const emuKids = kids.slice(0, 3).map((k) => store.getTicket("p", k.id)!);
  const holders = emuKids.filter((t) => board.resourceState("p", t)?.holding);
  expect(holders.length).toBe(1);
  for (const t of emuKids.filter((t) => t.id !== holders[0].id)) {
    expect(board.resourceState("p", t)).toEqual({ holding: false, waitingFor: ["emulator"] });
    expect(t.status).toBe("backlog");
  }
  await settle();
  const emu = (s: string[]) => s.filter((t) => t.startsWith("E")).length;
  expect(Math.max(...seen.map(emu))).toBe(1);
  expect(seen.some((s) => s.includes("Free") && emu(s) === 1)).toBe(true);
  for (const k of kids) expect(store.getTicket("p", k.id)!.outcome).toBe("done");
  expect(store.getTicket("p", planner.id)!.plan?.state).toBe("done");
}, 30000);

test("tickets on different boards that need the same resource never run at the same time", async () => {
  process.env.FAKE_STEP_MS = "40";
  const p2: Profile = { name: "Q", slug: "q", path: await makeRepo(), baseBranch: "main", maxParallel: 5, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p2);
  const seen = liveTracker();
  const a = await board.createTicket("p", { title: "A", body: "", status: "ready", needs: ["emulator"] });
  const b = await board.createTicket("q", { title: "B", body: "", status: "ready", needs: ["emulator"] });
  const c = await board.createTicket("q", { title: "C", body: "", status: "ready" });
  // B keeps its place in Ready while A has the emulator; C (no needs) starts anyway.
  expect(board.isRunning("q", b.id)).toBe(false);
  expect(board.resourceState("q", store.getTicket("q", b.id)!)).toEqual({ holding: false, waitingFor: ["emulator"] });
  expect(board.isRunning("q", c.id)).toBe(true);
  await settle();
  expect(seen.some((s) => s.includes("A") && s.includes("B"))).toBe(false);
  expect(store.getTicket("p", a.id)!.outcome).toBe("done");
  expect(store.getTicket("q", b.id)!.outcome).toBe("done");
}, 30000);

test("a plan never starts a child waiting on the user, and stops naming it once nothing else is left", async () => {
  (board as any).sessionSummary = (sid: string) => (sid === "s-asks" ? { openQuestions: 2, pendingProposal: null } : null);
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "backlog" });
  const asks = await board.createTicket("p", { title: "Asks", body: "", status: "backlog", parentId: planner.id });
  store.updateTicket("p", asks.id, { sessionId: "s-asks" });
  const ok = await board.createTicket("p", { title: "Ok", body: "", status: "backlog", parentId: planner.id });
  board.startPlan("p", planner.id);
  await settle();
  expect(store.getTicket("p", asks.id)!.status).toBe("backlog");
  expect(store.getTicket("p", ok.id)!.outcome).toBe("done");
  const p = store.getTicket("p", planner.id)!;
  expect(p.plan?.state).toBe("stuck");
  expect(p.plan?.reason).toBe('waiting for you: "Asks" (2 questions for you)');
}, 30000);

test("adopting existing tickets: skip reasons, a growing plan, and releasing", async () => {
  const grand = await board.createTicket("p", { title: "Grand", body: "", status: "backlog" });
  const mgr = await board.createTicket("p", { title: "Manager", body: "", status: "review", parentId: grand.id });
  const other = await board.createTicket("p", { title: "Other plan", body: "", status: "backlog" });
  const a = await board.createTicket("p", { title: "A", body: "", status: "backlog", needs: ["emulator"] });
  const b = await board.createTicket("p", { title: "B", body: "", status: "review" });
  const taken = await board.createTicket("p", { title: "Taken", body: "", status: "backlog", parentId: other.id });
  const fin = await board.createTicket("p", { title: "Fin", body: "", status: "done" });
  const r = board.adoptTickets("p", mgr.id, [a.id, b.id, taken.id, fin.id, mgr.id, grand.id, "t_nope", a.id]);
  expect(r.adopted.map((t) => t.title)).toEqual(["A", "B"]);
  expect(r.skipped).toEqual([
    { id: taken.id, reason: `belongs to plan ${other.id}` },
    { id: fin.id, reason: "already done" },
    { id: mgr.id, reason: "that is this ticket itself" },
    { id: grand.id, reason: "it is a parent of this ticket (that would make a cycle)" },
    { id: "t_nope", reason: "not found on board p" },
  ]);
  // Adopted tickets keep column and needs, and nothing starts.
  expect(store.getTicket("p", a.id)).toMatchObject({ parentId: mgr.id, status: "backlog", needs: ["emulator"] });
  expect(store.getTicket("p", b.id)!.status).toBe("review");
  expect(store.listComments("p", a.id).at(-1)!.text).toContain(`Adopted by plan ${mgr.id}`);
  expect(board.adoptTickets("p", mgr.id, [a.id]).skipped).toEqual([{ id: a.id, reason: "already in this plan" }]);

  // B waits for A; A can't leave the plan while B depends on it.
  await board.updateTicket("p", b.id, { dependsOn: [a.id] });
  await expect(board.updateTicket("p", a.id, { parentId: null })).rejects.toThrow(/"B" depends on this ticket/);
  await board.updateTicket("p", b.id, { parentId: null });
  expect(store.getTicket("p", b.id)).toMatchObject({ parentId: null, dependsOn: [] });

  // A plan under way counts adopted tickets toward its caps.
  board.startPlan("p", mgr.id);
  board.pausePlan("p", mgr.id);
  const before = store.getTicket("p", mgr.id)!.plan!.originalCount;
  const c = await board.createTicket("p", { title: "C", body: "", status: "backlog" });
  board.adoptTickets("p", mgr.id, [c.id]);
  expect(store.getTicket("p", mgr.id)!.plan!.originalCount).toBe(before + 1);
}, 30000);

test("planner rights: a reply to the user's own chat message, or any run of a running plan", async () => {
  process.env.FAKE_STEP_MS = "100";
  const mgr = await board.createTicket("p", { title: "Manager", body: "", status: "review" });
  expect(board.plannerRights("p", mgr.id)).toBeNull();
  await board.chat("p", mgr.id, "manage tickets A and B");
  expect(board.userChatRun("p", mgr.id)).toBe(true);
  expect(board.plannerRights("p", mgr.id)?.id).toBe(mgr.id);
  await settle();
  expect(board.plannerRights("p", mgr.id)).toBeNull();
  // A message from a planner's run (chat_ticket) doesn't hand rights on.
  await board.chat("p", mgr.id, "from the planner", { fromPlanner: true });
  expect(board.isRunning("p", mgr.id)).toBe(true);
  expect(board.plannerRights("p", mgr.id)).toBeNull();
  await settle();
  // An ordinary work run doesn't either.
  const w = await board.createTicket("p", { title: "Work", body: "", status: "ready" });
  expect(board.isRunning("p", w.id)).toBe(true);
  expect(board.plannerRights("p", w.id)).toBeNull();
  await settle();
  // A plan that is done: the user's own message still grants rights (tidy up its children), wake-ups don't.
  store.updateTicket("p", mgr.id, { plan: { state: "done", maxConcurrent: 2, wakeups: 0, startedAt: "", originalCount: 1 } });
  await board.chat("p", mgr.id, "mark all children done");
  expect(board.plannerRights("p", mgr.id)?.id).toBe(mgr.id);
  await settle();
  await board.chat("p", mgr.id, "from the planner", { fromPlanner: true });
  expect(board.plannerRights("p", mgr.id)).toBeNull();
  await settle();
}, 30000);

test("user-request rights: only a Planning chat's reply to the user's own message", async () => {
  process.env.FAKE_STEP_MS = "100";
  const t = await board.createTicket("p", { title: "Shape me", body: "", status: "backlog" });
  expect(board.userRequestRights("p", t.id)).toBeNull();
  await board.chat("p", t.id, "move X to done");
  expect(board.userRequestRights("p", t.id)?.id).toBe(t.id);
  await settle();
  expect(board.userRequestRights("p", t.id)).toBeNull();
  // A message from another run (chat_ticket) doesn't hand the user's rights on.
  await board.chat("p", t.id, "from a run", { fromPlanner: true });
  expect(board.isRunning("p", t.id)).toBe(true);
  expect(board.userRequestRights("p", t.id)).toBeNull();
  await settle();
  // A chat outside Backlog/Planning acts (bypassPermissions) and keeps the planner-only rights.
  const r = await board.createTicket("p", { title: "Reviewed", body: "", status: "review" });
  await board.chat("p", r.id, "move X to done");
  expect(board.userChatRun("p", r.id)).toBe(true);
  expect(board.userRequestRights("p", r.id)).toBeNull();
  await settle();
}, 30000);
