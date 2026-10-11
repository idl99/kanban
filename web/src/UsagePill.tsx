import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribe, type TodaySpend } from "./api";
import { useLayer } from "./layers";
import { fullTime, timeAgo } from "./time";
import { useNow } from "./useNow";
import { costText, pillText, resetText, usageTone, worstTone, type UsageResult } from "./usage";

/** How often today's spend refreshes at most while runs report costs. */
const SPEND_THROTTLE_MS = 15_000;

/**
 * Header pill with Claude plan usage (loads once on page open, then only on Refresh) and what all boards spent today
 * (refreshed as tickets and huddles change, at most every 15 s).
 */
export function UsagePill({ openRequest }: { openRequest?: number } = {}) {
  const [usage, setUsage] = useState<UsageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const now = useNow();

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

  // ⌘K "Usage" opens the panel.
  useEffect(() => {
    if (openRequest) setOpen(true);
  }, [openRequest]);

  useLayer(() => {
    setOpen(false);
    pill.current?.focus();
  }, { active: open });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const failed = !!usage && "error" in usage;
  const windows = usage && !("error" in usage) ? usage.windows : [];
  const tone = failed || !windows.length ? "ok" : worstTone(windows);
  const label = !usage ? "Usage …" : failed ? "Usage unavailable" : windows.length ? pillText(windows) : "Usage · no data";
  const today = spend ? `today ${costText(spend.costUsd)}` : null;
  const spendTitle = spend
    ? `Spent today (API-equivalent $): ${spend.boards.filter((b) => b.costUsd > 0).map((b) => `${b.name} ${costText(b.costUsd)}`).join(" · ") || "nothing yet"}`
    : null;

  return (
    <div className="usage" ref={root}>
      <button ref={pill} className={`pill usage-pill${tone === "ok" ? "" : ` ${tone}`}`} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => { setOpen((v) => !v); loadSpend(); }} title={spendTitle ? `Claude plan usage\n${spendTitle}` : "Claude plan usage"}>
        {label}{today && <span className="usage-today"> · {today}</span>}
      </button>
      {open && (
        <div className="usage-pop" role="dialog" aria-label="Claude plan usage">
          <h4>Claude plan usage</h4>
          {usage && "error" in usage && <p className="usage-error">{usage.error}</p>}
          {!usage && <p className="muted small">Loading…</p>}
          {usage && !failed && !windows.length && <p className="muted small">No usage limits reported for this account.</p>}
          {windows.map((w) => {
            const t = usageTone(w.percent);
            const reset = resetText(w.resetsAt, now);
            return (
              <div key={w.key} className="usage-row">
                <div className="usage-top"><span>{w.label}</span><b>{Math.round(w.percent)}%</b></div>
                <div className="usage-bar"><i className={t} style={{ width: `${w.percent}%` }} /></div>
                {reset && <div className="usage-sub" title={w.resetsAt ? fullTime(w.resetsAt) : undefined}>{reset}</div>}
              </div>
            );
          })}
          {spend && (
            <div className="usage-spend">
              <div className="usage-top"><span>Spent today</span><b>{costText(spend.costUsd)}</b></div>
              {spend.boards.filter((b) => b.costUsd > 0).map((b) => (
                <div key={b.slug} className="usage-sub spend-row"><span>{b.name}</span><span>{costText(b.costUsd)}</span></div>
              ))}
              <div className="usage-sub">API-equivalent cost of every board's runs and huddle agents since midnight.</div>
            </div>
          )}
          <div className="usage-foot">
            <span title={usage ? fullTime(usage.fetchedAt) : undefined}>
              {usage ? `Updated ${timeAgo(usage.fetchedAt)}` : ""}
            </span>
            <button className="btn small" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "↻ Refresh"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
