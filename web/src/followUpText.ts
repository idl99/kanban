// Words for a ticket's follow-up (Claude comes back to it later): the card badge, its menu and its history.
// No imports from ./api: the server's tests import this file, and api.ts needs the browser's types.

interface FollowUpLike { dueAt: string; missedAt?: string | null }
interface LogEntry { at: string; kind: string; dueAt?: string; note?: string; by?: string; costUsd?: number }

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Tue 20 Oct 09:00", local time. */
export function followUpDate(iso: string): string {
  const d = new Date(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${hm(d)}`;
}

/** When, the way the badge says it: "in 8 min", "in 4 hours", "today 18:00", "tomorrow 09:00", "Thu 09:00", "2 Nov 09:00". */
export function followUpWhen(iso: string, now: Date): string {
  const d = new Date(iso);
  const mins = Math.round((d.getTime() - now.getTime()) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `in ${mins} min`;
  if (mins < 6 * 60) {
    const h = Math.round(mins / 60);
    return `in ${h} hour${h === 1 ? "" : "s"}`;
  }
  const days = Math.round((startOfDay(d) - startOfDay(now)) / (24 * 3600_000));
  if (days === 0) return `today ${hm(d)}`;
  if (days === 1) return `tomorrow ${hm(d)}`;
  if (days < 7) return `${DAYS[d.getDay()]} ${hm(d)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm(d)}`;
}

/** The card badge: "Follows up tomorrow 09:00", "Missed follow-up", or "Follows up soon" once it is due (Claude is busy). */
export function followUpLabel(f: FollowUpLike, now: Date): string {
  if (f.missedAt) return "Missed follow-up";
  return new Date(f.dueAt).getTime() <= now.getTime() ? "Follows up soon" : `Follows up ${followUpWhen(f.dueAt, now)}`;
}

/** "2 so far · $0.21": follow-ups woken and what their runs cost. */
export function followUpCount(log: LogEntry[] | undefined): string {
  const woke = (log ?? []).filter((e) => e.kind === "woke");
  const cost = woke.reduce((n, e) => n + (e.costUsd ?? 0), 0);
  return `${woke.length} so far · $${cost.toFixed(2)}`;
}

/** One history line, in plain words. */
export function followUpLine(e: LogEntry): string {
  const when = followUpDate(e.at);
  switch (e.kind) {
    case "set": return `${when} · Follow-up set for ${e.dueAt ? followUpDate(e.dueAt) : "later"}`;
    case "woke": return `${when} · Claude followed up${e.costUsd !== undefined ? ` ($${e.costUsd.toFixed(2)})` : ""}`;
    case "replied": return `${when} · You wrote in the chat`;
    case "missed": return `${when} · Missed: the board was off when it was due`;
    case "cancelled":
      return e.by === "user" ? `${when} · You stopped it`
        : e.by === "reply" ? `${when} · Cancelled because you replied`
        : `${when} · Claude stopped${e.note ? `: ${e.note}` : ""}`;
    default: return when;
  }
}

/** The last few history lines, oldest first. */
export function followUpHistory(log: LogEntry[] | undefined, n = 5): string[] {
  return (log ?? []).slice(-n).map(followUpLine);
}
