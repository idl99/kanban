import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type Ticket } from "./api";
import { followUpCount, followUpDate, followUpHistory, followUpLabel, followUpWhen } from "./followUpText";
import { useLayer } from "./layers";
import { MenuSheet } from "./MenuSheet";

const MENU_WIDTH = 340;

/**
 * The card's follow-up badge ("↻ Follows up tomorrow 09:00"): Claude comes back to this ticket by itself. Clicking it
 * opens Claude's note, what happened so far, and Follow up now / Stop following up. After Claude stopped following
 * up, a plain badge says why. The menu is portalled and fixed-positioned like the Share menu, so the column doesn't clip it.
 */
export function FollowUpChip({ slug, ticket, onError, disabled }: {
  slug: string; ticket: Ticket; onError: (msg: string) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"now" | "stop" | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useLayer(close, { active: open });

  // Placed by its measured height: below the badge if it fits, else above, else as high as it fits (it scrolls inside).
  useLayoutEffect(() => {
    if (!open || !button.current || !menu.current) return;
    const r = button.current.getBoundingClientRect();
    const width = Math.min(MENU_WIDTH, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const h = Math.min(menu.current.offsetHeight, window.innerHeight - 16);
    const top = r.bottom + 6 + h <= window.innerHeight - 8 ? r.bottom + 6
      : r.top - 6 - h >= 8 ? r.top - 6 - h
      : Math.max(8, window.innerHeight - 8 - h);
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!button.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) close();
    };
    const onScroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const f = ticket.followUp;
  if (!f) {
    if (!ticket.followUpStopped) return null;
    return (
      <span className="badge follow-up-stopped" title={`Claude stopped following up ${followUpDate(ticket.followUpStopped.at)}`}>
        Stopped following up: {ticket.followUpStopped.reason}
      </span>
    );
  }
  const now = new Date();
  const act = (kind: "now" | "stop") => async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(kind);
    try {
      await (kind === "now" ? api.followUpNow(slug, ticket.id) : api.stopFollowUp(slug, ticket.id));
      close();
    } catch (err: any) {
      onError(err.message);
    } finally {
      setBusy(null);
    }
  };
  const history = followUpHistory(ticket.followUpLog);
  return (
    <>
      <button ref={button} type="button" className={`badge follow-up${f.missedAt ? " missed" : ""}`} aria-haspopup="dialog" aria-expanded={open}
        title={f.note} disabled={disabled}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} onKeyDown={(e) => e.stopPropagation()}>
        <span aria-hidden>↻</span> {followUpLabel(f, now)}
      </button>
      {open && createPortal(
        <MenuSheet onClose={close}>
          <div className="follow-up-menu" role="dialog" aria-label="Follow-up" ref={menu} onClick={(e) => e.stopPropagation()}
            style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}>
            <h3>{f.missedAt ? "Claude missed a follow-up" : "Claude follows up on this ticket"}</h3>
            <div className="fu-when">
              {f.missedAt
                ? `It was due ${followUpDate(f.dueAt)}, while the board was off.`
                : `Next: ${followUpDate(f.dueAt)}${new Date(f.dueAt) > now ? ` (${followUpWhen(f.dueAt, now)})` : ""}`}
            </div>
            <div className="fu-note"><b>Claude's note:</b> {f.note}</div>
            {history.length > 0 && <ul className="fu-hist">{history.map((h, i) => <li key={i}>{h}</li>)}</ul>}
            <div className="fu-row">
              <button className="btn primary small" disabled={!!busy || !!ticket.running} title={ticket.running ? "Claude is working on this ticket" : undefined} onClick={act("now")}>
                {busy === "now" ? "Starting…" : "Follow up now"}
              </button>
              <button className="btn small" disabled={!!busy} onClick={act("stop")}>{busy === "stop" ? "Stopping…" : "Stop following up"}</button>
              <span className="fu-cost">{followUpCount(ticket.followUpLog)}</span>
            </div>
            {f.cancelOnReply && <div className="fu-foot">Writing in this ticket's chat also stops it.</div>}
          </div>
        </MenuSheet>,
        document.body,
      )}
    </>
  );
}
