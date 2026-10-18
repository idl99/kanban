// Follow-ups: Claude comes back to its own ticket later (follow_up). The board saves the time on the ticket and, when
// it is due, wakes the same conversation with what happened since (followUpWakePrompt); Claude checks, acts, and sets
// the next follow-up or stops. A board run is `claude -p`, so Claude Code's own timers die with it: the daemon owns this one.
import type { Board } from "./board";
import { parseAt } from "./jobs";
import type { Store } from "./store";
import type { FollowUpLogEntry } from "./types";

/** A follow-up sooner than this is refused as a probable mistake (the watcher ticks every 30 s anyway). */
export const FOLLOW_UP_MIN_MS = 60_000;
/** Seen later than this past its time (computer asleep, board off): not woken, the user decides (FollowUp.missedAt). */
export const FOLLOW_UP_LATE_MS = 12 * 3600_000;
/** Longest follow-up note and stop reason (they show on the card). */
export const FOLLOW_UP_NOTE_MAX = 1000;
export const FOLLOW_UP_REASON_MAX = 300;
/** Furthest ahead a follow-up may be. */
export const FOLLOW_UP_MAX_MS = 366 * 24 * 3600_000;
/** Entries kept in Ticket.followUpLog. */
export const FOLLOW_UP_LOG_KEEP = 50;

export class FollowUpError extends Error {}

const UNITS: Record<string, number> = { m: 60_000, h: 3600_000, d: 24 * 3600_000, w: 7 * 24 * 3600_000 };

/** "30m", "4h", "2d", "1d 6h", "90 minutes" as ms; null when it isn't a delay. */
export function parseDelay(v: string): number | null {
  const s = v.trim().toLowerCase();
  if (!s) return null;
  let total = 0;
  let rest = s;
  const re = /^(\d+(?:\.\d+)?)\s*(minutes?|mins|min|m|hours?|hrs|hr|h|days?|d|weeks?|w)\s*(?:,|and)?\s*/;
  while (rest) {
    const m = re.exec(rest);
    if (!m) return null;
    total += Number(m[1]) * UNITS[m[2][0]];
    rest = rest.slice(m[0].length);
  }
  return total > 0 ? total : null;
}

/** When a follow_up call wants Claude back: after a delay ("4h") or at a time ("2026-10-20 09:00", local). */
export function followUpTime(input: { after?: string | null; at?: string | null }, now: Date): Date {
  const after = input.after?.trim();
  const at = input.at?.trim();
  if (!!after === !!at) throw new FollowUpError("give either after (e.g. \"4h\", \"2d\") or at (e.g. \"2026-10-20 09:00\"), not both");
  let due: Date;
  if (after) {
    const ms = parseDelay(after);
    if (ms === null) throw new FollowUpError(`after must be a delay like "30m", "4h" or "2d", got ${JSON.stringify(after)}`);
    due = new Date(now.getTime() + ms);
  } else {
    try {
      due = parseAt(at);
    } catch (e) {
      throw new FollowUpError((e as Error).message);
    }
  }
  if (!Number.isFinite(due.getTime())) throw new FollowUpError("that time is out of range");
  if (due.getTime() - now.getTime() < FOLLOW_UP_MIN_MS) throw new FollowUpError("a follow-up must be at least 1 minute away");
  if (due.getTime() - now.getTime() > FOLLOW_UP_MAX_MS) throw new FollowUpError("a follow-up can be at most a year away");
  return due;
}

/** The log with one more entry, trimmed to the last FOLLOW_UP_LOG_KEEP. */
export function logFollowUp(log: FollowUpLogEntry[] | undefined, e: FollowUpLogEntry): FollowUpLogEntry[] {
  return [...(log ?? []), e].slice(-FOLLOW_UP_LOG_KEEP);
}

/** Follow-up wakes so far and what they cost (the ones whose run has ended). */
export function followUpSpend(log: FollowUpLogEntry[] | undefined): { count: number; costUsd: number } {
  const woke = (log ?? []).filter((e) => e.kind === "woke");
  return { count: woke.length, costUsd: woke.reduce((n, e) => n + (e.costUsd ?? 0), 0) };
}

/**
 * Wakes tickets whose follow-up is due. Like LimitWatcher it polls state saved on the tickets, so follow-ups survive a
 * daemon restart and one that came due while the daemon was down fires on the first tick (or waits for the user when
 * it is too late, see FOLLOW_UP_LATE_MS).
 */
export class FollowUpWatcher {
  private busy = false;

  constructor(private board: Board, private store: Store) {}

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const p of this.store.listProfiles()) {
        for (const id of this.board.dueFollowUps(p.slug)) {
          try {
            await this.board.wakeFollowUp(p.slug, id);
          } catch (e) {
            console.error(`ticket ${p.slug}/${id}: follow-up wake failed`, e);
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  start(intervalMs = 30_000): () => void {
    const run = () => this.tick().catch((e) => console.error("follow-up watcher tick failed", e));
    const timer = setInterval(run, intervalMs);
    run();
    return () => clearInterval(timer);
  }
}
