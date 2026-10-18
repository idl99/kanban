// The follow-up badge and menu words (web/src/followUpText.ts).
import { expect, test } from "bun:test";
import { followUpCount, followUpHistory, followUpLabel, followUpWhen } from "../web/src/followUpText";

const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const now = new Date(2026, 9, 19, 14, 0); // Mon 19 Oct 14:00

test("the badge says when, the way a person would", () => {
  expect(followUpWhen(local(19, 14, 8), now)).toBe("in 8 min");
  expect(followUpWhen(local(19, 18), now)).toBe("in 4 hours");
  expect(followUpWhen(local(19, 22), now)).toBe("today 22:00");
  expect(followUpWhen(local(20, 9), now)).toBe("tomorrow 09:00");
  expect(followUpWhen(local(22, 9), now)).toBe("Thu 09:00");
  expect(followUpWhen(local(30, 9), now)).toBe("30 Oct 09:00");
  expect(followUpLabel({ dueAt: local(20, 9) }, now)).toBe("Follows up tomorrow 09:00");
  expect(followUpLabel({ dueAt: local(19, 13) }, now)).toBe("Follows up soon");
  expect(followUpLabel({ dueAt: local(18, 9), missedAt: local(19, 13) }, now)).toBe("Missed follow-up");
});

test("the menu counts follow-ups and their cost, and tells the history in plain words", () => {
  const log = [
    { at: local(19, 14), kind: "set", dueAt: local(20, 9) },
    { at: local(20, 9), kind: "woke", costUsd: 0.12 },
    { at: local(20, 10), kind: "replied" },
    { at: local(21, 9), kind: "cancelled", by: "claude", note: "2 nudges, no reply" },
  ];
  expect(followUpCount(log)).toBe("1 so far · $0.12");
  expect(followUpCount(undefined)).toBe("0 so far · $0.00");
  expect(followUpHistory(log)).toEqual([
    "Mon 19 Oct 14:00 · Follow-up set for Tue 20 Oct 09:00",
    "Tue 20 Oct 09:00 · Claude followed up ($0.12)",
    "Tue 20 Oct 10:00 · You wrote in the chat",
    "Wed 21 Oct 09:00 · Claude stopped: 2 nudges, no reply",
  ]);
});
