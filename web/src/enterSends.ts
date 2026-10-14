/** Minimal slice of KeyboardEvent that enterSends looks at (keeps it testable without a DOM). */
export type EnterKeyLike = { key: string; shiftKey: boolean; nativeEvent: { isComposing: boolean } };

/** Touch screen without a mouse: a phone (or tablet) typing on its on-screen keyboard. */
const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

// globalThis, not window: the server typecheck (no DOM types) also sees this file through its test.
const isTouch = () => !!(globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia?.(TOUCH_QUERY).matches;

/**
 * Whether this keydown should send the message. Enter sends and Shift+Enter adds a new line, except on
 * touch screens: on-screen keyboards have no Shift, so there Enter adds a new line and the Send button sends.
 */
export function enterSends(e: EnterKeyLike, touch = isTouch()): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touch;
}
