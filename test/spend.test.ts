import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { addHuddleSpend, SpendIndex } from "../src/server/spend";
import { Store } from "../src/server/store";
import { ticketRuns } from "../src/server/ticket-usage";
import type { ActivityEntry, Profile } from "../src/server/types";
import { capLabel, capStep, capWait, parseCap } from "../web/src/capText";
import { withActivity } from "../web/src/huddleText";
import { tempDir } from "./helpers";

const NOW = new Date(2026, 9, 11, 15, 0);
const at = (h: number, day = 11) => new Date(2026, 9, day, h, 0).toISOString();
const result = (session: string, total: number) => ({ type: "result", session_id: session, total_cost_usd: total });

function board(store: Store, slug: string) {
  const p: Profile = { name: slug.toUpperCase(), slug, path: "/tmp", baseBranch: "main", maxParallel: 1, createdAt: at(1) };
  store.saveProfile(p);
}

function write(store: Store, slug: string, id: string, entries: ActivityEntry[]) {
  const file = store.activityPath(slug, id);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, entries.map((e) => JSON.stringify(e) + "\n").join(""));
}

test("a ticket's cost is its Usage tab total, read incrementally (running totals per session, kept across resume)", () => {
  const store = new Store(tempDir("ck-spend-"));
  board(store, "a");
  const first: ActivityEntry[] = [
    { run: 1, at: at(9, 10), event: { type: "ckanban_run", kind: "work" } },
    { run: 1, at: at(9, 10), event: { type: "assistant", message: { content: [] } } },
    { run: 1, at: at(10, 10), event: result("s1", 0.4) },
    { run: 2, at: at(9), event: { type: "ckanban_run", kind: "chat" } },
    { run: 2, at: at(10), event: result("s1", 1.0) },
  ];
  write(store, "a", "t1", first);
  const spend = new SpendIndex(store, () => NOW);
  expect(spend.ticket("a", "t1").costUsd).toBeCloseTo(1.0);
  expect(spend.ticket("a", "t1").days.get("2026-10-11")).toBeCloseTo(0.6);

  // A new session (fresh start) starts its own running total; a half-written line waits for the next read.
  const more: ActivityEntry[] = [{ run: 3, at: at(11), event: { type: "ckanban_run", kind: "work" } }, { run: 3, at: at(12), event: result("s2", 0.25) }];
  write(store, "a", "t1", more);
  appendFileSync(store.activityPath("a", "t1"), JSON.stringify({ run: 3, at: at(13), event: result("s2", 0.5) }).slice(0, 30));
  const runs = ticketRuns([...first, ...more]);
  expect(spend.ticket("a", "t1").costUsd).toBeCloseTo(runs.reduce((s, r) => s + r.costUsd, 0));
  expect(spend.ticket("a", "t1").costUsd).toBeCloseTo(1.25);
  appendFileSync(store.activityPath("a", "t1"), JSON.stringify({ run: 3, at: at(13), event: result("s2", 0.5) }).slice(30) + "\n");
  expect(spend.ticket("a", "t1").costUsd).toBeCloseTo(1.5);
  expect(spend.ticket("a", "missing").costUsd).toBe(0);
});

test("today's spend adds every board's tickets and huddle agents since midnight", () => {
  const store = new Store(tempDir("ck-spend-"));
  board(store, "a");
  board(store, "b");
  write(store, "a", "t1", [{ run: 1, at: at(9, 10), event: result("s1", 2) }, { run: 2, at: at(9), event: result("s1", 2.5) }]);
  write(store, "b", "t2", [{ run: 1, at: at(14), event: result("s2", 0.3) }]);
  addHuddleSpend(store.root, "b", 0.2, NOW);
  addHuddleSpend(store.root, "b", 0.1, NOW);
  addHuddleSpend(store.root, "a", 9, new Date(2026, 9, 10, 12));
  const today = new SpendIndex(store, () => NOW).today();
  expect(today.day).toBe("2026-10-11");
  expect(today.costUsd).toBeCloseTo(1.1);
  expect(today.boards.map((b) => [b.slug, Math.round(b.costUsd * 100) / 100])).toEqual([["a", 0.5], ["b", 0.6]]);
});

test("huddle ledger keeps the last 60 days", () => {
  const root = tempDir("ck-spend-");
  writeFileSync(`${root}/spend-days.json`, JSON.stringify(Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`2026-01-${String(i).padStart(3, "0")}`, { a: 1 }]))));
  addHuddleSpend(root, "a", 1, NOW);
  const days = Object.keys(JSON.parse(readFileSync(`${root}/spend-days.json`, "utf8")));
  expect(days.length).toBe(60);
  expect(days.at(-1)).toBe("2026-10-11");
});

test("cap text: parse a typed cap, the blocked state and its continue step", () => {
  expect(parseCap("")).toBeNull();
  expect(parseCap("none")).toBe(0);
  expect(parseCap("$2.50")).toBe(2.5);
  expect(parseCap(".05")).toBe(0.05);
  expect(parseCap("abc")).toBeUndefined();
  const t = { status: "review", outcome: "blocked", running: false, capHit: { capUsd: 0.05, at: at(1) } } as Parameters<typeof capWait>[0];
  expect(capWait(t)).toBe(true);
  expect(capLabel(t)).toBe("Stopped at $0.05 cap");
  expect(capStep(t)).toBe(0.05);
  expect(capWait({ ...t, running: true })).toBe(false);
  expect(capWait({ ...t, capHit: null })).toBe(false);
});

test("withActivity carries a participant's live turn cost", () => {
  const h = { participants: [{ handle: "qa", lastActivity: "Reading" as string | null, liveCostUsd: 0.1 }] };
  const next = withActivity(h, "qa", "Reading", 0.3);
  expect(next.participants[0].liveCostUsd).toBe(0.3);
  expect(withActivity(next, "qa", "Reading", 0.3)).toBe(next);
  expect(withActivity(next, "qa", "Reading")).toBe(next);
});
