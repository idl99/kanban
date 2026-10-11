import { childrenOf, isComplete, planActive } from "./plan";
import type { SessionSummary } from "./session";
import type { Store } from "./store";
import type { Ticket } from "./types";

export type AttentionKind = "failed" | "limit" | "blocked" | "questions" | "proposal" | "review" | "reply" | "huddle";

/**
 * Why a ticket is waiting on the user, or null if it isn't. This one rule drives every "needs you": the card's
 * "Your turn" badge, the column and filter counts and the Inbox. since: when it started waiting (the Inbox's age).
 */
export interface Attention {
  kind: AttentionKind;
  label: string;
  since: string;
}

/** The ticket's own open huddle, as far as "needs you" goes (Huddles.hostStates). */
export interface HostHuddle {
  /** Participants mid-turn (agents, or a ticket session with a run). */
  working: number;
  /** A wake is on its way to a participant (starting, or waiting for its run's turn to end). */
  queued: boolean;
  /** Messages tagging @you the user hasn't seen yet. */
  tagged: number;
  /** Learnings waiting for the user to save or discard them. */
  learnings: number;
  /** A lead or @main asked the user to close the huddle. */
  closeRequest: boolean;
  /** When the oldest of the tags, learnings and close request came in; null without any. */
  since: string | null;
}

/** The huddle works on its own: the card shows "Huddle · n working" and it doesn't need the user. */
export const huddleBusy = (h: HostHuddle | null | undefined): boolean => !!h && (h.working > 0 || h.queued);

/** What the ticket's huddle asks of the user, or null: tags for @you, a close request or learnings to review. */
export function huddleAsk(h: HostHuddle | null | undefined): string | null {
  if (!h) return null;
  if (h.closeRequest) return "Huddle asks to close";
  if (h.tagged > 0) return `Huddle: ${h.tagged} for you`;
  if (h.learnings > 0) return `Review ${h.learnings} learning${h.learnings === 1 ? "" : "s"}`;
  return null;
}

/** When the ticket's state last changed for the user: Claude's last word in the session, else the last run or edit. */
export function lastChange(t: Ticket, s: SessionSummary | null): string {
  return s?.lastMessage?.at || s?.updatedAt || t.lastRunAt || t.updatedAt || t.createdAt;
}

/**
 * createdTitles: titles of this ticket's children, to tell which proposed new tickets still wait for a click.
 * managed: the ticket is a child of a running plan, so its planner, not the user, handles it.
 * planComplete: every child of this ticket's plan is finished, so a stuck plan no longer needs the user.
 * huddle: the ticket's own open huddle; while it works the ticket doesn't need the user unless the huddle asks.
 */
export function attentionFor(
  t: Ticket, s: SessionSummary | null, running: boolean,
  o: { createdTitles?: Set<string>; managed?: boolean; planComplete?: boolean; huddle?: HostHuddle | null } = {},
): Attention | null {
  // Done means accepted as-is; Backlog means parked. Neither waits on the user, whatever the session holds.
  if (t.status === "done") return null;
  const since = lastChange(t, s);
  if (t.plan?.state === "stuck" && !o.planComplete) return { kind: "blocked", label: "Plan stuck", since: t.updatedAt };
  if (running || t.status === "in_progress") return null;
  // A running plan's planner and children are handled unattended; the plan pings the user when stuck.
  if (o.managed || t.plan?.state === "running" || t.plan?.state === "finishing" || t.plan?.state === "paused") return null;
  if (t.status === "backlog") return null;
  const ask = huddleAsk(o.huddle);
  if (ask) return { kind: "huddle", label: ask, since: o.huddle!.since ?? since };
  if (huddleBusy(o.huddle)) return null;
  if (t.outcome === "failed") return { kind: "failed", label: "Run failed", since };
  // Hit the usage limit: it waits for the reset and continues by itself, unless that is off or used up for today.
  if (t.outcome === "limit") return t.limit?.auto ? null : { kind: "limit", label: "Limit hit", since };
  if (t.outcome === "blocked") return { kind: "blocked", label: t.capHit ? `Stopped at $${t.capHit.capUsd.toFixed(2)} cap` : "Blocked", since };
  const q = s?.openQuestions ?? 0;
  if (q > 0) return { kind: "questions", label: `Answer ${q} question${q === 1 ? "" : "s"}`, since };
  if (t.outcome === "needs_input") return { kind: "questions", label: "Answer Claude", since };
  const p = s?.pendingProposal;
  if (p && !((!p.title || p.title === t.title) && (!p.description || p.description.trim() === t.body.trim()))) {
    return { kind: "proposal", label: "Review proposal", since };
  }
  if (s?.pendingNewTickets?.some((n) => !o.createdTitles?.has(n.title))) return { kind: "proposal", label: "Review proposed tickets", since };
  if (s?.pendingTeammates?.some((id) => !t.teammateCards?.[id])) return { kind: "proposal", label: "Review proposed teammate", since };
  if (t.status === "review") return { kind: "review", label: "Ready for review", since };
  // A reply cut off by a restart isn't a reply yet: recover() resumes it.
  if (t.status === "planning" && s?.lastMessage?.role === "assistant" && !s.lastMessage.peerReply && !t.interrupted) return { kind: "reply", label: "Claude replied", since };
  return null;
}

/** attentionFor with its options read from the board; the other tickets are only listed when they matter. */
export function ticketAttention(
  store: Store, slug: string, t: Ticket, s: SessionSummary | null, running: boolean, huddle?: HostHuddle | null,
): Attention | null {
  const planComplete = () => {
    const kids = childrenOf(store.listTickets(slug), t.id);
    return kids.length > 0 && kids.every(isComplete);
  };
  return attentionFor(t, s, running, {
    createdTitles: s?.pendingNewTickets.length
      ? new Set(store.listTickets(slug).filter((c) => c.parentId === t.id).map((c) => c.title)) : undefined,
    managed: t.parentId ? planActive(store.getTicket(slug, t.parentId)?.plan) : false,
    planComplete: t.plan?.state === "stuck" ? planComplete() : undefined,
    huddle,
  });
}

/** Oldest first: the Inbox order. */
export const byWaitingAge = <T extends { attention: Pick<Attention, "since"> }>(a: T, b: T) => a.attention.since.localeCompare(b.attention.since);

/**
 * Why a plan child waits on the user, or null: a plan never starts it, the user has to answer or apply something
 * first (or the planner answers its questions with chat_ticket). Done children never wait.
 */
export function userWaitReason(t: Ticket, s: SessionSummary | null): string | null {
  if (t.status === "done") return null;
  if (t.status === "planning") return "in Planning";
  const q = s?.openQuestions ?? 0;
  if (q > 0) return `${q} question${q === 1 ? "" : "s"} for you`;
  if (t.outcome === "needs_input") return "has questions for you";
  const p = s?.pendingProposal;
  if (p && !((!p.title || p.title === t.title) && (!p.description || p.description.trim() === t.body.trim()))) return "proposal to apply";
  return null;
}
