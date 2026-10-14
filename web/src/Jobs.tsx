import { useState } from "react";
import { api, type Job, type Ticket } from "./api";
import { commandResult, jobChip, jobDate, jobDoes, jobsToShow, jobWhen, localInput, STATE_LABEL } from "./jobText";

const STATE_TONE: Record<Job["state"], string> = {
  scheduled: "sched", running: "running", done: "ok", failed: "failed", cancelled: "stopped", missed: "blocked", skipped: "stopped",
};

/** Runs a job action, keeping which button is busy and the last error. */
function useJobAct() {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      return true;
    } catch (e: any) {
      setErr(e.message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, err, act };
}

/** The ticket that scheduled the job, as a link; "you" when nobody's run did. */
function Source({ job, tickets, onOpenTicket }: { job: Job; tickets: Ticket[]; onOpenTicket: (id: string) => void }) {
  if (!job.sourceTicketId) return <span className="muted small">Scheduled by you</span>;
  const t = tickets.find((x) => x.id === job.sourceTicketId);
  if (!t) return <span className="muted small">Scheduled by a ticket that's gone</span>;
  return (
    <span className="muted small job-source">
      Scheduled by <button className="link-btn sched-ticket" onClick={() => onOpenTicket(t.id)} title={t.title}>{t.title}</button>
    </span>
  );
}

/** What a finished job left: the ticket it started, or the command's exit code and output. */
function Result({ job, tickets, onOpenTicket }: { job: Job; tickets: Ticket[]; onOpenTicket: (id: string) => void }) {
  const r = job.result;
  if (!r) return null;
  const made = r.ticketId ? tickets.find((t) => t.id === r.ticketId) : undefined;
  const cmd = commandResult(job);
  return (
    <div className="job-result">
      {r.ticketId && (made
        ? <span className="small">Started <button className="link-btn sched-ticket" onClick={() => onOpenTicket(made.id)} title={made.title}>{made.title}</button></span>
        : <span className="muted small">Its ticket was deleted</span>)}
      {cmd && <span className="small">{cmd}</span>}
      {r.message && !cmd && job.state !== "done" && <span className={job.state === "failed" ? "mcp-msg" : "muted small"}>{r.message}</span>}
      {!!r.output && (
        <details className="mcp-details job-output">
          <summary>Output</summary>
          <pre>{r.output}</pre>
        </details>
      )}
    </div>
  );
}

/** Pick a new time for a job; saving a missed job's new time puts it back on the schedule. */
function ChangeTime({ slug, job, onDone }: { slug: string; job: Job; onDone: () => void }) {
  const [at, setAt] = useState(() => localInput(job.at > new Date().toISOString() ? job.at : new Date(Date.now() + 3600_000).toISOString()));
  const { busy, err, act } = useJobAct();
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await act("save", () => api.updateJob(slug, job.id, { at }))) onDone();
  };
  return (
    <form className="job-time" onSubmit={save}>
      <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="New time" autoFocus />
      <button type="submit" className="btn small primary" disabled={!at || !!busy}>{busy ? "Saving…" : "Save"}</button>
      <button type="button" className="btn small ghost" onClick={onDone}>Cancel</button>
      {err && <div className="form-error">{err}</div>}
    </form>
  );
}

/** One job: name, when it runs, what it does, who scheduled it, its state, and Run now / Change time / Cancel (or Skip). */
export function JobRow({ slug, job, tickets, onOpenTicket, showSource = true }: {
  slug: string; job: Job; tickets: Ticket[]; onOpenTicket: (id: string) => void; showSource?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const { busy, err, act } = useJobAct();
  const open = job.state === "scheduled" || job.state === "missed";
  const what = job.action.kind === "ticket" ? job.action.title : job.action.command;
  return (
    <div className={`sched-item job-item${job.state === "missed" ? " missed" : ""}`}>
      <div className="mcp-row job-row">
        <div className="mcp-main">
          <div className="mcp-name">
            <span>{job.name}</span>
            <span className={`badge ${STATE_TONE[job.state]}`}>{job.state === "running" && <span className="spinner" />} {STATE_LABEL[job.state]}</span>
          </div>
          <div className="sched-when" title={new Date(job.at).toLocaleString()}>
            {job.state === "missed" ? <>Was due {jobDate(job.at)}</> : open ? jobWhen(job.at) : <>Ran {jobDate(job.firedAt ?? job.at)}</>}
          </div>
          <div className="muted small job-does" title={what}>
            {jobDoes(job)}: {job.action.kind === "command" ? <code>{what}</code> : what}
          </div>
          {showSource && <Source job={job} tickets={tickets} onOpenTicket={onOpenTicket} />}
          {!open && job.state !== "running" && <Result job={job} tickets={tickets} onOpenTicket={onOpenTicket} />}
          {err && <div className="form-error">{err}</div>}
        </div>
        {open && (
          <div className="mcp-actions job-actions">
            <button className={`btn small${job.state === "missed" ? " primary" : ""}`} disabled={!!busy} onClick={() => act("run", () => api.runJobNow(slug, job.id))}>
              {busy === "run" ? "Starting…" : "Run now"}
            </button>
            <button className={`btn small ghost${editing ? " on" : ""}`} aria-pressed={editing} onClick={() => setEditing((e) => !e)}>Change time</button>
            {job.state === "missed"
              ? <button className="btn small ghost" disabled={!!busy} onClick={() => act("skip", () => api.skipJob(slug, job.id))}>{busy === "skip" ? "Skipping…" : "Skip"}</button>
              : <button className="btn small ghost danger" disabled={!!busy} onClick={() => act("cancel", () => api.cancelJob(slug, job.id))}>{busy === "cancel" ? "Cancelling…" : "Cancel"}</button>}
          </div>
        )}
      </div>
      {editing && open && <ChangeTime slug={slug} job={job} onDone={() => setEditing(false)} />}
    </div>
  );
}

/** The Schedules dialog's Upcoming list: one-time jobs, missed ones on top; filter: only one ticket's. */
export function UpcomingJobs({ slug, jobs, tickets, filter, onFilter, onOpenTicket }: {
  slug: string;
  jobs: Job[] | null;
  tickets: Ticket[];
  filter: string | null;
  onFilter: (ticketId: string | null) => void;
  onOpenTicket: (id: string) => void;
}) {
  const [showOver, setShowOver] = useState(false);
  if (!jobs) return <div className="muted">Loading…</div>;
  const { missed, open, over } = jobsToShow(jobs, filter);
  const filterTicket = filter ? tickets.find((t) => t.id === filter) : undefined;
  const row = (j: Job) => <JobRow key={j.id} slug={slug} job={j} tickets={tickets} onOpenTicket={onOpenTicket} showSource={!filter} />;
  return (
    <div className="jobs">
      {filter && (
        <div className="job-filter">
          <span className="small">Scheduled by <b>{filterTicket?.title ?? "a deleted ticket"}</b></span>
          <button className="link-btn small" onClick={() => onFilter(null)}>Show all</button>
        </div>
      )}
      {missed.length > 0 && (
        <div className="job-missed-box" role="status">
          <div className="small"><b>Missed</b> · the computer was off or the board wasn't running when {missed.length === 1 ? "this was" : "these were"} due. Run now or skip?</div>
          <div className="mcp-section">{missed.map(row)}</div>
        </div>
      )}
      {open.length > 0 && <div className="mcp-section">{open.map(row)}</div>}
      {!missed.length && !open.length && (
        <div className="muted small">
          Nothing scheduled{filter ? " by this ticket" : ""}. Ask Claude in a ticket to do something once at a set time, e.g. "post this on Tuesday at 22:00".
        </div>
      )}
      {over.length > 0 && (
        <>
          <button className="link-btn small job-over-toggle" aria-expanded={showOver} onClick={() => setShowOver((s) => !s)}>
            {showOver ? "Hide" : "Show"} finished ({over.length}, last 7 days)
          </button>
          {showOver && <div className="mcp-section">{over.map(row)}</div>}
        </>
      )}
    </div>
  );
}

/** "⏰ 5 scheduled" on the ticket that scheduled them (card and drawer); the next one is in the tooltip. */
export function JobChip({ jobs, ticketId, onOpen }: { jobs: Job[]; ticketId: string; onOpen?: (ticketId: string) => void }) {
  const chip = jobChip(jobs, ticketId);
  if (!chip) return null;
  return (
    <button type="button" className="badge job-chip" title={`${chip.title}. Click to see them.`}
      onClick={(e) => { e.stopPropagation(); onOpen?.(ticketId); }} onKeyDown={(e) => e.stopPropagation()}>
      <span aria-hidden>⏰</span> {chip.label}
    </button>
  );
}

/** Drawer banner: jobs this ticket scheduled that were missed, each with Run now / Skip. */
export function MissedJobs({ slug, ticket, jobs, tickets, onOpenTicket }: {
  slug: string; ticket: Ticket; jobs: Job[]; tickets: Ticket[]; onOpenTicket: (id: string) => void;
}) {
  const ids = new Set((ticket.missedJobs ?? []).map((m) => m.id));
  const missed = jobs.filter((j) => j.state === "missed" && (ids.has(j.id) || j.sourceTicketId === ticket.id));
  if (!missed.length) return null;
  return (
    <div className="banner warn inline job-missed-banner" role="status">
      <strong>Scheduled job{missed.length === 1 ? "" : "s"} missed</strong>
      <span className="small">The computer was off or the board wasn't running when {missed.length === 1 ? "it was" : "they were"} due. Run now or skip?</span>
      <div className="mcp-section">
        {missed.map((j) => <JobRow key={j.id} slug={slug} job={j} tickets={tickets} onOpenTicket={onOpenTicket} showSource={false} />)}
      </div>
    </div>
  );
}
