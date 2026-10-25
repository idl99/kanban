import { useEffect, useState, type RefObject } from "react";
import { shrinkStep, type ShrinkState } from "./shrinkStep";

/** The feeds whose scrolling shrinks the ticket header: the chat log and the huddle log. */
const FEEDS = ".chat-log, .huddle-log";
/** A scroll counts as the user's when it follows their input by this long (ms). */
const INPUT_MS = 600;
/** After a change, scrolls are ignored this long (ms): the feed resizes while the header animates. */
const SETTLE_MS = 320;

/**
 * The ticket header shrinks to one line while the user scrolls the chat or huddle feed down inside `root`, and
 * comes back when they scroll up or reach the top. Off (full header) when `enabled` is false; a new `view` (another
 * tab) starts full again.
 */
export function useShrinkHeader(root: RefObject<HTMLElement | null>, enabled: boolean, view?: string): boolean {
  const [slim, setSlim] = useState(false);
  useEffect(() => {
    setSlim(false);
    const el = root.current;
    if (!enabled || !el) return;
    let state: ShrinkState = { slim: false, down: 0, up: 0 };
    let inputAt = 0;
    let settleUntil = 0;
    const last = new WeakMap<Element, number>();
    const input = () => void (inputAt = performance.now());
    const onScroll = (e: Event) => {
      const t = e.target;
      if (!(t instanceof HTMLElement) || !t.matches(FEEDS)) return;
      const y = t.scrollTop;
      const dy = y - (last.get(t) ?? y);
      last.set(t, y);
      const now = performance.now();
      const next = shrinkStep(state, { y, dy, user: now - inputAt < INPUT_MS && now >= settleUntil });
      if (next.slim !== state.slim) {
        settleUntil = now + SETTLE_MS;
        setSlim(next.slim);
      }
      state = next;
    };
    const opts = { capture: true, passive: true };
    const inputs = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
    for (const k of inputs) el.addEventListener(k, input, opts);
    el.addEventListener("scroll", onScroll, opts);
    return () => {
      for (const k of inputs) el.removeEventListener(k, input, opts);
      el.removeEventListener("scroll", onScroll, opts);
    };
  }, [enabled, root, view]);
  return enabled && slim;
}
