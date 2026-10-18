// Follow-ups: Claude comes back to its own ticket later; the board wakes the same conversation when it is due.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ticketAttention } from "../src/server/attention";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { FollowUpError, FollowUpWatcher, followUpSpend, followUpTime, parseDelay } from "../src/server/followup";
import { followUpWakePrompt } from "../src/server/prompts";
import { Store } from "../src/server/store";
import type { Profile, Ticket } from "../src/server/types";
import { makeRepo, readJsonl, tempDir, until } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");
let store: Store;
let board: Board;
let clock: Date;
let argsFile: string;

const newBoard = () => new Board(store, new Bus(), { claudeBin: FAKE, isSessionLive: async () => false, now: () => clock });
const prompts = (): string[] => readJsonl(argsFile).map((l) => l.prompt as string);
const wakes = () => prompts().filter((p) => p.includes("⏰ Follow-up")).length;
const at = (iso: string) => (clock = new Date(iso));

async function setup(maxParallel = 1): Promise<Profile> {
  const p: Profile = { name: "P", slug: "p", path: await makeRepo(), baseBranch: "main", maxParallel, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p);
  return p;
}

/** A ticket whose first run is done, in Review (or another column). */
async function worked(status: Ticket["status"] = "review"): Promise<Ticket> {
  const t = await board.createTicket("p", { title: "Pitch email", body: "Send the pitch email", status: "ready" });
  await board.whenIdle();
  if (status !== "review") await board.updateTicket("p", t.id, { status });
  await board.whenIdle();
  return store.getTicket("p", t.id)!;
}

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  clock = new Date("2026-10-19T06:00:00Z");
  board = newBoard();
  argsFile = join(tempDir("ck-args-"), "args.jsonl");
  process.env.FAKE_ARGS_FILE = argsFile;
  process.env.CLAUDE_CONFIG_DIR = tempDir("ck-claude-");
  process.env.FAKE_MODE = "ok";
});

afterEach(async () => {
  await board.shutdown();
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_ARGS_FILE;
  delete process.env.CLAUDE_CONFIG_DIR;
}, 10000);

test("delays and times: after or at, never both, at least a minute away", () => {
  expect(parseDelay("30m")).toBe(30 * 60_000);
  expect(parseDelay("4h")).toBe(4 * 3600_000);
  expect(parseDelay("2 days")).toBe(2 * 24 * 3600_000);
  expect(parseDelay("1d 6h")).toBe(30 * 3600_000);
  expect(parseDelay("soon")).toBeNull();
  const now = new Date(2026, 9, 19, 14, 0);
  expect(followUpTime({ after: "1d" }, now).getTime()).toBe(new Date(2026, 9, 20, 14, 0).getTime());
  expect(followUpTime({ at: "2026-10-20 09:00" }, now).getTime()).toBe(new Date(2026, 9, 20, 9, 0).getTime());
  expect(() => followUpTime({}, now)).toThrow(FollowUpError);
  expect(() => followUpTime({ after: "1h", at: "2026-10-20 09:00" }, now)).toThrow("not both");
  expect(() => followUpTime({ after: "30s" }, now)).toThrow();
  expect(() => followUpTime({ at: "2026-10-19 14:00" }, now)).toThrow("at least 1 minute");
});

test("set, replace and cancel a follow-up; each is logged and commented", async () => {
  await setup();
  const t = await worked();
  expect(() => board.setFollowUp("p", t.id, { after: "1d", note: " " })).toThrow("note is required");
  let u = board.setFollowUp("p", t.id, { after: "1d", note: "Check Gmail for a reply" });
  expect(u.followUp).toMatchObject({ dueAt: "2026-10-20T06:00:00.000Z", note: "Check Gmail for a reply", cancelOnReply: true });
  u = board.setFollowUp("p", t.id, { after: "2d", note: "Check again", cancelOnReply: false });
  expect(u.followUp).toMatchObject({ dueAt: "2026-10-21T06:00:00.000Z", cancelOnReply: false });
  expect(u.followUpLog!.map((e) => e.kind)).toEqual(["set", "set"]);
  expect(store.listComments("p", t.id).at(-1)!.text).toStartWith("Follow-up set for ");

  expect(() => board.cancelFollowUp("p", t.id, "claude", "")).toThrow("reason is required");
  u = board.cancelFollowUp("p", t.id, "claude", "2 nudges, no reply");
  expect(u.followUp).toBeNull();
  expect(u.followUpStopped).toMatchObject({ reason: "2 nudges, no reply" });
  expect(store.listComments("p", t.id).at(-1)!.text).toBe("Stopped following up: 2 nudges, no reply");
  // A new follow-up clears the stopped note; the user's Stop clears both.
  u = board.setFollowUp("p", t.id, { after: "1h", note: "x" });
  expect(u.followUpStopped).toBeNull();
  u = board.cancelFollowUp("p", t.id, "user");
  expect([u.followUp, u.followUpStopped]).toEqual([null, null]);
  expect(u.followUpLog!.at(-1)).toMatchObject({ kind: "cancelled", by: "user" });
}, 15000);

test("the watcher wakes the same conversation when it is due; the card goes back to its column", async () => {
  await setup();
  const t = await worked("done");
  const before = store.getTicket("p", t.id)!;
  board.setFollowUp("p", t.id, { after: "1d", note: "Check Gmail for Michie's reply" });
  const watcher = new FollowUpWatcher(board, store);

  at("2026-10-20T05:59:00Z");
  await watcher.tick();
  expect(wakes()).toBe(0);

  at("2026-10-20T06:00:10Z");
  await watcher.tick();
  await watcher.tick(); // a second tick while it runs doesn't wake it twice
  await board.whenIdle();
  await watcher.tick();
  expect(wakes()).toBe(1);
  const wake = prompts().find((p) => p.includes("⏰ Follow-up"))!;
  expect(wake).toContain("Check Gmail for Michie's reply");
  expect(wake).toContain("This is the first follow-up on this ticket.");
  expect(wake).toContain("cancel_follow_up");
  const args = readJsonl(argsFile);
  expect(args.at(-1).args).toContain("--resume"); // same conversation
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("done");
  expect(got.followUp).toBeNull();
  expect(got.followUpLog!.at(-1)).toMatchObject({ kind: "woke", dueAt: "2026-10-20T06:00:00.000Z" });
  expect(got.followUpLog!.at(-1)!.costUsd).toBeNumber();
  expect(got.runCount).toBe(before.runCount + 1);
  const kinds = store.readActivity("p", t.id).map((a: any) => a.event).filter((e: any) => e?.type === "ckanban_run").map((e: any) => e.kind);
  expect(kinds.at(-1)).toBe("follow-up");
}, 20000);

test("a follow-up waits while the ticket is running and never stacks onto the live run", async () => {
  await setup();
  const t = await worked();
  board.setFollowUp("p", t.id, { after: "1h", note: "Check the deploy" });
  process.env.FAKE_MODE = "slow";
  await board.chat("p", t.id, "also fix the footer");
  await until(() => board.isRunning("p", t.id));
  at("2026-10-19T07:05:00Z");
  expect(board.dueFollowUps("p")).toEqual([]);
  await new FollowUpWatcher(board, store).tick();
  expect(store.getTicket("p", t.id)!.followUp).toBeTruthy();
  expect(store.getTicket("p", t.id)!.queued ?? []).toEqual([]);
  await expect(board.wakeFollowUp("p", t.id, { manual: true })).rejects.toThrow("working on this ticket");

  process.env.FAKE_MODE = "ok";
  board.stop("p", t.id);
  await board.whenIdle();
  expect(board.dueFollowUps("p")).toEqual([t.id]);
  await new FollowUpWatcher(board, store).tick();
  await board.whenIdle();
  expect(wakes()).toBe(1);
}, 20000);

test("a message from the user cancels a cancel-on-reply follow-up; otherwise the next wake hears about it", async () => {
  await setup();
  const t = await worked();
  board.setFollowUp("p", t.id, { after: "1d", note: "Nudge once" });
  board.userReplied("p", t.id);
  let u = store.getTicket("p", t.id)!;
  expect(u.followUp).toBeNull();
  expect(u.followUpLog!.slice(-2).map((e) => e.kind)).toEqual(["replied", "cancelled"]);
  expect(store.listComments("p", t.id).at(-1)!.text).toBe("Follow-up cancelled: you replied.");

  at("2026-10-19T06:10:00Z");
  board.setFollowUp("p", t.id, { after: "1d", note: "Check the inbox", cancelOnReply: false });
  at("2026-10-19T06:20:00Z");
  board.userReplied("p", t.id);
  u = store.getTicket("p", t.id)!;
  expect(u.followUp).toBeTruthy();
  expect(followUpWakePrompt(u, new Date("2026-10-20T06:10:00Z"))).toContain("the user wrote 1 message in this chat");
  // Board wakes (a follow-up's own chat) don't count as replies.
  at("2026-10-20T06:10:00Z");
  await board.wakeFollowUp("p", t.id);
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.followUpLog!.filter((e) => e.kind === "replied")).toHaveLength(2);
}, 20000);

test("moving the card to Done keeps the follow-up; deleting the ticket ends it", async () => {
  await setup();
  const t = await worked();
  board.setFollowUp("p", t.id, { after: "1d", note: "x" });
  await board.updateTicket("p", t.id, { status: "done" });
  expect(store.getTicket("p", t.id)!.followUp).toBeTruthy();
  await board.deleteTicket("p", t.id);
  expect(board.dueFollowUps("p")).toEqual([]);
}, 15000);

test("late follow-ups: a few hours late wakes once and says so; over 12 hours waits for the user", async () => {
  await setup();
  const t = await worked();
  board.setFollowUp("p", t.id, { after: "1h", note: "Check the reply" });
  at("2026-10-19T12:00:00Z"); // 5 hours late
  await new FollowUpWatcher(board, store).tick();
  await board.whenIdle();
  expect(prompts().find((p) => p.includes("⏰ Follow-up"))).toContain("5 hours late");

  const u = await worked();
  board.setFollowUp("p", u.id, { after: "1h", note: "Check the reply" });
  at("2026-10-20T06:00:00Z"); // 17 hours late
  await new FollowUpWatcher(board, store).tick();
  await board.whenIdle();
  const missed = store.getTicket("p", u.id)!;
  expect(missed.followUp!.missedAt).toBe("2026-10-20T06:00:00.000Z");
  expect(wakes()).toBe(1);
  expect(ticketAttention(store, "p", missed, null, false)).toMatchObject({ label: "Missed follow-up" });
  // Seen again: no second comment, still waiting.
  await new FollowUpWatcher(board, store).tick();
  expect(store.listComments("p", u.id).filter((c) => c.text.startsWith("Missed follow-up"))).toHaveLength(1);
  // Done cards ask too.
  await board.updateTicket("p", u.id, { status: "done" });
  expect(ticketAttention(store, "p", store.getTicket("p", u.id)!, null, false)).toMatchObject({ label: "Missed follow-up" });
  // Follow up now still works.
  await board.wakeFollowUp("p", u.id, { manual: true });
  await board.whenIdle();
  expect(wakes()).toBe(2);
  expect(store.getTicket("p", u.id)!.followUp).toBeNull();
  expect(prompts().at(-1)).toContain("the user pressed Follow up now");
}, 25000);

test("follow-ups survive a daemon restart", async () => {
  await setup();
  const t = await worked();
  board.setFollowUp("p", t.id, { after: "2h", note: "Check" });
  await board.shutdown();
  at("2026-10-19T09:00:00Z");
  board = newBoard();
  board.recover();
  await new FollowUpWatcher(board, store).tick();
  await board.whenIdle();
  expect(wakes()).toBe(1);
}, 15000);

test("a follow-up on a Done card that needs the user lands in Review", async () => {
  await setup();
  const t = await worked("done");
  board.setFollowUp("p", t.id, { after: "1h", note: "Draft the nudge" });
  at("2026-10-19T07:00:00Z");
  process.env.FAKE_MODE = "questions";
  await board.wakeFollowUp("p", t.id);
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!).toMatchObject({ status: "review", outcome: "needs_input" });
}, 15000);

test("the wake prompt gives Claude the facts: note, lateness, replies, last seen, earlier follow-ups and cost", () => {
  const t = {
    followUp: { dueAt: "2026-10-21T01:00:00.000Z", note: "Check Gmail", cancelOnReply: true, setAt: "2026-10-20T01:00:00.000Z" },
    followUpLog: [
      { at: "2026-10-19T01:00:00.000Z", kind: "woke" as const, costUsd: 0.12 },
      { at: "2026-10-20T01:00:00.000Z", kind: "woke" as const, costUsd: 0.08 },
    ],
    seenAt: "2026-10-18T01:00:00.000Z",
  };
  const p = followUpWakePrompt(t, new Date("2026-10-21T04:00:00.000Z"));
  expect(p).toContain("\"Check Gmail\"");
  expect(p).toContain("3 hours late");
  expect(p).toContain("no message from the user");
  expect(p).toContain("hasn't opened this card since you set it");
  expect(p).toContain("Earlier follow-ups on this ticket: 2");
  expect(p).toContain("$0.20 in total");
  expect(p).toContain("draft it and end with status \"questions\"");
  expect(p).toContain("CKANBAN_RESULT");
  expect(followUpSpend(t.followUpLog)).toEqual({ count: 2, costUsd: 0.2 });
});

test("a restart that cuts off a follow-up wake resumes it as a follow-up; the card goes back to its column", async () => {
  await setup();
  const t = await worked("done");
  board.setFollowUp("p", t.id, { after: "1h", note: "Check the reply" });
  at("2026-10-19T07:00:00Z");
  process.env.FAKE_MODE = "slow";
  await board.wakeFollowUp("p", t.id);
  await until(() => board.isRunning("p", t.id));
  expect(store.getTicket("p", t.id)!.followUpRun).toEqual({ returnTo: "done" });
  await board.shutdown();
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");

  process.env.FAKE_MODE = "ok";
  board = newBoard();
  board.recover();
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("done");
  expect(got.followUpRun).toBeNull();
  const kinds = store.readActivity("p", t.id).map((a: any) => a.event).filter((e: any) => e?.type === "ckanban_run").map((e: any) => e.kind);
  expect(kinds.at(-1)).toBe("follow-up");
  expect(kinds.filter((k: string) => k === "work")).toHaveLength(1); // never resumed as a work run
  expect(store.listComments("p", t.id).some((c) => c.text === "Follow-up interrupted by daemon restart; resuming.")).toBe(true);
}, 25000);

test("follow-up wakes take a run slot and wait for one; they skip a usage-limit wait", async () => {
  await setup(1);
  const t = await worked();
  board.setFollowUp("p", t.id, { after: "1h", note: "Check" });
  process.env.FAKE_MODE = "slow";
  const busy = await board.createTicket("p", { title: "busy", body: "", status: "ready" });
  await until(() => board.isRunning("p", busy.id));
  at("2026-10-19T07:00:00Z");
  await board.wakeFollowUp("p", t.id);
  expect(board.isRunning("p", t.id)).toBe(false);
  expect(store.getTicket("p", t.id)!.slotWait).toMatchObject({ from: { status: "review" } });
  process.env.FAKE_MODE = "ok";
  board.stop("p", busy.id);
  await until(() => board.isRunning("p", t.id) || store.getTicket("p", t.id)!.runCount > 1);
  await board.whenIdle();
  expect(wakes()).toBe(1);
  expect(store.getTicket("p", t.id)!.status).toBe("review");

  const u = await worked();
  board.setFollowUp("p", u.id, { after: "1h", note: "Check" });
  store.updateTicket("p", u.id, { outcome: "limit", limit: { resetAt: "2026-10-20T00:00:00Z", auto: true, at: "2026-10-19T07:00:00Z", message: "limit" } });
  at("2026-10-19T09:00:00Z");
  expect(board.dueFollowUps("p")).toEqual([]);
}, 25000);

test("a wake that sets no next follow-up leaves a stopped note; bad input is refused", async () => {
  await setup();
  const t = await worked();
  board.setFollowUp("p", t.id, { after: "1h", note: "Check" });
  at("2026-10-19T07:00:00Z");
  await board.wakeFollowUp("p", t.id);
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.followUpStopped).toMatchObject({ reason: "no next follow-up was set" });
  expect(() => board.setFollowUp("p", t.id, { after: "9999999999d", note: "x" })).toThrow(FollowUpError);
  expect(() => board.setFollowUp("p", t.id, { after: "400d", note: "x" })).toThrow("at most a year");
  expect(() => board.setFollowUp("p", t.id, { after: "1d", note: "x".repeat(1001) })).toThrow("too long");
}, 15000);
