// Planner orchestration: pure decisions about a plan's children. Board.advancePlans() applies them.
// Ordering is plain code (no tokens); the planner's Claude session is only woken for events below.
import type { Plan, Ticket } from "./types";

export const DEFAULT_MAX_CONCURRENT = 2;
export const MAX_RETRIES = 3;

/** Wake-ups allowed per plan before it counts as stuck: 3 per child, at least 5. */
export function wakeupCap(children: number): number {
  return Math.max(5, children * 3);
}

export function childrenOf(tickets: Ticket[], plannerId: string): Ticket[] {
  return tickets.filter((t) => t.parentId === plannerId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.order - b.order);
}

export function planActive(p: Plan | null | undefined): boolean {
  return p?.state === "running" || p?.state === "finishing";
}

/** Done, or finished in Review without a PR to merge (repos that push straight to main). */
export function isComplete(t: Ticket): boolean {
  return t.status === "done" || (t.status === "review" && t.outcome === "done" && !t.prUrl);
}

/** Resource names as stored: trimmed, lowercase, no blanks or repeats. */
export function normalizeNeeds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = v.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return [...new Set(out)];
}

/** A dependency names a sibling by ticket id or planKey. */
export function resolveDeps(t: Ticket, siblings: Ticket[]): { deps: Ticket[]; missing: string[] } {
  const deps: Ticket[] = [];
  const missing: string[] = [];
  for (const ref of t.dependsOn ?? []) {
    const d = siblings.find((s) => s.id !== t.id && (s.id === ref || (!!s.planKey && s.planKey === ref)));
    if (d) deps.push(d);
    else missing.push(ref);
  }
  return { deps, missing };
}

/** Titles along a dependency cycle among the children, or null. */
export function findCycle(children: Ticket[]): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: Ticket[] = [];
  const visit = (t: Ticket): string[] | null => {
    if (state.get(t.id) === "done") return null;
    if (state.get(t.id) === "visiting") return [...stack.slice(stack.indexOf(t)), t].map((x) => x.title);
    state.set(t.id, "visiting");
    stack.push(t);
    for (const d of resolveDeps(t, children).deps) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(t.id, "done");
    return null;
  };
  for (const t of children) {
    const c = visit(t);
    if (c) return c;
  }
  return null;
}

/** Why a set of children can't be planned, or null when it can. */
export function planProblem(children: Ticket[]): string | null {
  if (!children.length) return "this ticket has no child tickets to run";
  for (const t of children) {
    const { missing } = resolveDeps(t, children);
    if (missing.length) return `"${t.title}" depends on unknown ticket ${missing.map((m) => `"${m}"`).join(", ")}`;
  }
  const cycle = findCycle(children);
  return cycle ? `dependency cycle: ${cycle.join(" → ")}` : null;
}

export interface PlanEvent {
  childId: string;
  /** Child state the event is about; the planner hears about each one once. */
  sig: string;
  line: string;
}

export interface PlanStep {
  /** Children to move to Ready now, in order. */
  start: string[];
  /** New things the planner should decide about. */
  events: PlanEvent[];
  allComplete: boolean;
  /** Children in Ready / In progress (or running a chat). */
  active: number;
  /** Children whose PR the planner was told about and that wait to be merged (the PR poller then marks them done). */
  awaitingMerge: number;
  /** Nothing is running, nothing can start and not everything is done. */
  deadEnd: string | null;
  /** Backlog children that could start but wait for a resource another ticket holds. */
  resourceWait: { id: string; resources: string[] }[];
  /** Open children waiting on the user (questions, a proposal to apply, in Planning); never started by the plan. */
  userWait: { id: string; reason: string }[];
}

export interface PlanStepOptions {
  /** Resources this ticket needs that another ticket (on any board) holds right now. */
  held?: (t: Ticket) => string[];
  /** Why this ticket waits on the user, or null. */
  waitingOnUser?: (t: Ticket) => string | null;
}

/** Hit the usage limit and the board continues it automatically once the limit resets. */
export const waitsOnLimit = (t: Ticket): boolean => t.outcome === "limit" && !!t.limit?.auto;

function lastError(t: Ticket): string {
  const e = (t.error ?? "").trim().split("\n").slice(-2).join(" ").slice(0, 300);
  return e ? `: ${e}` : "";
}

/** What a running plan should do next, given its children (pure, so it is easy to test). */
export function planStep(plan: Plan, children: Ticket[], running: (id: string) => boolean, opts: PlanStepOptions = {}): PlanStep {
  const seen = plan.seen ?? {};
  const events: PlanEvent[] = [];
  let active = 0;
  let awaitingMerge = 0;
  for (const t of children) {
    // Waiting for a usage limit to reset with an automatic continue coming: still at work, not failed.
    const busy = running(t.id) || t.status === "ready" || t.status === "in_progress" || waitsOnLimit(t);
    if (busy) {
      active++;
      continue;
    }
    let ev: PlanEvent | null = null;
    if (t.outcome === "failed" || t.outcome === "blocked" || t.outcome === "needs_input" || t.outcome === "limit") {
      const what = t.outcome === "needs_input" ? "is asking questions" : t.outcome === "failed" ? "failed"
        : t.outcome === "limit" ? "hit the usage limit and won't continue on its own" : "is blocked";
      ev = { childId: t.id, sig: `${t.runCount}:${t.outcome}`, line: `${t.id} "${t.title}" ${what} (${t.status})${lastError(t)}` };
    } else if (t.status === "review" && t.outcome === "done" && t.prUrl) {
      ev = { childId: t.id, sig: `${t.runCount}:pr:${t.prUrl}`, line: `${t.id} "${t.title}" finished with an open PR: ${t.prUrl}` };
    }
    if (ev && seen[t.id] !== ev.sig) events.push(ev);
    else if (ev && t.prUrl && t.outcome === "done") awaitingMerge++;
  }
  const allComplete = children.length > 0 && children.every(isComplete);
  const userWait: PlanStep["userWait"] = [];
  for (const t of children) {
    if (isComplete(t) || running(t.id) || t.status === "ready" || t.status === "in_progress") continue;
    const reason = opts.waitingOnUser?.(t) ?? null;
    if (reason) userWait.push({ id: t.id, reason });
  }
  const start: string[] = [];
  const resourceWait: PlanStep["resourceWait"] = [];
  // Resources taken by children this step starts: two children needing the emulator don't both start.
  const claimed = new Set<string>();
  const room = Math.max(1, plan.maxConcurrent) - active;
  for (const t of children) {
    if (t.status !== "backlog" || running(t.id)) continue;
    if (userWait.some((w) => w.id === t.id)) continue;
    const { deps, missing } = resolveDeps(t, children);
    if (missing.length || !deps.every(isComplete)) continue;
    const busy = [...new Set([...(opts.held?.(t) ?? []), ...(t.needs ?? []).filter((r) => claimed.has(r))])];
    if (busy.length) {
      resourceWait.push({ id: t.id, resources: busy });
      continue;
    }
    if (start.length >= room) continue;
    start.push(t.id);
    for (const r of t.needs ?? []) claimed.add(r);
  }
  let deadEnd: string | null = null;
  // Waiting for a resource is not a dead end: whoever holds it finishes and the board checks again.
  if (!allComplete && !active && !start.length && !events.length && !awaitingMerge && !resourceWait.length) {
    const label = (t: Ticket) => `"${t.title}"`;
    const you = userWait.map((w) => `${label(children.find((c) => c.id === w.id)!)} (${w.reason})`);
    const open = children.filter((t) => !isComplete(t) && !userWait.some((w) => w.id === t.id))
      .map((t) => `${label(t)} (${t.status}${t.outcome ? `, ${t.outcome}` : ""})`);
    const list = (xs: string[]) => `${xs.slice(0, 8).join(", ")}${xs.length > 8 ? ` and ${xs.length - 8} more` : ""}`;
    deadEnd = [
      you.length ? `waiting for you: ${list(you)}` : null,
      open.length ? `${you.length ? "also not done" : "nothing can run; not done yet"}: ${list(open)}` : null,
    ].filter(Boolean).join("; ");
  }
  return { start, events, allComplete, active, awaitingMerge, deadEnd, resourceWait, userWait };
}

/** One line per child for the planner's prompt. */
export function planTable(children: Ticket[]): string {
  return children.map((t) => {
    const deps = resolveDeps(t, children).deps.map((d) => d.id);
    const bits = [
      t.status, t.outcome, t.prUrl ? `PR ${t.prUrl}` : null, deps.length ? `waits for ${deps.join(", ")}` : null,
      t.needs?.length ? `needs ${t.needs.join(", ")}` : null,
    ].filter(Boolean);
    return `- ${t.id}${t.planKey ? ` [${t.planKey}]` : ""} "${t.title}": ${bits.join("; ")}`;
  }).join("\n");
}
