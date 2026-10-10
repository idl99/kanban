import { useEffect, useRef, useState } from "react";
import type { InboxItem } from "./api";
import { useLayer } from "./layers";
import { fullTime, OLD_WAIT_MS, waitedFor } from "./time";
import { useNow } from "./useNow";

/**
 * Top-bar "N need you" across every board, oldest wait first, each with how long it has waited (marked after 8h);
 * the list jumps straight to a ticket. ↑↓ move, Esc closes.
 */
export function Inbox({ items, onPick, openRequest }: { items: InboxItem[]; onPick: (i: InboxItem) => void; openRequest?: number }) {
  const [open, setOpen] = useState(false);
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
  };

  const now = useNow();
  if (!items.length) return null;
  const several = new Set(items.map((i) => i.profile)).size > 1;
  const sorted = [...items].sort((a, b) => a.attention.since.localeCompare(b.attention.since));

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
        <span className="yt-dot" aria-hidden /> {items.length} need you
      </button>
      {open && (
        <div className="inbox-menu" role="menu" ref={menu} onKeyDown={onMenuKey}>
          {sorted.map((i) => {
            const old = now - new Date(i.attention.since).getTime() > OLD_WAIT_MS;
            return (
              <button key={`${i.profile}/${i.id}`} role="menuitem" className="inbox-item" onClick={() => { setOpen(false); onPick(i); }}>
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
            );
          })}
        </div>
      )}
    </div>
  );
}
