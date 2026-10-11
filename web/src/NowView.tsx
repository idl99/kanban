import type { InboxItem, Ticket } from "./api";
import { elapsed, OLD_WAIT_MS, waitedFor } from "./time";
import { useNow } from "./useNow";

/**
 * Phone home (≤720px), for the board shown: what needs you (the Inbox, oldest wait first), what runs and what is
 * being planned. Other boards that need you are one line at the end. Tapping a card opens the ticket full screen.
 */
export function NowView({ inbox, tickets, slug, onOpen, onMarkDone, onSnooze, onSwitchBoard }: {
  inbox: InboxItem[];
  tickets: Ticket[];
  slug: string;
  onOpen: (profile: string, id: string) => void;
  onMarkDone: (i: InboxItem) => void;
  onSnooze: (i: InboxItem) => void;
  onSwitchBoard: (slug: string) => void;
}) {
  const now = useNow();
  const needs = inbox.filter((i) => i.profile === slug).sort((a, b) => a.attention.since.localeCompare(b.attention.since));
  const elsewhere = [...inbox.filter((i) => i.profile !== slug).reduce((m, i) => {
    const b = m.get(i.profile) ?? { slug: i.profile, name: i.profileName, n: 0 };
    b.n++;
    return m.set(i.profile, b);
  }, new Map<string, { slug: string; name: string; n: number }>()).values()];
  const waiting = new Set(needs.map((i) => i.id));
  const running = tickets.filter((t) => t.running && !waiting.has(t.id));
  const planning = tickets.filter((t) => t.status === "planning" && !t.running && !waiting.has(t.id));

  return (
    <main className="now">
      <h3 className="now-head">Needs you · {needs.length}</h3>
      {needs.length === 0 && <p className="now-empty muted small">Nothing waits on you right now.</p>}
      {needs.map((i) => {
        const answer = i.attention.kind === "questions" || i.attention.kind === "proposal" || i.attention.kind === "reply" || i.attention.kind === "huddle";
        const review = i.attention.kind === "review";
        const old = now - new Date(i.attention.since).getTime() > OLD_WAIT_MS;
        return (
          <div key={`${i.profile}/${i.id}`} className={`now-card need att-${i.attention.kind}`}>
            <button className="now-open" onClick={() => onOpen(i.profile, i.id)}>
              <span className="now-title">{i.title}</span>
              <span className="now-act">
                {i.attention.label}
                <span className={old ? " now-old" : ""}> · {waitedFor(i.attention.since, now)}</span>
              </span>
            </button>
            <div className="now-actions">
              {answer ? (
                <button className="btn primary" onClick={() => onOpen(i.profile, i.id)}>Answer</button>
              ) : (
                <button className={`btn${review ? "" : " primary"}`} onClick={() => onOpen(i.profile, i.id)}>Open</button>
              )}
              {review && <button className="btn primary" onClick={() => onMarkDone(i)}>Mark done</button>}
              <button className="btn ghost" onClick={() => onSnooze(i)} title="Hide it for a day, or until something changes">Snooze</button>
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

      {elsewhere.length > 0 && (
        <div className="now-elsewhere">
          <span className="muted small">Other boards:</span>
          {elsewhere.map((b) => (
            <button key={b.slug} className="chip" onClick={() => onSwitchBoard(b.slug)}>{b.name}<span className="need-chip">{b.n}</span></button>
          ))}
        </div>
      )}
    </main>
  );
}
