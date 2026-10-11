import { existsSync } from "node:fs";
import type { Board } from "./board";
import { cronError, describeCron, nextRun, parseCron } from "./cron";
import type { Bus } from "./events";
import type { Store } from "./store";
import type { Schedule, ScheduleEditAction, ScheduleEditor, ScheduleHistoryEntry, SchedulePrevious, ScheduleTrigger, Ticket } from "./types";
import { newId } from "./util";

/** Request header the ckanban MCP tools send from inside a board run (value: the run's CKANBAN_TICKET). */
export const RUN_HEADER = "x-ckanban-run";

export class ScheduleError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface ScheduleInput {
  name?: unknown;
  title?: unknown;
  body?: unknown;
  mode?: unknown;
  cron?: unknown;
  enabled?: unknown;
  skipIfRunning?: unknown;
}

/** A due time older than this when the scheduler sees it was missed (daemon off, laptop asleep). */
const MISSED_AFTER_MS = 90_000;
const HISTORY_LIMIT = 100;
/** Old prompt/title/cron kept in an "updated" history entry, cut to this many characters. */
const PREVIOUS_MAX = 2000;
const EDITABLE = ["name", "title", "body", "mode", "cron", "enabled", "skipIfRunning"] as const;

const editorText = (by: ScheduleEditor) => (by === "user" ? "the user" : `ticket ${by.ticketId}`);

const pad = (n: number) => String(n).padStart(2, "0");

/** Ticket title from the template: `{date}` → 2026-10-01, `{time}` → 09:00 (local time). */
export function fillTitle(template: string, d: Date): string {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return template.replaceAll("{date}", date).replaceAll("{time}", `${pad(d.getHours())}:${pad(d.getMinutes())}`);
}

/**
 * Fires schedules: every tick, each enabled schedule whose nextRunAt has passed creates a ticket that runs right away.
 * Runs missed while the daemon was down fire once on the first tick, then the schedule moves on from now.
 */
export class Scheduler {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private board: Board, private store: Store, private bus: Bus, private now: () => Date = () => new Date()) {}

  /** Fires and edits one at a time, so a tick and a "Run now" can't both create a ticket for the same slot. */
  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  private emit(slug: string, id: string, schedule: Schedule | null) {
    this.bus.emit({ type: "schedule.updated", profile: slug, id, schedule });
  }

  private nextRunAt(cron: string): string | null {
    return nextRun(parseCron(cron), this.now())?.toISOString() ?? null;
  }

  /** The schedule's previous ticket while it is still queued or running. */
  activeTicket(slug: string, id: string): Ticket | null {
    return this.store.listTickets(slug).find((t) =>
      t.scheduleId === id && (t.status === "ready" || t.status === "in_progress" || this.board.isRunning(slug, t.id))) ?? null;
  }

  view(slug: string, s: Schedule) {
    return { ...s, summary: describeCron(s.cron), active: this.activeTicket(slug, s.id) !== null };
  }

  private validate(input: ScheduleInput, base?: Schedule): Omit<Schedule, "id" | "createdAt" | "updatedAt" | "lastFiredAt" | "nextRunAt" | "lastError"> {
    const str = (v: unknown, fallback: string) => (v === undefined ? fallback : String(v ?? ""));
    const name = str(input.name, base?.name ?? "").trim();
    const title = str(input.title, base?.title ?? "").trim();
    const cron = str(input.cron, base?.cron ?? "").trim().replace(/\s+/g, " ");
    if (!name) throw new ScheduleError(400, "name is required");
    if (!title) throw new ScheduleError(400, "ticket title is required");
    if (!cron) throw new ScheduleError(400, "cron expression is required");
    const err = cronError(cron);
    if (err) throw new ScheduleError(400, `invalid cron expression: ${err}`);
    const mode = input.mode === undefined ? base?.mode ?? "auto" : input.mode === "interview" ? "interview" : "auto";
    return {
      name, title, cron, mode,
      body: str(input.body, base?.body ?? ""),
      enabled: input.enabled === undefined ? base?.enabled ?? true : input.enabled === true,
      skipIfRunning: input.skipIfRunning === undefined ? base?.skipIfRunning ?? true : input.skipIfRunning === true,
    };
  }

  get(slug: string, id: string): Schedule {
    const s = this.store.getSchedule(slug, id);
    if (!s) throw new ScheduleError(404, `schedule ${id} not found`);
    return s;
  }

  private logEdit(slug: string, id: string, action: ScheduleEditAction, fields: string[], by: ScheduleEditor, previous?: SchedulePrevious) {
    this.store.appendScheduleHistory(slug, id, {
      at: this.now().toISOString(), kind: "edited", action, fields, by, ...(previous && Object.keys(previous).length ? { previous } : {}),
    });
  }

  create(slug: string, input: ScheduleInput, by: ScheduleEditor = "user"): Schedule {
    const fields = this.validate(input);
    const at = this.now().toISOString();
    const s: Schedule = {
      id: newId(), ...fields, createdAt: at, updatedAt: at, lastFiredAt: null, lastError: null,
      nextRunAt: fields.enabled ? this.nextRunAt(fields.cron) : null,
    };
    this.store.saveSchedule(slug, s);
    this.logEdit(slug, s.id, "created", [], by);
    this.emit(slug, s.id, s);
    return s;
  }

  update(slug: string, id: string, input: ScheduleInput, by: ScheduleEditor = "user"): Schedule {
    const current = this.get(slug, id);
    const fields = this.validate(input, current);
    const next: Schedule = { ...current, ...fields, updatedAt: this.now().toISOString() };
    // Resuming starts from now (no backfill); edits that keep the timing keep the pending slot.
    if (!next.enabled) next.nextRunAt = null;
    else if (!current.enabled || next.cron !== current.cron || !current.nextRunAt) next.nextRunAt = this.nextRunAt(next.cron);
    this.store.saveSchedule(slug, next);
    const changed: string[] = EDITABLE.filter((k) => next[k] !== current[k]);
    if (changed.length) {
      const toggle = changed.length === 1 && changed[0] === "enabled";
      const previous: SchedulePrevious = {};
      for (const k of ["title", "body", "cron"] as const) if (changed.includes(k)) previous[k] = current[k].slice(0, PREVIOUS_MAX);
      this.logEdit(slug, id, toggle ? (next.enabled ? "resumed" : "paused") : "updated", changed, by, previous);
    }
    this.emit(slug, id, next);
    return next;
  }

  remove(slug: string, id: string, by: ScheduleEditor = "user"): void {
    const s = this.get(slug, id);
    // The history file goes with it, so the daemon log is the only trace.
    console.log(`schedule ${slug}/${id} (${s.name}) deleted by ${editorText(by)}`);
    this.store.deleteSchedule(slug, id);
    this.emit(slug, id, null);
  }

  /** Newest first, with each ticket's current state (null once the ticket was deleted). */
  history(slug: string, id: string) {
    this.get(slug, id);
    return this.store.readScheduleHistory(slug, id).slice(-HISTORY_LIMIT).reverse().map((e) => {
      // Fires and skips point at the schedule's ticket; edits at the ticket whose run made them.
      const tid = e.kind === "fired" || e.kind === "skipped" ? e.ticketId
        : e.kind === "edited" && e.by !== "user" ? e.by.ticketId : null;
      const t = tid ? this.store.getTicket(slug, tid) : null;
      return {
        ...e,
        ticket: t ? { id: t.id, title: t.title, status: t.status, outcome: t.outcome, running: this.board.isRunning(slug, t.id) } : null,
      };
    });
  }

  runNow(slug: string, id: string): Promise<ScheduleHistoryEntry> {
    return this.serial(() => this.fire(slug, this.get(slug, id), "manual"));
  }

  private async fire(slug: string, s: Schedule, trigger: ScheduleTrigger): Promise<ScheduleHistoryEntry> {
    const now = this.now();
    const at = now.toISOString();
    let entry: ScheduleHistoryEntry;
    const prev = s.skipIfRunning ? this.activeTicket(slug, s.id) : null;
    let lastError = s.lastError;
    let fired = false;
    if (prev) {
      entry = { at, kind: "skipped", trigger, ticketId: prev.id };
    } else {
      try {
        const profile = this.store.getProfile(slug);
        if (!profile) throw new Error(`board ${slug} no longer exists`);
        if (!existsSync(profile.path)) throw new Error(`board folder ${profile.path} does not exist`);
        const t = await this.board.createTicket(slug, {
          title: fillTitle(s.title, now), body: s.body, status: "in_progress", mode: s.mode, scheduleId: s.id,
        });
        entry = { at, kind: "fired", trigger, ticketId: t.id };
        lastError = null;
        fired = true;
      } catch (e) {
        const message = (e as Error).message || String(e);
        console.error(`schedule ${slug}/${s.id} (${s.name}) could not create its ticket: ${message}`);
        entry = { at, kind: "error", trigger, message };
        lastError = message;
      }
    }
    // The schedule may have been edited or deleted while the ticket was being created.
    const current = this.store.getSchedule(slug, s.id);
    if (current) {
      this.store.appendScheduleHistory(slug, s.id, entry);
      const next: Schedule = { ...current, lastError, lastFiredAt: fired ? at : current.lastFiredAt };
      this.store.saveSchedule(slug, next);
      this.emit(slug, s.id, next);
    }
    return entry;
  }

  /** Fire every enabled schedule that is due. */
  tick(): Promise<void> {
    return this.serial(async () => {
      const now = this.now();
      for (const p of this.store.listProfiles()) {
        for (const s of this.store.listSchedules(p.slug)) {
          if (!s.enabled || !s.nextRunAt) continue;
          const due = new Date(s.nextRunAt).getTime();
          if (Number.isNaN(due) || due > now.getTime()) continue;
          const trigger: ScheduleTrigger = now.getTime() - due > MISSED_AFTER_MS ? "missed" : "schedule";
          // Move on before firing: however many slots were missed, this is the only catch-up.
          let nextRunAt: string | null = null;
          try {
            nextRunAt = this.nextRunAt(s.cron);
          } catch {}
          const moved = { ...s, nextRunAt };
          this.store.saveSchedule(p.slug, moved);
          await this.fire(p.slug, moved, trigger);
        }
      }
    });
  }

  start(intervalMs = 30_000): () => void {
    const run = () => this.tick().catch((e) => console.error("scheduler tick failed", e));
    const timer = setInterval(run, intervalMs);
    run();
    return () => clearInterval(timer);
  }
}
