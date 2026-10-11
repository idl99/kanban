import { useSyncExternalStore } from "react";

/** Phone layout breakpoint; keep in step with the `max-width: 720px` rules in styles.css. */
export const PHONE_QUERY = "(max-width: 720px)";

const query = typeof window !== "undefined" ? window.matchMedia(PHONE_QUERY) : null;
const subscribe = (fn: () => void) => {
  query?.addEventListener("change", fn);
  return () => query?.removeEventListener("change", fn);
};

/** True on a phone-sized screen (re-renders when the window crosses the breakpoint). */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, () => !!query?.matches);
}
