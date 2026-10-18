import { useCallback, useEffect, useState } from "react";
import { api, subscribe, type TodaySpend } from "./api";
import type { UsageResult } from "./usage";

/** How often today's spend refreshes at most while runs report costs. */
const SPEND_THROTTLE_MS = 15_000;

export interface UsageState {
  usage: UsageResult | null;
  loading: boolean;
  /** Fetch plan usage again (the Refresh button). */
  load: () => void;
  spend: TodaySpend | null;
  loadSpend: () => void;
}

/**
 * Claude plan usage (loads once on page open, then only on Refresh) and what all boards spent today
 * (refreshed as tickets and huddles change, at most every 15 s). Shared by the header pill and the phone More sheet.
 */
export function useUsage(): UsageState {
  const [usage, setUsage] = useState<UsageResult | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.usage()
      .then(setUsage)
      .catch((e: Error) => setUsage({ error: e.message || "Could not reach the board server", fetchedAt: new Date().toISOString() }))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const [spend, setSpend] = useState<TodaySpend | null>(null);
  const loadSpend = useCallback(() => {
    api.spend().then(setSpend).catch(() => {});
  }, []);
  useEffect(() => {
    loadSpend();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = Date.now();
    const off = subscribe((e) => {
      if (e.type !== "ticket.updated" && e.type !== "huddle.updated") return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        loadSpend();
      }, Math.max(0, last + SPEND_THROTTLE_MS - Date.now()));
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [loadSpend]);

  return { usage, loading, load, spend, loadSpend };
}
