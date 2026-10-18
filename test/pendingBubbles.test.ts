import { expect, test } from "bun:test";
import { heldByReply, unsentNow } from "../web/src/pendingBubbles";

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
