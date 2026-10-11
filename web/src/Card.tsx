import { useEffect, useState } from "react";
import { newestArtifact, safeHref, waitsForSlot, type SessionMessage, type Ticket } from "./api";
import { type CardHuddleBadge, digestPreview } from "./huddleText";
import { ClockIcon, ExternalIcon } from "./icons";
import { KeyHint } from "./KeyHint";
import { CapActions } from "./CapActions";
import { capWait } from "./capText";
import { LimitActions } from "./LimitActions";
import { StallActions, stallWait } from "./StallActions";
import { limitLabel, limitWait } from "./limitText";
import { ResourceChip, resourceWait } from "./Needs";
import { currentPr, prChips } from "./prText";
import { ResolveConflicts } from "./ResolveConflicts";
import { ImportantStar } from "./StarToggle";
import { elapsed, fullTime, plainPreview, timeAgo } from "./time";
import { costText } from "./usage";
import { useNow } from "./useNow";

/** Live running time: ticks every second for the first minute, then every 30s. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now);
  const fresh = now - new Date(since).getTime() < 60_000;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), fresh ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [fresh]);
  return <span className="badge-time" title={`Started ${fullTime(since)}`}> · {elapsed(since, now)}</span>;
}

function workingBadge(label: string, since?: string | null) {
  return <span className="badge running"><span className="spinner" /> {label}{since && <Elapsed since={since} />}</span>;
}

// Shown by the badge already, so the activity line would only repeat it.
const QUIET_ACTIVITY = new Set(["Starting…", "Claude is replying…"]);

/** The ticket's auto huddle: reviewing its work ("Auto huddle · reason"), or waiting for the board's one slot. */
export function autoHuddleChip(a: NonNullable<Ticket["autoHuddle"]>) {
  if (a.state === "waiting") {
    return <span className="badge queued" title={`Another ticket has this board's auto huddle; this one resumes when it ends. Reason: ${a.reason}`}>Waiting for huddle slot</span>;
  }
  return (
    <span className="badge auto-huddle" title={`Claude started a review huddle (${a.template}) before landing: ${a.reason}`}>
      <span className="live-dot" /> Auto huddle · <span className="ah-reason">{a.reason}</span>
    </span>
  );
}

/** In Progress only because it waits for its auto huddle (no run right now). */
export const autoHuddleIdle = (t: Ticket) => !!t.autoHuddle && !t.running;

export function outcomeBadge(t: Ticket) {
  if (autoHuddleIdle(t)) return autoHuddleChip(t.autoHuddle!);
  if (waitsForSlot(t)) return <span className="badge queued" title="Your reply starts when a run slot is free">Queued</span>;
  if (t.status === "in_progress") return workingBadge("Running", t.runStartedAt);
  if (t.running) return workingBadge("Replying", t.runStartedAt);
  if (t.error?.startsWith("corrupt")) return <span className="badge failed">Corrupt file</span>;
  // Done means accepted: an old outcome there doesn't ask anything of the user.
  if (t.status === "done") return null;
  switch (t.outcome) {
    case "blocked": return <span className="badge blocked">Blocked</span>;
    case "needs_input": return <span className="badge blocked">Needs your input</span>;
    case "failed": return <span className="badge failed">Failed</span>;
    case "stopped": return <span className="badge stopped">Stopped</span>;
    case "limit": return <span className="badge limit" title={t.limit?.message ?? t.error ?? undefined}>{limitLabel(t)}</span>;
    case "done": return t.status === "review" ? <span className="badge ok">Ready for review</span> : null;
    default: return null;
  }
}

/** Who wrote the card's last message: huddle digests aren't the user's. */
function lastWho(m: SessionMessage): string {
  if (m.from === "huddle") return "Huddle";
  return m.role === "user" ? "You" : "Claude";
}

/** The card's huddle chip; clicking it opens that ticket's Huddle tab instead of the card. */
function HuddleBadge({ badge, onOpen }: { badge: CardHuddleBadge; onOpen?: (ticketId: string) => void }) {
  return (
    <button type="button" className={`badge huddle ${badge.state}`} title={badge.title}
      onClick={(e) => { e.stopPropagation(); onOpen?.(badge.openTicket); }}
      onKeyDown={(e) => e.stopPropagation()}>
      {badge.state === "live" && <span className="live-dot" />}
      <span aria-hidden>🗣</span> {badge.label}
      {badge.failed > 0 && <span className="hb-failed">· {badge.failed} failed</span>}
      {badge.forYou > 0 && <span className="for-you-pill">{badge.forYou} for you</span>}
    </button>
  );
}

/**
 * queued: 1-based place in the queue for a free run slot (status `ready`, or a reply waiting for one). held: a pending daemon restart holds it.
 * huddle: what the card says about huddles; onOpenHuddle opens a ticket's Huddle tab.
 * limit: the board's slug and error toast, for the usage-limit buttons ("Continue now", auto-continue) and a stalled
 * run's Stop / Keep waiting / Restart.
 */
export function Card({ ticket, onClick, dragging, queued, held, huddle, onOpenHuddle, limit }: {
  ticket: Ticket; onClick?: () => void; dragging?: boolean; queued?: number; held?: boolean;
  huddle?: CardHuddleBadge | null; onOpenHuddle?: (ticketId: string) => void;
  limit?: { slug: string; onError: (msg: string) => void };
}) {
  const working = (ticket.status === "in_progress" && !waitsForSlot(ticket) && !autoHuddleIdle(ticket)) || !!ticket.running;
  const att = ticket.attention ?? null;
  const waitFor = resourceWait(ticket);
  // Its own huddle works on it: the huddle badge says so, not a stale Blocked or Failed.
  const badge = att || (ticket.huddleBusy && huddle) ? null
    : waitFor.length ? <span className="badge wait" title={`Waiting for ${waitFor.join(", ")}: another ticket is using it`}>waiting</span>
    : ticket.folderWait ? <span className="badge wait" title="Tickets on a folder without version history run one at a time; this one starts when the other finishes">waiting: another ticket is using the folder</span>
    : queued && !working ? (held
      ? <span className="badge queued" title="A daemon restart is pending; queued tickets start right after it">Waits for restart</span>
      : <span className="badge queued" title="Starts when a run slot is free">Queued · #{queued}</span>)
    : outcomeBadge(ticket);
  const showActivity = working && ticket.lastActivity && !QUIET_ACTIVITY.has(ticket.lastActivity);
  const last = ticket.session?.lastMessage;
  useNow();
  const lastAt = ticket.session ? ticket.session.lastMessage?.at || ticket.session.updatedAt : null;
  const artifact = newestArtifact(ticket);
  const artifactHref = safeHref(artifact?.url);
  return (
    <article
      className={`card ${dragging ? "dragging" : ""} ${queued && !working ? "is-queued" : ""} ${working ? "is-running" : ""} ${att ? `needs-you att-${att.kind}` : ""}`}
      onClick={onClick}>
      {att && (
        <div className={`your-turn att-${att.kind}`}>
          <span className="yt-dot" aria-hidden />
          <span className="yt-label">Your turn</span>
          <span className="yt-why" title={ticket.error ?? undefined}>{att.kind === "limit" ? limitLabel(ticket) : att.label}</span>
        </div>
      )}
      <KeyHint inset className="card-keys" keys={ticket.status === "review" ? "↵ open · D done · Space move" : "↵ open · Space move"} />
      <div className="card-title" title={ticket.title}>{ticket.important && <ImportantStar />}{ticket.title}</div>
      {showActivity ? (
        <div className="card-activity" title={ticket.lastActivity!}>{ticket.lastActivity}</div>
      ) : last && (
        <div className="card-last" title={last.text}>
          <span className={`who ${last.role}`}>{lastWho(last)}:</span>{" "}
          {plainPreview(last.from === "huddle" ? digestPreview(last.text) : last.text)}
        </div>
      )}
      {(badge || ticket.autoHuddle || ticket.costUsd || ticket.prUrl || ticket.runCount > 0 || ticket.workdir || ticket.session || ticket.scheduleId || ticket.plan || ticket.needs?.length || huddle || artifactHref) && (
        <div className="card-meta">
          {ticket.plan && ticket.plan.state !== "done" && (
            <span className={`badge plan ${ticket.plan.state}`} title="This ticket runs a plan of child tickets">
              Plan {ticket.plan.state === "finishing" ? "final check" : ticket.plan.state}
            </span>
          )}
          {ticket.scheduleId && (
            <span className="badge sched" title="Created by a schedule" aria-label="Scheduled">
              <ClockIcon size={11} strokeWidth={1.8} />
            </span>
          )}
          {ticket.needs?.map((n) => <ResourceChip key={n} name={n} held={!!ticket.resources?.holding} />)}
          {badge}
          {ticket.autoHuddle && working && autoHuddleChip(ticket.autoHuddle)}
          {huddle && <HuddleBadge badge={huddle} onOpen={onOpenHuddle} />}
          {ticket.prUrl && (
            <a className="badge pr" href={safeHref(ticket.prUrl)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              PR #{ticket.prUrl.split("/").pop()}
            </a>
          )}
          {artifact && artifactHref && (
            <a className="badge artifact" href={artifactHref} target="_blank" rel="noreferrer" title={artifact.label === "claude.ai artifact" ? "Open claude.ai artifact" : `Open ${artifact.label} (claude.ai artifact)`}
              aria-label={`Open artifact: ${artifact.label}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <ExternalIcon size={11} /> artifact
            </a>
          )}
          {ticket.status === "review" && prChips(currentPr(ticket)).map((c) => (
            <span key={c.label} className={`badge pr-chip ${c.tone}`} title={c.title}>{c.label}</span>
          ))}
          {ticket.status === "review" && limit && !dragging && currentPr(ticket)?.state === "OPEN" && currentPr(ticket)?.conflicts && (
            <ResolveConflicts slug={limit.slug} ticket={ticket} onError={limit.onError} small />
          )}
          {!!ticket.costUsd && (
            <span className="badge cost" title={`API-equivalent cost of this ticket's runs so far${ticket.runCap ? ` · runs stop at ${costText(ticket.runCap)}` : ""}`}>
              {costText(ticket.costUsd)}
            </span>
          )}
          {ticket.workdir && (ticket.terminalOpen
            ? <span className="badge running" title="This ticket's Claude session is open in a terminal"><span className="live-dot" /> In terminal</span>
            : <span className="badge stopped" title="Linked to an existing Claude session">session</span>)}
          {lastAt && !working && (
            <time className="card-time" dateTime={lastAt} title={fullTime(lastAt)}>{timeAgo(lastAt)}</time>
          )}
        </div>
      )}
      {limit && !dragging && limitWait(ticket) && <LimitActions slug={limit.slug} ticket={ticket} onError={limit.onError} small />}
      {limit && !dragging && capWait(ticket) && <CapActions slug={limit.slug} ticket={ticket} onError={limit.onError} small />}
      {limit && !dragging && stallWait(ticket) && <StallActions slug={limit.slug} ticket={ticket} onError={limit.onError} small />}
    </article>
  );
}
