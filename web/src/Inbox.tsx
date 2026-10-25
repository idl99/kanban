import { useEffect, useRef, useState } from "react";
import type { InboxItem } from "./api";
import { useLayer } from "./layers";
import { MenuSheet } from "./MenuSheet";
import { fullTime, OLD_WAIT_MS, timeUntil, waitedFor } from "./time";
import { useNow } from "./useNow";

/** The entry's open action: Answer when Claude asked something, else Open. */
export const answers = (i: InboxItem) => ["questions", "proposal", "reply", "huddle"].includes(i.attention.kind);
const keyOf = (i: InboxItem) => `${i.profile}/${i.id}`;

/**
 * Top-bar "N need you" across every board, oldest wait first, each with how long it has waited (marked after 8h).
 * Each entry opens its ticket (Answer/Open), marks it done or snoozes it for a day; snoozed ones sit in a collapsed
 * section with time left and Unsnooze. ↑↓ move, Enter opens, d marks done, s snoozes (or unsnoozes), Esc closes.
 */
export function Inbox({ items, snoozed = [], onPick, onMarkDone, onSnooze, openRequest }: {
  items: InboxItem[];
  snoozed?: InboxItem[];
  onPick: (i: InboxItem) => void;
  onMarkDone: (i: InboxItem) => void;
  onSnooze: (i: InboxItem, on: boolean) => void;
  openRequest?: number;
}) {
  const [open, setOpen] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
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

  // ⌘K "Open inbox": open the list with the first entry focused.
  useEffect(() => {
    if (!openRequest) return;
    setOpen(true);
    requestAnimationFrame(() => focusAt(0));
  }, [openRequest]);

  const entries = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
  const focusAt = (i: number) => {
    const list = entries();
    if (list.length) list[(i + list.length) % list.length].focus();
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = entries();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusAt(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusAt(at < 0 ? -1 : at - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusAt(0); }
    else if (e.key === "End") { e.preventDefault(); focusAt(-1); }
    else if (e.key === "Tab") setOpen(false);
    else if ((e.key.toLowerCase() === "d" || e.key.toLowerCase() === "s") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const key = list[at]?.dataset.entry;
      const i = key && [...items, ...snoozed].find((x) => keyOf(x) === key);
      if (!i) return;
      e.preventDefault();
      if (e.key.toLowerCase() === "d") onMarkDone(i);
      else onSnooze(i, !i.snoozedUntil);
      // The next entry moves up into this place.
      requestAnimationFrame(() => focusAt(Math.min(at, entries().length - 1)));
    }
  };

  // The last entry went (done, snoozed or answered elsewhere): close, or the menu's layer would stay stacked.
  const empty = !items.length && !snoozed.length;
  useEffect(() => {
    if (empty) setOpen(false);
  }, [empty]);

  const now = useNow();
  if (empty) return null;
  const several = new Set([...items, ...snoozed].map((i) => i.profile)).size > 1;
  const sorted = [...items].sort((a, b) => a.attention.since.localeCompare(b.attention.since));
  const later = [...snoozed].sort((a, b) => a.snoozedUntil!.localeCompare(b.snoozedUntil!));
  const pick = (i: InboxItem) => { setOpen(false); onPick(i); };

  return (
    <div className="inbox" ref={root}>
      <button ref={pill} className="inbox-pill" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => focusAt(0));
          }
        }}
        title="Tickets on any board where Claude is waiting on you">
        {items.length ? <><span className="yt-dot" aria-hidden /> {items.length} need you</> : <>{snoozed.length} snoozed</>}
      </button>
      {open && (
        <MenuSheet onClose={() => setOpen(false)}>
          <div className="inbox-menu" role="menu" ref={menu} onKeyDown={onMenuKey}>
            {!items.length && <p className="inbox-empty muted small">Nothing needs you right now.</p>}
            {sorted.map((i) => {
              const old = now - new Date(i.attention.since).getTime() > OLD_WAIT_MS;
              return (
                <div key={keyOf(i)} className="inbox-entry">
                  <button role="menuitem" data-entry={keyOf(i)} className="inbox-item" onClick={() => pick(i)}
                    title={`Enter ${answers(i) ? "answers" : "opens"} · d marks done · s snoozes for a day`}>
                    <span className="inbox-title">{i.title}</span>
                    <span className="inbox-row">
                      <span className={`inbox-why att-${i.attention.kind}`}>
                        {i.attention.label}{several && <span className="inbox-board-name"> · {i.profileName}</span>}
                      </span>
                      <time className={`inbox-age${old ? " old" : ""}`} dateTime={i.attention.since} title={`Waiting since ${fullTime(i.attention.since)}`}>
                        waiting {waitedFor(i.attention.since, now)}
                      </time>
                    </span>
                  </button>
                  <span className="inbox-actions">
                    <button className="btn small primary" tabIndex={-1} onClick={() => pick(i)} title="Open the ticket (Enter)">{answers(i) ? "Answer" : "Open"}</button>
                    <button className="btn small" tabIndex={-1} onClick={() => onMarkDone(i)} title="Move it to Done (d)">Mark done</button>
                    <button className="btn small ghost" tabIndex={-1} onClick={() => onSnooze(i, true)} title="Hide it from the Inbox and counts for a day, or until something changes (s)">Snooze</button>
                  </span>
                </div>
              );
            })}
            {later.length > 0 && (
              <>
                <button role="menuitem" className="inbox-board inbox-snoozed-toggle" aria-expanded={showSnoozed} onClick={() => setShowSnoozed((v) => !v)}>
                  {showSnoozed ? "▾" : "▸"} Snoozed · {later.length}
                </button>
                {showSnoozed && later.map((i) => (
                  <div key={keyOf(i)} className="inbox-entry snoozed">
                    <button role="menuitem" data-entry={keyOf(i)} className="inbox-item" onClick={() => pick(i)} title="Enter opens · s unsnoozes · d marks done">
                      <span className="inbox-title">{i.title}</span>
                      <span className="inbox-row">
                        <span className="inbox-why muted">
                          {i.attention.label}{several && <span className="inbox-board-name"> · {i.profileName}</span>}
                        </span>
                        <time className="inbox-age" dateTime={i.snoozedUntil} title={`Snoozed until ${fullTime(i.snoozedUntil!)}`}>
                          back {timeUntil(i.snoozedUntil!)}
                        </time>
                      </span>
                    </button>
                    <span className="inbox-actions">
                      <button className="btn small ghost" tabIndex={-1} onClick={() => onSnooze(i, false)} title="Back in the Inbox now (s)">Unsnooze</button>
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </MenuSheet>
      )}
    </div>
  );
}
