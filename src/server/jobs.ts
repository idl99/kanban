// One-time jobs: at a set date and time the board creates and starts a ticket, or runs a command with no Claude.
// Board runs schedule them (schedule_job), e.g. "post A on Tue 22:00", so nothing has to stay awake in between.
// A job seen more than LATE_AFTER_MS past its time (computer asleep, daemon off) does not fire: it waits for the user.
import { existsSync } from "node:fs";
import type { Board } from "./board";
import type { Bus } from "./events";
import type { Store } from "./store";
import type { Job, JobAction, JobResult, JobState, MissedJob } from "./types";
import { inheritedEnv } from "./runner";
import { newId } from "./util";

export class JobError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface JobInput {
  name?: unknown;
  at?: unknown;
  action?: unknown;
}

/** Due longer ago than this when the board sees it: missed, the user decides (run now or skip). */
export const LATE_AFTER_MS = 10 * 60_000;
export const DEFAULT_TIMEOUT_SEC = 600;
const MAX_TIMEOUT_SEC = 24 * 3600;
/** Command output kept in the job's result. */
const OUTPUT_KEEP = 4096;
/** Jobs that are over but still listed by default (list_jobs shows these and everything upcoming). */
const RECENT_DONE = 20;

/** Jobs that can still change: edit, cancel, run now, skip. */
const OPEN: JobState[] = ["scheduled", "missed"];

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Due time from the caller: local "2026-10-20 22:00" / "2026-10-20T22:00[:ss]" (this computer's time),
 * or a full ISO time with Z or an offset. Throws a JobError on anything else.
 */
export function parseAt(v: unknown): Date {
  const s = typeof v === "string" ? v.trim() : "";
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  let d: Date | null = null;
  if (local) {
    const [y, mo, day, h, mi, sec] = local.slice(1).map((x) => Number(x ?? 0));
    d = new Date(y, mo - 1, day, h, mi, sec);
    // Rejects 2026-02-31 and 25:00 instead of rolling over.
    if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day || d.getHours() !== h || d.getMinutes() !== mi) d = null;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    d = new Date(s);
  }
  if (!d || Number.isNaN(d.getTime())) {
    throw new JobError(400, `at must be a date and time like "2026-10-20 22:00" (this computer's local time), got ${JSON.stringify(v ?? "")}`);
  }
  return d;
}

/** "Tue 20 Oct 22:00 (in 2 days)", in this computer's local time. */
export function describeAt(iso: string, now: Date): string {
  const d = new Date(iso);
  const when = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const diff = d.getTime() - now.getTime();
  const mins = Math.round(Math.abs(diff) / 60_000);
  const span = mins < 1 ? "" : mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"}`
    : mins < 48 * 60 ? `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? "" : "s"}`
    : `${Math.round(mins / 1440)} days`;
  return `${when} (${!span ? "now" : diff > 0 ? `in ${span}` : `${span} ago`})`;
}

/** Keeps only the last OUTPUT_KEEP bytes of what a command printed (stdout and stderr interleaved). */
class Tail {
  private text = "";

  add(chunk: string) {
    this.text += chunk;
    if (this.text.length > OUTPUT_KEEP * 2) this.text = this.text.slice(-OUTPUT_KEEP);
  }

  value(): string {
    const b = Buffer.from(this.text, "utf8");
    return b.length <= OUTPUT_KEEP ? this.text : b.subarray(b.length - OUTPUT_KEEP).toString("utf8").replace(/^�+/, "");
  }
}

async function pipe(stream: ReadableStream<Uint8Array>, tail: Tail): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) tail.add(decoder.decode(chunk, { stream: true }));
}

/** Signals the command's whole process group (it runs detached), so what it started stops with it. */
function killGroup(p: { pid: number; kill(sig?: NodeJS.Signals | number): void }, sig: NodeJS.Signals) {
  try {
    process.kill(-p.pid, sig);
  } catch {
    try {
      p.kill(sig);
    } catch {}
  }
}

/**
 * Runs `/bin/sh -c command` in cwd in its own process group, killed (with everything it started) after timeoutSec.
 * onStart gets a stop function that does the same right away (daemon shutdown).
 */
export async function runCommand(
  command: string, cwd: string, env: Record<string, string>, timeoutSec: number, onStart?: (stop: () => void) => void,
): Promise<JobResult> {
  const started = Date.now();
  const tail = new Tail();
  let timedOut = false;
  let p: ReturnType<typeof Bun.spawn>;
  try {
    // Not the daemon's run identity: a job command is not a board run.
    p = Bun.spawn(["/bin/sh", "-c", command], {
      cwd, env: { ...inheritedEnv(), ...env } as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
    });
  } catch (e) {
    return { exitCode: null, durationMs: Date.now() - started, output: "", timedOut: false, message: `could not start the command: ${(e as Error).message}` };
  }
  const stop = () => {
    killGroup(p, "SIGTERM");
    setTimeout(() => killGroup(p, "SIGKILL"), 5000).unref?.();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutSec * 1000);
  onStart?.(stop);
  const reading = Promise.all([pipe(p.stdout as ReadableStream<Uint8Array>, tail), pipe(p.stderr as ReadableStream<Uint8Array>, tail)]);
  const code = await p.exited;
  clearTimeout(timer);
  // The shell is gone; anything it left running in the background goes too.
  killGroup(p, "SIGKILL");
  // A background child of the command may keep the output open: don't wait for it long.
  await Promise.race([reading, Bun.sleep(1000)]);
  return {
    exitCode: timedOut ? null : code, durationMs: Date.now() - started, output: tail.value(), timedOut,
    ...(timedOut ? { message: `stopped after ${timeoutSec} s (time limit)` } : code !== 0 ? { message: `exited with code ${code}` } : {}),
  };
}

export interface JobRunnerOptions {
  now?: () => Date;
  /** A missed job no ticket can show (the user made it, or its ticket is gone): tell the user another way. */
  notify?: (title: string, body: string) => void;
}

/** Fires one-time jobs. Each fire is marked running before it starts, so a second tick or a restart never fires it again. */
export class JobRunner {
  private queue: Promise<unknown> = Promise.resolve();
  /** Commands still running (they don't hold up the queue). */
  private inflight = new Set<Promise<void>>();
  /** Stops each running command's process group (daemon shutdown). */
  private stops = new Set<() => void>();
  private now: () => Date;

  constructor(private board: Board, private store: Store, private bus: Bus, private o: JobRunnerOptions = {}) {
    this.now = o.now ?? (() => new Date());
    // A pending restart waits for running commands, so it doesn't cut them off.
    board.onRestartBusy(() => this.inflight.size);
    // A deleted ticket's jobs that haven't run yet go with it.
    bus.on((e) => {
      if (e.type === "ticket.deleted") void this.dropSource(e.profile, e.id);
    });
  }

  private dropSource(slug: string, ticketId: string): Promise<void> {
    return this.serial(() => {
      for (const j of this.store.listJobs(slug)) {
        if (j.sourceTicketId === ticketId && OPEN.includes(j.state)) this.save(slug, { ...j, state: "cancelled", result: { message: "its ticket was deleted" } });
      }
    });
  }

  /** Fires and edits one at a time, so a tick and a "run now" can't both fire the same job. */
  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  private save(slug: string, j: Job): Job {
    const next = { ...j, updatedAt: this.now().toISOString() };
    this.store.saveJob(slug, next);
    this.bus.emit({ type: "job.updated", profile: slug, id: j.id, job: next });
    return next;
  }

  get(slug: string, id: string): Job {
    const j = this.store.getJob(slug, id);
    if (!j) throw new JobError(404, `job ${id} not found`);
    return j;
  }

  /** The job with its due time in words, e.g. "Tue 20 Oct 22:00 (in 2 days)". */
  view(j: Job) {
    return { ...j, when: describeAt(j.at, this.now()) };
  }

  /**
   * Everything still to come, plus the most recent finished ones; only the ticket's own when ticketId is given.
   * finishedDays: every job that finished in that many days (the board's Upcoming list) instead of the last RECENT_DONE.
   */
  list(slug: string, ticketId?: string | null, finishedDays?: number): Job[] {
    const all = this.store.listJobs(slug).filter((j) => !ticketId || j.sourceTicketId === ticketId);
    const open = all.filter((j) => OPEN.includes(j.state) || j.state === "running");
    const over = all.filter((j) => !open.includes(j)).sort((a, b) => (b.firedAt ?? b.updatedAt).localeCompare(a.firedAt ?? a.updatedAt));
    if (finishedDays === undefined) return [...open, ...over.slice(0, RECENT_DONE)];
    const since = this.now().getTime() - finishedDays * 86400_000;
    return [...open, ...over.filter((j) => new Date(j.updatedAt).getTime() >= since)];
  }

  private action(v: unknown, base?: JobAction): JobAction {
    if (v === undefined && base) return base;
    const a = v as any;
    if (!a || typeof a !== "object") throw new JobError(400, "action is required: {kind: \"ticket\", title, body} or {kind: \"command\", command}");
    if (a.kind === "ticket") {
      const title = typeof a.title === "string" ? a.title.trim() : "";
      const body = typeof a.body === "string" ? a.body : "";
      if (!title) throw new JobError(400, "a ticket job needs a title");
      if (!body.trim()) throw new JobError(400, "a ticket job needs a body: the prompt the new ticket's run gets");
      return { kind: "ticket", title, body, mode: a.mode === "interview" ? "interview" : "auto" };
    }
    if (a.kind === "command") {
      const command = typeof a.command === "string" ? a.command.trim() : "";
      if (!command) throw new JobError(400, "a command job needs a command");
      if (a.timeoutSec === undefined || a.timeoutSec === null) return { kind: "command", command };
      const t = Number(a.timeoutSec);
      if (!Number.isFinite(t) || t < 1 || t > MAX_TIMEOUT_SEC) throw new JobError(400, `timeoutSec must be between 1 and ${MAX_TIMEOUT_SEC}`);
      return { kind: "command", command, timeoutSec: Math.round(t) };
    }
    throw new JobError(400, "action.kind must be \"ticket\" or \"command\"");
  }

  private futureAt(v: unknown): string {
    const d = parseAt(v);
    if (d.getTime() <= this.now().getTime()) {
      throw new JobError(400, `${describeAt(d.toISOString(), this.now())} is in the past: pick a time from now on`);
    }
    return d.toISOString();
  }

  create(slug: string, input: JobInput, sourceTicketId: string | null = null): Job {
    if (!this.store.getProfile(slug)) throw new JobError(404, `board ${slug} not found`);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new JobError(400, "name is required");
    const at = this.futureAt(input.at);
    const action = this.action(input.action);
    const now = this.now().toISOString();
    const j: Job = {
      id: newId(), name, at, action, state: "scheduled", sourceTicketId, createdAt: now, updatedAt: now, firedAt: null, result: null,
    };
    return this.save(slug, j);
  }

  /** Only a job that hasn't run yet; `by` (a board run's ticket) may only change the jobs it scheduled. */
  private open(slug: string, id: string, by: string | null, verb: string): Job {
    const j = this.get(slug, id);
    if (by && j.sourceTicketId !== by) throw new JobError(403, `job ${id} was not scheduled by this ticket (${by}), so it can't ${verb} it`);
    if (!OPEN.includes(j.state)) throw new JobError(409, `job ${id} is ${j.state}: only a scheduled or missed job can be changed`);
    return j;
  }

  update(slug: string, id: string, input: JobInput, by: string | null = null): Promise<Job> {
    return this.serial(() => {
      const j = this.open(slug, id, by, "change");
      const next: Job = { ...j };
      if (input.name !== undefined) {
        next.name = typeof input.name === "string" ? input.name.trim() : "";
        if (!next.name) throw new JobError(400, "name can't be empty");
      }
      if (input.action !== undefined) next.action = this.action(input.action, j.action);
      if (input.at !== undefined) {
        next.at = this.futureAt(input.at);
        // A new time for a missed job puts it back on the schedule.
        next.state = "scheduled";
      }
      const saved = this.save(slug, next);
      if (j.state === "missed") this.syncMissed(slug, j.sourceTicketId);
      return saved;
    });
  }

  private close(slug: string, id: string, by: string | null, state: "cancelled" | "skipped"): Promise<Job> {
    return this.serial(() => {
      const j = this.open(slug, id, by, state === "cancelled" ? "cancel" : "skip");
      const saved = this.save(slug, { ...j, state });
      if (j.state === "missed") this.syncMissed(slug, j.sourceTicketId);
      return saved;
    });
  }

  cancel(slug: string, id: string, by: string | null = null): Promise<Job> {
    return this.close(slug, id, by, "cancelled");
  }

  skip(slug: string, id: string, by: string | null = null): Promise<Job> {
    return this.close(slug, id, by, "skipped");
  }

  /** Fire a scheduled or missed job now. Resolves once it started (a command keeps running; see whenIdle). */
  runNow(slug: string, id: string, by: string | null = null): Promise<Job> {
    return this.serial(async () => {
      const j = this.open(slug, id, by, "run");
      const fired = await this.fire(slug, j);
      if (j.state === "missed") this.syncMissed(slug, j.sourceTicketId);
      return fired;
    });
  }

  /** Lists the source ticket's missed jobs on it, so it shows in Needs you until each one is run or skipped. */
  private syncMissed(slug: string, ticketId: string | null): boolean {
    if (!ticketId || !this.store.getTicket(slug, ticketId)) return false;
    const missed: MissedJob[] = this.store.listJobs(slug)
      .filter((j) => j.sourceTicketId === ticketId && j.state === "missed")
      .map((j) => ({ id: j.id, name: j.name, at: j.at, missedAt: j.updatedAt }));
    this.board.setMissedJobs(slug, ticketId, missed.length ? missed : null);
    return true;
  }

  private markMissed(slug: string, j: Job): void {
    const saved = this.save(slug, { ...j, state: "missed" });
    const when = describeAt(j.at, this.now()).replace(/ \(.*\)$/, "");
    const text = `Scheduled job '${j.name}' was due ${when} but the computer was off or the board wasn't running, so it didn't run. Run it now or skip it?`;
    if (j.sourceTicketId && this.store.getTicket(slug, j.sourceTicketId)) {
      this.store.addComment(slug, j.sourceTicketId, "ai", `${text} Tell Claude in this ticket's chat (job ${j.id}: run_job_now or skip_job).`);
    }
    if (!this.syncMissed(slug, saved.sourceTicketId)) this.o.notify?.(`Missed job: ${j.name}`, text);
  }

  private async fire(slug: string, j: Job): Promise<Job> {
    const firedAt = this.now().toISOString();
    // Saved before anything starts: a second tick or a restart finds it running and leaves it alone.
    let running = this.save(slug, { ...j, state: "running", firedAt, result: null });
    const fail = (message: string, extra: JobResult = {}) => this.save(slug, { ...running, state: "failed", result: { ...extra, message } });
    const profile = this.store.getProfile(slug);
    if (!profile) return fail(`board ${slug} no longer exists`);
    if (!existsSync(profile.path)) return fail(`the board folder ${profile.path} does not exist`);
    const a = j.action;
    if (a.kind === "ticket") {
      try {
        const src = j.sourceTicketId ? this.store.getTicket(slug, j.sourceTicketId) : null;
        const intro = j.sourceTicketId ? `Scheduled by ticket ${j.sourceTicketId}${src ? ` ("${src.title}")` : ""} as job '${j.name}'.\n\n` : "";
        const t = await this.board.createTicket(slug, { title: a.title, body: intro + a.body, status: "in_progress", mode: a.mode, jobId: j.id });
        return this.save(slug, { ...running, state: "done", result: { ticketId: t.id } });
      } catch (e) {
        const message = (e as Error).message || String(e);
        console.error(`job ${slug}/${j.id} (${j.name}) could not create its ticket: ${message}`);
        return fail(`could not create the ticket: ${message}`);
      }
    }
    const env = { CKANBAN_BOARD: slug, CKANBAN_JOB: j.id, CKANBAN_SOURCE_TICKET: j.sourceTicketId ?? "" };
    let stop: (() => void) | null = null;
    const done = runCommand(a.command, profile.path, env, a.timeoutSec ?? DEFAULT_TIMEOUT_SEC, (s) => {
      stop = s;
      this.stops.add(s);
    }).then((result) => {
      const ok = result.exitCode === 0 && !result.timedOut && !result.message;
      running = this.save(slug, { ...running, state: ok ? "done" : "failed", result });
    }).catch((e) => {
      running = fail(`the command could not run: ${(e as Error).message}`);
    });
    const tracked = done.finally(() => {
      this.inflight.delete(tracked);
      if (stop) this.stops.delete(stop);
      this.board.restartWorkChanged();
    });
    this.inflight.add(tracked);
    return running;
  }

  /** Resolves once every command started so far has finished (tests). */
  async whenIdle(): Promise<void> {
    await this.queue;
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /**
   * After a daemon restart: a command left running was cut off (failed); a ticket job left running either created its
   * ticket (done) or never got that far (scheduled again, so the next tick fires it, or marks it missed if late).
   */
  recover(): void {
    for (const p of this.store.listProfiles()) {
      for (const j of this.store.listJobs(p.slug)) {
        if (j.state !== "running") continue;
        if (j.action.kind === "command") {
          this.save(p.slug, { ...j, state: "failed", result: { ...j.result, message: "interrupted by restart: the board stopped while the command was running" } });
          continue;
        }
        const t = this.store.listTickets(p.slug).find((x) => x.jobId === j.id);
        this.save(p.slug, t ? { ...j, state: "done", result: { ticketId: t.id } } : { ...j, state: "scheduled", firedAt: null });
      }
    }
  }

  /** Fire every job that is due; one seen more than LATE_AFTER_MS late goes missed instead. */
  tick(): Promise<void> {
    return this.serial(async () => {
      const now = this.now().getTime();
      for (const p of this.store.listProfiles()) {
        for (const j of this.store.listJobs(p.slug)) {
          if (j.state !== "scheduled") continue;
          const due = new Date(j.at).getTime();
          if (Number.isNaN(due) || due > now) continue;
          if (now - due > LATE_AFTER_MS) this.markMissed(p.slug, j);
          // A pending restart holds new work: a ticket waits in Ready, a command waits for the next tick after it.
          else if (j.action.kind === "command" && this.board.isRestartPending()) continue;
          else await this.fire(p.slug, j);
        }
      }
    });
  }

  start(intervalMs = 30_000): () => void {
    this.recover();
    const run = () => this.tick().catch((e) => console.error("job tick failed", e));
    const timer = setInterval(run, intervalMs);
    run();
    return () => {
      clearInterval(timer);
      // The daemon is going away: stop running commands too, so "interrupted by restart" is true.
      for (const stop of this.stops) stop();
    };
  }
}
