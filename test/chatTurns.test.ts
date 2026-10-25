import { expect, test } from "bun:test";
import { dividerLabel, layoutTurns, stepsSummary } from "../web/src/chatTurns";

const at = (min: number) => new Date(Date.UTC(2026, 9, 25, 6, 0) + min * 60_000).toISOString();
const NOW = Date.UTC(2026, 9, 25, 8, 0);

test("layoutTurns: a new turn on speaker change, after a board note and after a 10 minute pause", () => {
  const l = layoutTurns([
    { speaker: "user", at: at(0) },
    { speaker: "claude", at: at(1), reply: true },
    { speaker: "claude", at: at(2) },
    { speaker: "claude", at: at(3), reply: true },
    { speaker: "board", at: at(4) },
    { speaker: "claude", at: at(5), reply: true },
    { speaker: "peer:t_1", at: at(6) },
    { speaker: "claude", at: at(7), reply: true },
    { speaker: "claude", at: at(20), reply: true },
  ], NOW);
  expect(l.map((x) => x.start)).toEqual([true, true, false, false, true, true, true, true, true]);
  // Only the turn's last reply keeps its actions on a phone.
  expect(l.map((x) => x.lastReply)).toEqual([false, false, false, true, false, true, false, true, true]);
});

test("layoutTurns: a time divider after an hour's pause or a day change, which also starts a new turn", () => {
  const l = layoutTurns([
    { speaker: "claude", at: at(0) },
    { speaker: "claude", at: at(30) },
    { speaker: "claude", at: at(95) },
    { speaker: "claude", at: "" },
  ], NOW);
  expect(l.map((x) => !!x.divider)).toEqual([false, false, true, false]);
  expect(l[2].start).toBe(true);
  expect(l[3].start).toBe(false);
  const days = layoutTurns([{ speaker: "user", at: "2026-10-24T22:00:00" }, { speaker: "user", at: "2026-10-25T00:10:00" }], NOW);
  expect(days[1].divider).toMatch(/^(Today|Yesterday|\w)/);
  expect(days[1].start).toBe(true);
});

test("dividerLabel: Today and Yesterday, else the date", () => {
  const now = new Date(2026, 9, 25, 15, 0).getTime();
  expect(dividerLabel(new Date(2026, 9, 25, 14, 5).toISOString(), now)).toStartWith("Today ");
  expect(dividerLabel(new Date(2026, 9, 24, 9, 12).toISOString(), now)).toStartWith("Yesterday ");
  expect(dividerLabel(new Date(2026, 9, 20, 21, 0).toISOString(), now)).not.toMatch(/Today|Yesterday/);
});

test("stepsSummary: running, done and failed steps", () => {
  const items = [{ text: "Read: a.ts" }, { text: "Bash: bun test", error: true as const }, { text: "Edit: b.ts" }];
  expect(stepsSummary(items, true)).toEqual({ text: "Step 3 · Edit: b.ts", failed: 1 });
  expect(stepsSummary(items, false)).toEqual({ text: "Did 3 steps · Edit: b.ts", failed: 1 });
  expect(stepsSummary([{ text: "Read: a.ts" }], false).text).toBe("Did 1 step · Read: a.ts");
});
