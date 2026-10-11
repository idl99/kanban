import type { InboxItem, Ticket } from "./api";
import { elapsed, OLD_WAIT_MS, waitedFor } from "./time";
import { useNow } from "./useNow";

/**
 * Phone home (≤720px): what needs you on any board (the Inbox, oldest wait first), then what runs and what is
 * being planned on this board. Tapping a card opens the ticket full screen.
 */
export function NowView({ inbox, tickets, slug, onOpen, onMarkDone }: {
  inbox: InboxItem[];
  tickets: Ticket[];
  slug: string;
  onOpen: (profile: string, id: string) => void;
  onMarkDone: (id: string) => void;
}) {
  const now = useNow();
  const needs = [...inbox].sort((a, b) => a.attention.since.localeCompare(b.attention.since));
  const waiting = new Set(inbox.filter((i) => i.profile === slug).map((i) => i.id));
  const running = tickets.filter((t) => t.running && !waiting.has(t.id));
  const planning = tickets.filter((t) => t.status === "planning" && !t.running && !waiting.has(t.id));
  const several = new Set(inbox.map((i) => i.profile)).size > 1 || inbox.some((i) => i.profile !== slug);

  return (
    <main className="now">
      <h3 className="now-head">Needs you · {needs.length}</h3>
      {needs.length === 0 && <p className="now-empty muted small">Nothing waits on you right now.</p>}
      {needs.map((i) => {
        const answer = i.attention.kind === "questions" || i.attention.kind === "proposal" || i.attention.kind === "reply" || i.attention.kind === "huddle";
        const review = i.attention.kind === "review" && i.profile === slug;
        const old = now - new Date(i.attention.since).getTime() > OLD_WAIT_MS;
        return (
          <div key={`${i.profile}/${i.id}`} className={`now-card need att-${i.attention.kind}`}>
            <button className="now-open" onClick={() => onOpen(i.profile, i.id)}>
              <span className="now-title">{i.title}</span>
              <span className="now-act">
                {i.attention.label}{several && <> · {i.profileName}</>}
                <span className={old ? " now-old" : ""}> · {waitedFor(i.attention.since, now)}</span>
              </span>
            </button>
            <div className="now-actions">
              {answer ? (
                <button className="btn primary" onClick={() => onOpen(i.profile, i.id)}>Answer</button>
              ) : (
                <button className={`btn${review ? "" : " primary"}`} onClick={() => onOpen(i.profile, i.id)}>Open</button>
              )}
              {review && <button className="btn primary" onClick={() => onMarkDone(i.id)}>Mark done</button>}
            </div>
          </div>
        );
      })}

      <h3 className="now-head">Running · {running.length}</h3>
      {running.length === 0 && <p className="now-empty muted small">No run active on this board.</p>}
      {running.map((t) => (
        <button key={t.id} className="now-card run now-open" onClick={() => onOpen(slug, t.id)}>
          <span className="now-title">{t.title}</span>
          <span className="now-act">{t.lastActivity || "Claude is working…"}{t.runStartedAt && <> · {elapsed(t.runStartedAt, now)}</>}</span>
        </button>
      ))}

      {planning.length > 0 && (
        <>
          <h3 className="now-head">Planning · {planning.length}</h3>
          {planning.map((t) => (
            <button key={t.id} className="now-card now-open" onClick={() => onOpen(slug, t.id)}>
              <span className="now-title">{t.title}</span>
              <span className="now-act">{t.lastActivity || "Waiting for your reply"}</span>
            </button>
          ))}
        </>
      )}
    </main>
  );
}
