import { useEffect, useRef, useState } from "react";
import { useLayer } from "./layers";
import { fullTime, timeAgo } from "./time";
import { useNow } from "./useNow";
import { costText, pillText, resetText, shortLabel, usageTone, worstTone } from "./usage";
import type { UsageState } from "./useUsage";

/** Header pill with Claude plan usage and what all boards spent today (data from useUsage, shared with the phone UsageBox). */
export function UsagePill({ state, openRequest }: { state: UsageState; openRequest?: number }) {
  const { usage, loading, load, spend, loadSpend } = state;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const now = useNow();

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

/** Phone More sheet: Claude plan usage as compact bars; tap for reset times and today's spend. */
export function UsageBox({ state }: { state: UsageState }) {
  const { usage, loading, load, spend } = state;
  const [open, setOpen] = useState(false);
  const now = useNow();
  const failed = !!usage && "error" in usage;
  const windows = usage && !("error" in usage) ? usage.windows : [];

  return (
    <div className="usage-box">
      <div className="usage-box-head">
        <span>Claude plan usage</span>
        <span className="usage-box-updated" title={usage ? fullTime(usage.fetchedAt) : undefined}>
          {usage ? `Updated ${timeAgo(usage.fetchedAt)}` : ""}
        </span>
        <button className="btn small" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "↻ Refresh"}</button>
      </div>
      {usage && "error" in usage && <p className="usage-error">{usage.error}</p>}
      {!usage && <p className="muted small">Loading…</p>}
      {usage && !failed && !windows.length && <p className="muted small">No usage limits reported for this account.</p>}
      {(windows.length > 0 || spend) && (
        <button className="usage-box-body" aria-expanded={open} onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Hide reset times and today's spend" : "Show reset times and today's spend"}>
          {windows.map((w) => (
            <span key={w.key} className="usage-box-row">
              <span className="usage-box-label">{shortLabel(w)}</span>
              <span className="usage-bar"><i className={usageTone(w.percent)} style={{ width: `${w.percent}%` }} /></span>
              <b>{Math.round(w.percent)}%</b>
            </span>
          ))}
          {open && (
            <span className="usage-box-more">
              {windows.map((w) => {
                const reset = resetText(w.resetsAt, now);
                return reset && <span key={w.key} className="usage-sub">{shortLabel(w)}: {reset}</span>;
              })}
              {spend && <>
                <span className="usage-top usage-box-spend"><span>Spent today</span><b>{costText(spend.costUsd)}</b></span>
                {spend.boards.filter((b) => b.costUsd > 0).map((b) => (
                  <span key={b.slug} className="usage-sub spend-row"><span>{b.name}</span><span>{costText(b.costUsd)}</span></span>
                ))}
              </>}
            </span>
          )}
          <span className="usage-box-hint">{open ? "Less" : "Reset times and today's spend"}</span>
        </button>
      )}
    </div>
  );
}
