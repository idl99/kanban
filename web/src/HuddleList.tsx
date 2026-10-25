import type { Huddle } from "./api";
import { brakeLabel, guestTickets, huddleCost, huddleTitle, members, quietLabel, roundTag, sortHuddles } from "./huddle";
import { fullTime, timeAgo } from "./time";
import { useNow } from "./useNow";
import { costText } from "./usage";

/** Team's Huddles view: live and recent huddles on this board; a row opens that huddle in its host ticket's Huddle tab. */
export function HuddleList({ huddles, onOpen }: { huddles: Huddle[]; onOpen?: (ticketId: string, huddleId: string) => void }) {
  const now = useNow();
  const list = sortHuddles(huddles);
  if (!list.length) {
    return <div className="dock-huddles"><div className="empty">No huddles on this board yet. Start one from a ticket's Huddle tab.</div></div>;
  }
  return (
    <div className="dock-huddles" role="list">
      {list.map((h) => {
        const agents = members(h).length;
        const tickets = 1 + guestTickets(h).length;
        const brake = brakeLabel(h);
        const quiet = quietLabel(h, now);
        const failed = members(h).filter((p) => p.status === "failed").length;
        const forYou = h.status === "closed" ? 0 : h.forYou ?? 0;
        const host = h.hostTitle ?? h.hostTicket;
        const round = roundTag(huddles, h);
        return (
          <button key={h.id} role="listitem" className={`huddle-row ${h.status}${brake ? " brake" : quiet ? " quiet" : ""}`} onClick={() => onOpen?.(h.hostTicket, h.id)}
            title={`Open ${round ? `${round.toLowerCase()} of ` : ""}the huddle of ${host}: ${huddleTitle(h)} · started ${fullTime(h.createdAt)}`}>
            <span className="hr-dot" aria-label={brake ?? (quiet ? "quiet" : h.status)} />
            <span className="hr-title">{host}{round && <span className="hr-round"> · {round}</span>}</span>
            <span className="hr-flags">
              {brake && <span className="hr-brake">Huddle · {brake}</span>}
              {quiet && <span className="hr-quiet">all quiet · {quiet}</span>}
              {failed > 0 && <span className="hb-failed">{failed} failed</span>}
              {forYou > 0 && <span className="for-you-pill">{forYou} for you</span>}
            </span>
            <span className="hr-meta">
              {agents} {agents === 1 ? "agent" : "agents"} · {h.status === "closed" ? "closed" : `${tickets} ${tickets === 1 ? "ticket" : "tickets"}`}
            </span>
            <time className="hr-meta" dateTime={h.updatedAt} title={`Last activity ${fullTime(h.updatedAt)} · ${h.seq} ${h.seq === 1 ? "message" : "messages"}`}>
              {h.status === "live" ? `last msg ${timeAgo(h.updatedAt)}` : timeAgo(h.updatedAt)}
            </time>
            <span className="hr-meta" title="What the huddle's agents have spent">{costText(huddleCost(h))}</span>
          </button>
        );
      })}
    </div>
  );
}
