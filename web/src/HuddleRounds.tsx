import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Huddle } from "./api";
import { huddleCost, huddleRound, huddleTitle, members } from "./huddle";
import { useLayer } from "./layers";
import { MenuSheet } from "./MenuSheet";
import { fullTime } from "./time";

const money = (n: number) => `$${n.toFixed(2)}`;
const PILL = { live: "● Live", stopped: "■ Stopped", closed: "Closed" } as const;
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const hm = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const when = (d: Date) => (sameDay(d, new Date()) ? hm(d) : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${hm(d)}`);

/** "started 14:02" while open; "10 Oct 11:20–12:31" once closed. */
function span(h: Huddle): string {
  const start = new Date(h.createdAt);
  if (h.status !== "closed" || !h.closedAt) return `started ${when(start)}`;
  const end = new Date(h.closedAt);
  return `${when(start)}–${sameDay(start, end) ? hm(end) : when(end)}`;
}

/** "Round 2 · What to improve next" */
export const roundLabel = (list: Huddle[], h: Huddle) => `Round ${huddleRound(list, h)} · ${huddleTitle(h)}`;

/**
 * The huddle bar's round picker, shown once a ticket has two or more huddles: every round newest first (state, who
 * took part, when, cost, findings, its summary), then + New huddle. Earlier rounds open read-only.
 */
export function HuddleRounds({ list, shown, onPick, onNew, onSummary }: {
  /** The ticket's huddles, newest first. */
  list: Huddle[];
  shown: Huddle;
  /** Show this round; null: the current one. */
  onPick: (id: string | null) => void;
  onNew: () => void;
  onSummary: (h: Huddle) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  useLayer(() => close(), { active: open });
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>(".on [role=menuitem], [role=menuitem]:not(:disabled)")?.focus());
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const onKey = (e: KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === "ArrowDown") { e.preventDefault(); go(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(at - 1); }
  };
  const pick = (fn: () => void) => () => { close(false); fn(); };
  const current = list[0];
  const blocked = current && current.status !== "closed" ? current : null;
  const next = list.length + 1;

  return (
    <div className="hd-rounds" ref={root}>
      <button ref={button} className={`hd-rounds-btn${open ? " on" : ""}`} aria-haspopup="menu" aria-expanded={open} title="Switch between this ticket's huddles"
        onClick={() => (open ? close() : setOpen(true))}>
        <span className="hd-rounds-label">{roundLabel(list, shown)}</span> <span aria-hidden>▾</span>
      </button>
      {open && (
        <MenuSheet onClose={() => close(false)}>
          <div className="hd-rounds-menu" role="menu" aria-label="Huddles of this ticket" ref={menu} onKeyDown={onKey}>
            {list.map((h) => {
              const handles = members(h).filter((p) => p.handle !== "main").map((p) => p.handle);
              const n = h.findings.length;
              return (
                <div key={h.id} className={`hd-round${h.id === shown.id ? " on" : ""}`}>
                  <button role="menuitem" className="hd-round-pick" aria-current={h.id === shown.id || undefined}
                    title={`Started ${fullTime(h.createdAt)}${h.closedAt ? ` · closed ${fullTime(h.closedAt)}` : ""}`}
                    onClick={pick(() => onPick(h.id === current?.id ? null : h.id))}>
                    <span className="hd-round-title">{roundLabel(list, h)}</span>
                    <span className="hd-round-meta">
                      {[handles.join(", ") || "no agents", span(h), money(huddleCost(h)), `${n} finding${n === 1 ? "" : "s"}`].join(" · ")}
                    </span>
                  </button>
                  <span className={`hd-round-pill ${h.status}`}>{PILL[h.status]}</span>
                  {h.summary && (
                    <button role="menuitem" className="link-btn hd-round-sum" title={`Open ${h.summary} in Outputs`} onClick={pick(() => onSummary(h))}>summary</button>
                  )}
                </div>
              );
            })}
            <div className="menu-sep" role="separator" />
            <div className="hd-round">
              <button role="menuitem" className="hd-round-pick hd-round-new" disabled={!!blocked} onClick={pick(onNew)}>
                <span className="hd-round-title">+ New huddle</span>
                <span className="hd-round-meta">
                  {blocked ? `Close round ${huddleRound(list, blocked)} first; only one huddle runs at a time` : `Starts round ${next}; earlier rounds stay here, read-only`}
                </span>
              </button>
            </div>
          </div>
        </MenuSheet>
      )}
    </div>
  );
}
