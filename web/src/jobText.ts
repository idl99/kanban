// Plain words for one-time scheduled jobs (no React and kept free of api.ts, so tests and the root typecheck can import it).

export type JobState = "scheduled" | "running" | "done" | "failed" | "cancelled" | "missed" | "skipped";

/** The fields of api.ts's Job these helpers read. */
export interface Job {
  name: string;
  at: string;
  action: { kind: "ticket" } | { kind: "command" };
  state: JobState;
  sourceTicketId: string | null;
  updatedAt: string;
  firedAt: string | null;
  result: { exitCode?: number | null; durationMs?: number; timedOut?: boolean } | null;
}

/** Finished jobs stay listed this long with their result. */
export const KEEP_DONE_MS = 7 * 86400_000;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "Tue 20 Oct 22:00", local time. */
export function jobDate(iso: string): string {
  const d = new Date(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "in 2 days", "in 3 hours", "5 minutes ago", "now". */
export function jobRelative(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const mins = Math.round(Math.abs(diff) / 60_000);
  if (mins < 1) return "now";
  const hours = Math.round(mins / 60);
  const span = mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"}`
    : mins < 48 * 60 ? `${hours} hour${hours === 1 ? "" : "s"}`
    : `${Math.round(mins / 1440)} days`;
  return diff > 0 ? `in ${span}` : `${span} ago`;
}

/** "Tue 20 Oct 22:00 · in 2 days". */
export const jobWhen = (iso: string, now = Date.now()) => `${jobDate(iso)} · ${jobRelative(iso, now)}`;

export const jobDoes = (j: Job) => (j.action.kind === "ticket" ? "Starts a ticket" : "Runs a command");

export const STATE_LABEL: Record<JobState, string> = {
  scheduled: "Scheduled", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled", missed: "Missed", skipped: "Skipped",
};

/** Still to come (scheduled), soonest first. */
export function upcoming<J extends Job>(jobs: J[], ticketId?: string | null): J[] {
  return jobs.filter((j) => j.state === "scheduled" && (!ticketId || j.sourceTicketId === ticketId)).sort((a, b) => a.at.localeCompare(b.at));
}

/** What the Upcoming list shows: missed first, then running and scheduled by time, then finished ones from the last 7 days, newest first. */
export function jobsToShow<J extends Job>(jobs: J[], ticketId: string | null, now = Date.now()): { missed: J[]; open: J[]; over: J[] } {
  const mine = jobs.filter((j) => !ticketId || j.sourceTicketId === ticketId);
  const byAt = (a: Job, b: Job) => a.at.localeCompare(b.at);
  const ended = (j: Job) => j.firedAt ?? j.updatedAt;
  return {
    missed: mine.filter((j) => j.state === "missed").sort(byAt),
    open: mine.filter((j) => j.state === "scheduled" || j.state === "running").sort(byAt),
    over: mine
      .filter((j) => !["missed", "scheduled", "running"].includes(j.state) && now - new Date(j.updatedAt).getTime() < KEEP_DONE_MS)
      .sort((a, b) => ended(b).localeCompare(ended(a))),
  };
}

/** The source ticket's chip: "5 scheduled", with the next one for the tooltip. Null when nothing is coming. */
export function jobChip(jobs: Job[], ticketId: string, now = Date.now()): { label: string; title: string } | null {
  const next = upcoming(jobs, ticketId);
  if (!next.length) return null;
  return { label: `${next.length} scheduled`, title: `Next: ${next[0].name}, ${jobWhen(next[0].at, now)}` };
}

/** The value for an <input type="datetime-local">: "2026-10-20T22:00" in local time. */
export function localInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A command's result in a few words: "Finished OK in 3 s", "Exit code 2 after 1 min". */
export function commandResult(j: Job): string | null {
  const r = j.result;
  if (!r || j.action.kind !== "command") return null;
  const took = r.durationMs == null ? "" : r.durationMs < 60_000 ? ` in ${Math.max(1, Math.round(r.durationMs / 1000))} s` : ` in ${Math.round(r.durationMs / 60_000)} min`;
  if (r.timedOut) return `Stopped at its time limit${took}`;
  if (r.exitCode === 0) return `Finished OK${took}`;
  if (r.exitCode != null) return `Exit code ${r.exitCode}${took}`;
  return null;
}
