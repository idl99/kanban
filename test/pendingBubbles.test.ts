import { expect, test } from "bun:test";
import { heldByReply, inSession, unsentNow } from "../web/src/pendingBubbles";

test("the message that started a reply shows once: its plain bubble hides the board's held copy", () => {
  const pending = [{ text: "hi", steer: false }];
  expect(heldByReply({ text: "hi", state: "queued" }, pending)).toBe(true);
  // A steering message shows as the board's copy, not twice.
  expect(heldByReply({ text: "hi", state: "queued" }, [{ text: "hi", steer: true }])).toBe(false);
  // Stopped before Claude read it: the unsent bubble shows (with Send, Edit and Discard).
  expect(heldByReply({ text: "hi", state: "unsent" }, pending)).toBe(false);
});

test("Stop before Claude read the reply's message: its plain bubble gives way to the unsent one", () => {
  const stuck = { text: "oops", steer: false };
  const pending = [stuck, { text: "later", steer: false }, { text: "oops", steer: true }];
  expect(unsentNow(pending, [{ text: "oops", state: "unsent" }])).toEqual([stuck]);
  expect(unsentNow(pending, [{ text: "oops", state: "queued" }])).toEqual([]);
  expect(unsentNow(pending, [{ text: "oops", state: "unsent", peer: true }])).toEqual([]);
});

test("a queued message already in the conversation shows once: its timeline copy hides the board's copy", () => {
  const q = { text: "hi", state: "queued" as const, at: "2026-10-19T10:00:00.000Z" };
  const said = (text: string, at: string) => ({ role: "user" as const, text, at });
  expect(inSession(q, [said("hi", "2026-10-19T10:00:02.000Z")])).toBe(true);
  // Not in the conversation yet: the board's copy shows.
  expect(inSession(q, [{ role: "assistant", text: "hi", at: "2026-10-19T10:00:02.000Z" }])).toBe(false);
  // The same text sent earlier doesn't hide a new message.
  expect(inSession(q, [said("hi", "2026-10-19T09:59:00.000Z")])).toBe(false);
  // Stopped before Claude read it: the unsent bubble shows (with Send, Edit and Discard).
  expect(inSession({ ...q, state: "unsent" }, [said("hi", "2026-10-19T10:00:02.000Z")])).toBe(false);
  // Image links reach the session as local file paths.
  const img = "see /api/attachments/0123456789abcdef0123456789abcdef.png";
  expect(inSession({ ...q, text: img }, [said("see /Users/me/.claude-kanban/attachments/0123456789abcdef0123456789abcdef.png", "2026-10-19T10:00:02.000Z")])).toBe(true);
});
