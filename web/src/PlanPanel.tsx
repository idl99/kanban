import { useState } from "react";
import { api, COLUMNS, type Ticket } from "./api";
import { ResourceChip, resourceWait } from "./Needs";
import { checkInsText, complete, planFinished } from "./planText";

export { complete, planFinished };

const STATE_LABEL: Record<string, [string, string]> = {
  running: ["Running", "running"],
  finishing: ["Final check", "running"],
  paused: ["Paused", "stopped"],
  stuck: ["Stuck", "blocked"],
  done: ["Done", "ok"],
};

const stateOf = (plan: Ticket["plan"]): [string, string] => plan ? STATE_LABEL[plan.state] ?? [plan.state, "stopped"] : ["Not started", "stopped"];

/** Sidebar row: "Plan · 3/9 done →", with a badge while it runs or is stuck. Opens the Plan tab. */
export function PlanSummary({ ticket, children, onOpen }: { ticket: Ticket; children: Ticket[]; onOpen: () => void }) {
  const done = children.filter(complete).length;
  const state = ticket.plan?.state;
  const [label, tone] = stateOf(ticket.plan);
  return (
    <div className="field-row">
      <span className="field-key">Plan</span>
      <span className="plan-summary">
        {(state === "stuck" || state === "running" || state === "finishing" || state === "paused") && <span className={`badge ${tone}`}>{label}</span>}
        <button className="link-btn" onClick={onOpen}>{done}/{children.length} done →</button>
      </span>
    </div>
  );
}

/** Every child is done: "Plan finished · 5 of 5 tickets done" with Move to Done (while the planner isn't Done) and Add more tickets. */
export function PlanFinished({ ticket, total, onMoveToDone, onAddMore }: {
  ticket: Ticket;
  total: number;
  onMoveToDone: () => void;
  onAddMore: () => void;
}) {
  return (
    <div className="banner ok plan-finished" role="status">
      <span>Plan finished · {total} of {total} tickets done</span>
      {ticket.status !== "done" && <button className="btn primary small" onClick={onMoveToDone}>Move to Done</button>}
      <button className="btn small" onClick={onAddMore} title="Ask Claude in the chat for more tickets">Add more tickets</button>
    </div>
  );
}

/** Plan tab: a planner's children, plus Start / Pause / Resume for running them unattended in dependency order. */
export function PlanPanel({ slug, ticket, children, onOpenTicket, onError, onMoveToDone, onAddMore }: {
  slug: string;
  ticket: Ticket;
  children: Ticket[];
  onOpenTicket: (id: string) => void;
  onError: (m: string) => void;
  onMoveToDone: () => void;
  onAddMore: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const plan = ticket.plan ?? null;
  const done = children.filter(complete).length;
  const act = async (action: "start" | "pause" | "resume" | "done" | "concurrency", n?: number) => {
    setBusy(true);
    try {
      await api.plan(slug, ticket.id, action, n);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  // Before the plan starts the choice stays here; Start plan sends it.
  const [draftCap, setDraftCap] = useState(2);
  const live = !!plan && plan.state !== "done";
  const cap = live ? plan!.maxConcurrent : draftCap;
  const [label, tone] = stateOf(plan);
  const finished = planFinished(children);
  const titleOf = (ref: string) => children.find((c) => c.id === ref || c.planKey === ref)?.title ?? ref;
  return (
    <section className="plan-panel">
      <div className="plan-head">
        <b>Plan</b>
        <span className={`badge ${tone}`}>{label}</span>
        <span className="plan-progress" role="progressbar" aria-valuemin={0} aria-valuemax={children.length} aria-valuenow={done}
          aria-label={`${done} of ${children.length} done`}>
          <i style={{ width: `${children.length ? (done / children.length) * 100 : 0}%` }} />
        </span>
        <span className="muted small">{done}/{children.length} done</span>
      </div>
      {!finished && plan?.state === "stuck" && plan.reason && <p className="field-help plan-reason">{plan.reason}</p>}
      {finished ? (
        <PlanFinished ticket={ticket} total={children.length} onMoveToDone={onMoveToDone} onAddMore={onAddMore} />
      ) : (
        <div className="plan-actions">
          {!plan || plan.state === "done" ? (
            <button className="btn primary small" disabled={busy}
              title="Children switch to auto mode and run in dependency order; Claude is woken only when one needs a decision"
              onClick={() => act("start", cap)}>Start plan</button>
          ) : plan.state === "paused" || plan.state === "stuck" ? (
            <button className="btn primary small" disabled={busy} onClick={() => act("resume")}>Resume plan</button>
          ) : (
            <button className="btn small" disabled={busy} onClick={() => act("pause")}>Pause</button>
          )}
          {(plan?.state === "stuck" || plan?.state === "paused") && (
            <button className="btn small" disabled={busy} title="Close the plan as it is, without waking Claude"
              onClick={() => act("done")}>Mark plan done</button>
          )}
          <label className="muted small plan-cap" title="Children of this plan in Ready or In progress at once">
            At once
            <select value={cap} disabled={busy} onChange={(e) => (live ? act("concurrency", Number(e.target.value)) : setDraftCap(Number(e.target.value)))}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          {plan && <span className="muted small" title="Times the plan asked Claude to decide something">{checkInsText(plan.wakeups)}</span>}
        </div>
      )}
      <ul className="child-tickets">
        {children.map((c) => {
          const waitFor = complete(c) ? [] : resourceWait(c);
          const holding = !!c.resources?.holding;
          const notes = [
            c.dependsOn?.length ? `after ${c.dependsOn.map(titleOf).join(", ")}` : null,
            c.userWait && !complete(c) ? c.userWait : null,
          ].filter(Boolean);
          return (
            <li key={c.id}>
              <span className="child-main">
                <button className="link-btn ticket-link" onClick={() => onOpenTicket(c.id)}>{c.title}</button>
                {(!!c.needs?.length || notes.length > 0) && (
                  <span className="muted small child-deps">
                    {c.needs?.map((n) => <ResourceChip key={n} name={n} held={holding && !complete(c)} />)}
                    {holding && !complete(c) && " in use "}
                    {notes.join(" · ")}
                  </span>
                )}
              </span>
              {c.userWait && !complete(c) && !c.running && c.status !== "in_progress" ? (
                <span className="badge wait" title={c.userWait}>Needs you</span>
              ) : waitFor.length ? (
                <span className="badge wait" title="Another ticket is using it; this one starts when it is free">Waiting for {waitFor.join(", ")}</span>
              ) : (
                <span className={`badge ${complete(c) ? "ok" : c.outcome === "failed" ? "failed" : c.outcome === "blocked" || c.outcome === "needs_input" ? "blocked" : ""}`}>
                  {complete(c) ? "Done" : COLUMNS.find((x) => x.id === c.status)?.label ?? c.status}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
