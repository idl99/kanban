import { useSyncExternalStore } from "react";

// One shared ticker for every relative time on screen ("5m ago" keeps moving without a reload).
let now = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function subscribeNow(fn: () => void) {
  subs.add(fn);
  timer ??= setInterval(() => {
    now = Date.now();
    subs.forEach((f) => f());
  }, 30_000);
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Re-renders the caller every 30s; use around timeAgo(). */
export function useNow(): number {
  return useSyncExternalStore(subscribeNow, () => now);
}
