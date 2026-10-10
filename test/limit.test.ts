import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attentionFor } from "../src/server/attention";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { clockTime, dayKey, isLimitText, limitMessage, LimitWatcher, nextFullHour, parseReset } from "../src/server/limit";
import { planStep } from "../src/server/plan";
import { Store } from "../src/server/store";
import type { Plan, Profile, Ticket } from "../src/server/types";
import { makeRepo, tempDir } from "./helpers";

// Real messages from board runs that hit the limit (tickets t_20261005_vqm5, t_20261006_xa17, t_20261005_h89a).
const REAL_4AM = "You've hit your individual spend limit · run /usage-credits to raise it, or visit claude.ai/admin-settings/usage · your session limit resets 4am (Asia/Kuala_Lumpur)";
const REAL_1230AM = "You've hit your individual spend limit · run /usage-credits to raise it, or visit claude.ai/admin-settings/usage · your session limit resets 12:30am (Asia/Kuala_Lumpur)";

// ---- Detection and reset parsing ----

test("recognises limit messages, not Claude talking about limits or API throttling", () => {
  expect(isLimitText(REAL_4AM)).toBe(true);
  expect(isLimitText("Claude AI usage limit reached|1760000000")).toBe(true);
  expect(isLimitText("5-hour limit reached ∙ resets 3pm")).toBe(true);
  expect(isLimitText("You've hit your limit · resets 2pm")).toBe(true);
  expect(isLimitText("API Error: Connection dropped (ECONNRESET)")).toBe(false);
  expect(isLimitText("API Error: 429 rate limit exceeded")).toBe(false);
  expect(isLimitText("retry limit reached: t_1 was already restarted 3 times")).toBe(false);
});

test("limitMessage reads the CLI's API-error events and stderr, never Claude's own text", () => {
  const events = [
    { type: "assistant", message: { content: [{ type: "text", text: "I'll make sure the usage limit is handled" }] } },
    { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: REAL_4AM }] }, error: "rate_limit", is_api_error_message: true },
    { type: "result", is_error: true, api_error_status: 429, result: REAL_4AM },
  ];
  expect(limitMessage(events)).toBe(REAL_4AM);
  expect(limitMessage(events.slice(0, 1))).toBeNull();
  expect(limitMessage([{ type: "result", is_error: false, result: "done; the usage limit check works" }])).toBeNull();
  expect(limitMessage([], "Claude AI usage limit reached|1760000000\n")).toBe("Claude AI usage limit reached|1760000000");
  expect(limitMessage([], "boom: something failed")).toBeNull();
});

test("the reset time of a real message: the next 4am in the zone it names", () => {
  // 18:05 UTC on Oct 6 = 02:05 on Oct 7 in Kuala Lumpur (UTC+8, no DST): resets 4am that morning.
  expect(parseReset(REAL_4AM, new Date("2026-10-06T18:05:12Z")).toISOString()).toBe("2026-10-06T20:00:00.000Z");
  // 21:00 KL: the next 4am is tomorrow.
  expect(parseReset(REAL_4AM, new Date("2026-10-07T13:00:00Z")).toISOString()).toBe("2026-10-07T20:00:00.000Z");
  // 12:30am KL = 16:30 UTC the day before.
  expect(parseReset(REAL_1230AM, new Date("2026-10-06T15:00:00Z")).toISOString()).toBe("2026-10-06T16:30:00.000Z");
});

test("reset times without a zone are local; other formats; fallback to the next full hour", () => {
  const now = new Date(2026, 9, 10, 13, 20);
  expect(parseReset("5-hour limit reached ∙ resets 3pm", now).getTime()).toBe(new Date(2026, 9, 10, 15, 0).getTime());
  expect(parseReset("limit reached · resets 9am", now).getTime()).toBe(new Date(2026, 9, 11, 9, 0).getTime());
  expect(parseReset("weekly limit reached · resets 16:45", now).getTime()).toBe(new Date(2026, 9, 10, 16, 45).getTime());
  expect(parseReset("weekly limit reached · resets Oct 14, 9am", now).getTime()).toBe(new Date(2026, 9, 14, 9, 0).getTime());
  expect(parseReset("Claude AI usage limit reached|1760000000", now).toISOString()).toBe(new Date(1760000000 * 1000).toISOString());
  expect(parseReset("You've hit your usage limit", now).getTime()).toBe(new Date(2026, 9, 10, 14, 0).getTime());
  expect(nextFullHour(new Date(2026, 9, 10, 23, 59)).getTime()).toBe(new Date(2026, 9, 11, 0, 0).getTime());
  expect(clockTime(new Date(2026, 9, 11, 4, 0), now)).toBe("4:00");
});

// ---- Need-you rule and plans ----

function ticket(over: Partial<Ticket> = {}): Ticket {
  const at = "2026-10-10T00:00:00Z";
  return {
    id: "t1", title: "x", status: "review", order: 0, sessionId: "s", worktree: null, branch: null, prUrl: null,
    outcome: "limit", lastActivity: null, lastRunAt: at, runCount: 1, error: REAL_4AM, createdAt: at, updatedAt: at, body: "",
    limit: { resetAt: "2026-10-10T20:00:00Z", auto: true, at, message: REAL_4AM }, ...over,
  };
}

test("waiting with auto on doesn't need the user; auto off does", () => {
  expect(attentionFor(ticket(), null, false)).toBeNull();
  expect(attentionFor(ticket({ limit: { ...ticket().limit!, auto: false } }), null, false)).toMatchObject({ kind: "limit", label: "Limit hit" });
});

test("a plan child waiting on the limit with auto on doesn't wake the planner and keeps its slot", () => {
  const plan: Plan = { state: "running", maxConcurrent: 1, startedAt: "x", wakeups: 0, originalCount: 2, inbox: [], seen: {} } as unknown as Plan;
  const waiting = ticket({ id: "a", parentId: "p" });
  const next = ticket({ id: "b", parentId: "p", status: "backlog", outcome: null, limit: null, runCount: 0 });
  const step = planStep(plan, [waiting, next], () => false);
  expect(step.events).toEqual([]);
  expect(step.start).toEqual([]);
  const off = planStep(plan, [{ ...waiting, limit: { ...waiting.limit!, auto: false } }, next], () => false);
  expect(off.events.map((e) => e.line)).toEqual([expect.stringContaining("hit the usage limit")]);
});

// ---- Board: detect, auto-continue, Continue now, opt-out, restart, daily cap ----

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");
let store: Store;
let board: Board;
let clock: Date;
let argsFile: string;

const newBoard = () => new Board(store, new Bus(), { claudeBin: FAKE, isSessionLive: async () => false, now: () => clock });

async function setup(maxParallel = 1): Promise<Profile> {
  const p: Profile = { name: "P", slug: "p", path: await makeRepo(), baseBranch: "main", maxParallel, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p);
  return p;
}

const prompts = (): string[] => existsSync(argsFile)
  ? readFileSync(argsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l).prompt as string) : [];
const continues = () => prompts().filter((p) => p.startsWith("continue")).length;

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  // 02:05 in Kuala Lumpur: the real message resets at 4am, i.e. 20:00 UTC.
  clock = new Date("2026-10-06T18:05:00Z");
  board = newBoard();
  argsFile = join(tempDir("ck-args-"), "args.jsonl");
  process.env.FAKE_ARGS_FILE = argsFile;
  process.env.CLAUDE_CONFIG_DIR = tempDir("ck-claude-");
  process.env.FAKE_MODE = "limit";
});

afterEach(async () => {
  await board.shutdown();
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_ARGS_FILE;
  delete process.env.CLAUDE_CONFIG_DIR;
}, 10000);

async function hitLimit(title = "x"): Promise<Ticket> {
  const t = await board.createTicket("p", { title, body: "", status: "ready" });
  await board.whenIdle();
  return store.getTicket("p", t.id)!;
}

test("a run that hits the limit is marked limit-hit, not failed, with the reset time", async () => {
  await setup();
  const t = await hitLimit();
  expect(t.outcome).toBe("limit");
  expect(t.status).toBe("review");
  expect(t.limit).toMatchObject({ resetAt: "2026-10-06T20:00:00.000Z", auto: true, message: REAL_4AM });
  const last = store.listComments("p", t.id).at(-1)!.text;
  expect(last).toContain("Usage limit hit");
  expect(last).not.toContain("Run failed");
  expect(board.waitsOnUser("p", t.id)).toBe(false);
}, 15000);

test("with a fake clock, continue is sent once after the reset, and it respects maxParallel", async () => {
  await setup(1);
  const t = await hitLimit();
  const watcher = new LimitWatcher(board, store);
  process.env.FAKE_MODE = "slow";
  // Another ticket takes the only run slot.
  const busy = await board.createTicket("p", { title: "busy", body: "", status: "ready" });
  await Bun.sleep(300);

  clock = new Date("2026-10-06T20:00:30Z"); // reset + 30s: not yet
  await watcher.tick();
  expect(store.getTicket("p", t.id)!.limit).toBeTruthy();

  clock = new Date("2026-10-06T20:01:00Z"); // reset + 1 minute
  await watcher.tick();
  await watcher.tick();
  let got = store.getTicket("p", t.id)!;
  expect(got.limit).toBeNull();
  expect(got.slotWait).toBeTruthy(); // waits for the busy slot
  expect(got.queued).toMatchObject([{ text: "continue", state: "queued" }]);
  expect(board.running("p")).toBe(1);
  expect(got.autoContinued).toEqual({ day: dayKey(clock), count: 1 });

  process.env.FAKE_MODE = "ok";
  board.stop("p", busy.id);
  await Bun.sleep(300);
  await board.whenIdle();
  await watcher.tick();
  expect(continues()).toBe(1);
  got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("done");
}, 20000);

test("Continue now sends at once; any message or a move clears the wait", async () => {
  await setup();
  const t = await hitLimit();
  process.env.FAKE_MODE = "ok";
  await board.continueAfterLimit("p", t.id);
  await board.whenIdle();
  expect(continues()).toBe(1);
  expect(store.getTicket("p", t.id)!).toMatchObject({ outcome: "done", limit: null });
  expect(store.getTicket("p", t.id)!.autoContinued).toBeFalsy(); // not counted toward the daily cap

  process.env.FAKE_MODE = "limit";
  const u = await hitLimit("y");
  expect(u.limit).toBeTruthy();
  await board.updateTicket("p", u.id, { status: "planning" });
  expect(store.getTicket("p", u.id)!.limit).toBeNull();
}, 20000);

test("Don't auto-continue stops the timer and the ticket needs the user", async () => {
  await setup();
  const t = await hitLimit();
  board.setAutoContinue("p", t.id, false);
  expect(store.getTicket("p", t.id)!.limit!.auto).toBe(false);
  expect(board.waitsOnUser("p", t.id)).toBe(true);
  clock = new Date("2026-10-07T00:00:00Z");
  await new LimitWatcher(board, store).tick();
  expect(continues()).toBe(0);
  // Remembered for the next limit hit too.
  process.env.FAKE_MODE = "limit";
  await board.continueAfterLimit("p", t.id);
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.limit).toMatchObject({ auto: false });
}, 15000);

test("the timer survives a daemon restart and a missed reset fires at once", async () => {
  await setup();
  const t = await hitLimit();
  await board.shutdown();
  // Daemon down past the reset; a new one starts hours later.
  clock = new Date("2026-10-07T03:00:00Z");
  process.env.FAKE_MODE = "ok";
  board = newBoard();
  board.recover();
  await new LimitWatcher(board, store).tick();
  await board.whenIdle();
  expect(continues()).toBe(1);
  expect(store.getTicket("p", t.id)!.outcome).toBe("done");
}, 15000);

test("a continue that hits the limit again re-arms; after 3 automatic continues a day it needs the user", async () => {
  await setup();
  // No reset time in the message: the next full hour, so every continue lands on the same (local) day.
  process.env.FAKE_LIMIT_TEXT = "You've hit your usage limit";
  clock = new Date(2026, 9, 7, 9, 5);
  try {
    const t = await hitLimit();
    expect(t.limit!.resetAt).toBe(new Date(2026, 9, 7, 10, 0).toISOString());
    const watcher = new LimitWatcher(board, store);
    for (let i = 1; i <= 3; i++) {
      clock = new Date(new Date(store.getTicket("p", t.id)!.limit!.resetAt).getTime() + 61_000);
      await watcher.tick();
      await board.whenIdle();
      expect(continues()).toBe(i);
      const got = store.getTicket("p", t.id)!;
      expect(got.outcome).toBe("limit");
      expect(got.limit!.auto).toBe(i < 3); // re-armed until the cap
    }
    const got = store.getTicket("p", t.id)!;
    expect(got.autoContinued).toEqual({ day: "2026-10-07", count: 3 });
    expect(got.limit).toMatchObject({ auto: false, capped: true });
    expect(board.waitsOnUser("p", t.id)).toBe(true);
    clock = new Date(clock.getTime() + 3 * 3600_000);
    await watcher.tick();
    expect(continues()).toBe(3);
  } finally {
    delete process.env.FAKE_LIMIT_TEXT;
  }
}, 30000);

// ---- Card and drawer text ----

test("card label: continues at HH:MM with auto on, resets HH:MM with it off", async () => {
  const { limitLabel, limitHint } = await import("../web/src/limitText");
  const now = new Date(2026, 9, 7, 2, 5).getTime();
  const resetAt = new Date(2026, 9, 7, 4, 0).toISOString();
  const t = ticket({ limit: { resetAt, auto: true, at: "x", message: REAL_4AM } }) as any;
  expect(limitLabel(t, now)).toBe("Limit hit · continues at 4:00");
  expect(limitHint(t, now)).toContain("After 4:00 it sends");
  expect(limitLabel({ ...t, limit: { ...t.limit, auto: false } }, now)).toBe("Limit hit · resets 4:00");
  expect(limitHint({ ...t, limit: { ...t.limit, auto: false, capped: true } }, now)).toContain("3 times today");
});
