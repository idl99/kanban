import type { Board } from "./board";
import type { Store } from "./store";

/**
 * Claude usage/spend limits: a run that ends because the account hit its limit is not a failure of the work.
 * The board recognises it, shows when the limit resets and sends "continue" once it has (see Board.limitHit and
 * LimitWatcher).
 *
 * Real messages, from the CLI's synthetic assistant message / result line (error "rate_limit", api_error_status 429):
 *   You've hit your individual spend limit · run /usage-credits to raise it, or visit claude.ai/admin-settings/usage · your session limit resets 4am (Asia/Kuala_Lumpur)
 *   … your session limit resets 12:30am (Asia/Kuala_Lumpur)
 * Older CLIs: "Claude AI usage limit reached|1760000000" (reset as epoch seconds), "5-hour limit reached ∙ resets 3pm".
 */

/** Sent to the session once the limit has reset. */
export const CONTINUE_TEXT = "continue";
/** How long after the reset time the automatic continue goes out (the reset isn't always on the dot). */
export const CONTINUE_DELAY_MS = 60_000;
/** Automatic continues per ticket per (local) day; after that the ticket needs the user. */
export const AUTO_CONTINUE_PER_DAY = 3;

const LIMIT_RE = /\bhit your\b[^\n·]*\blimit\b|\b(?:usage|spend|session|weekly|opus|sonnet|5-hour)\s+limit\b|\blimit reached\b/i;
// Transient API throttling ("rate limit", "rate_limit_error") and the board's own caps aren't a usage limit.
const NOT_LIMIT_RE = /\brate[ _]limit|\b(?:retry|wake-up|create) limit reached/i;

/** The text says the Claude usage/spend limit was hit. */
export function isLimitText(text: string): boolean {
  return LIMIT_RE.test(text) && !NOT_LIMIT_RE.test(text);
}

function eventText(ev: any): string {
  if (ev?.type === "result") return typeof ev.result === "string" ? ev.result : "";
  const c = ev?.message?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("") : "";
}

/**
 * The limit message a run ended with, or null. Looks at the CLI's API-error messages (never Claude's own words, which
 * may well talk about limits) and at stderr.
 */
export function limitMessage(events: any[], stderr = ""): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const apiError = (ev?.type === "assistant" && (ev.is_api_error_message || ev.error)) || (ev?.type === "result" && ev.is_error);
    if (!apiError) continue;
    const text = eventText(ev).trim();
    if (text && isLimitText(text)) return text;
  }
  const line = stderr.split("\n").map((l) => l.trim()).findLast((l) => l && isLimitText(l));
  return line ?? null;
}

/** Offset of the time zone from UTC at this instant, in ms (null: unknown zone). */
function zoneOffset(tz: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(at);
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(at.getTime() / 1000) * 1000;
  } catch {
    return null;
  }
}

/** Wall-clock fields (y, m, d, h, min) in tz (or local time when tz is null) as an instant. */
function wallTime(y: number, mo: number, d: number, h: number, mi: number, tz: string | null): Date {
  if (!tz) return new Date(y, mo, d, h, mi);
  const guess = Date.UTC(y, mo, d, h, mi);
  const off1 = zoneOffset(tz, new Date(guess)) ?? 0;
  const off2 = zoneOffset(tz, new Date(guess - off1)) ?? off1;
  return new Date(guess - off2);
}

/** Today's date fields as seen in tz (or local time). */
function today(now: Date, tz: string | null): { y: number; mo: number; d: number } {
  if (!tz) return { y: now.getFullYear(), mo: now.getMonth(), d: now.getDate() };
  const shifted = new Date(now.getTime() + (zoneOffset(tz, now) ?? 0));
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The next full hour after now: the reset when the message gives none. */
export function nextFullHour(now: Date): Date {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

/**
 * When the limit in this message resets: "resets 4am (Asia/Kuala_Lumpur)", "resets 12:30am", "resets 16:00",
 * "resets Oct 14, 9am", or "|<epoch seconds>". The time is in the zone the message names, else local time, and the
 * next such time after now. Without a time: the next full hour.
 */
export function parseReset(text: string, now: Date): Date {
  const epoch = text.match(/\|\s*(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const m = text.match(/\bresets?\s+(?:at\s+)?(?:(?:on\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i);
  if (!m) return nextFullHour(now);
  let h = Number(m[3]);
  const mi = m[4] ? Number(m[4]) : 0;
  const ampm = m[5]?.toLowerCase();
  if (!ampm && !m[4]) return nextFullHour(now); // a bare number ("resets 5") isn't a time
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (h > 23 || mi > 59) return nextFullHour(now);
  let tz: string | null = m[6]?.trim() ?? null;
  if (tz && zoneOffset(tz, now) === null) tz = null;
  const base = today(now, tz);
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (month >= 0) {
    let at = wallTime(base.y, month, Number(m[2]), h, mi, tz);
    // "Jan 2" seen in late December is next year.
    if (at.getTime() < now.getTime() - 24 * 3600_000) at = wallTime(base.y + 1, month, Number(m[2]), h, mi, tz);
    return at;
  }
  let at = wallTime(base.y, base.mo, base.d, h, mi, tz);
  if (at.getTime() <= now.getTime()) at = wallTime(base.y, base.mo, base.d + 1, h, mi, tz);
  return at;
}

/** Local calendar day (YYYY-MM-DD) for the per-day cap on automatic continues. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "4:00", "16:30" (local time); with the date when it isn't within the next day. */
export function clockTime(at: Date, now: Date = new Date()): string {
  const t = `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (at.getTime() - now.getTime() < 20 * 3600_000) return t;
  return `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${t}`;
}

/**
 * Sends the automatic "continue" once a ticket's usage limit has reset. Like the Scheduler it polls state saved on
 * the tickets, so the timers survive a daemon restart and a reset missed while the daemon was down fires on the
 * first tick.
 */
export class LimitWatcher {
  private busy = false;

  constructor(private board: Board, private store: Store, private delayMs = CONTINUE_DELAY_MS) {}

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const p of this.store.listProfiles()) {
        for (const id of this.board.dueContinues(p.slug, this.delayMs)) {
          try {
            await this.board.continueAfterLimit(p.slug, id, { auto: true });
          } catch (e) {
            console.error(`ticket ${p.slug}/${id}: automatic continue after the usage limit failed`, e);
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  start(intervalMs = 30_000): () => void {
    const run = () => this.tick().catch((e) => console.error("limit watcher tick failed", e));
    const timer = setInterval(run, intervalMs);
    run();
    return () => clearInterval(timer);
  }
}
