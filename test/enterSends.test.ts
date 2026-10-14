import { expect, test } from "bun:test";
import { enterSends, type EnterKeyLike } from "../web/src/enterSends";

const ev = (over: Partial<Omit<EnterKeyLike, "nativeEvent">> & { isComposing?: boolean } = {}): EnterKeyLike => ({
  key: over.key ?? "Enter",
  shiftKey: over.shiftKey ?? false,
  nativeEvent: { isComposing: over.isComposing ?? false },
});

test("Enter sends with a keyboard", () => {
  expect(enterSends(ev(), false)).toBe(true);
});

test("Shift+Enter, IME composing and other keys don't send", () => {
  expect(enterSends(ev({ shiftKey: true }), false)).toBe(false);
  expect(enterSends(ev({ isComposing: true }), false)).toBe(false);
  expect(enterSends(ev({ key: "a" }), false)).toBe(false);
});

test("Enter adds a new line on touch screens (no Shift on phone keyboards)", () => {
  expect(enterSends(ev(), true)).toBe(false);
});
