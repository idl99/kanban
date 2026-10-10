/** The ticket fields these helpers read (kept free of api.ts so tests can import it). */
type Ticket = {
  status: string; outcome: string | null; running?: boolean;
  limit?: { resetAt: string; auto: boolean; capped?: boolean } | null;
};

/** "4:00", "16:30" in local time; with the date when it is a day or more away. */
export function clockTime(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const t = `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (at.getTime() - now < 20 * 3600_000) return t;
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${t}`;
}

/** The ticket is waiting after hitting the usage limit (and Claude isn't working on it again yet). */
export const limitWait = (t: Ticket): boolean => t.outcome === "limit" && t.status !== "in_progress" && !t.running && t.status !== "done";

/** "Limit hit · continues at 4:00" (auto on), "Limit hit · resets 4:00" (off), or "Limit hit" once a continue is on its way. */
export function limitLabel(t: Ticket, now = Date.now()): string {
  if (!t.limit) return "Limit hit";
  const at = clockTime(t.limit.resetAt, now);
  return t.limit.auto ? `Limit hit · continues at ${at}` : `Limit hit · resets ${at}`;
}

/** One line on what happens next, for the drawer banner. */
export function limitHint(t: Ticket, now = Date.now()): string {
  const l = t.limit;
  if (!l) return "A “continue” is on its way to Claude.";
  const at = clockTime(l.resetAt, now);
  if (l.auto) return `After ${at} it sends “continue” once in the same session. It doesn't count as needing you while it waits.`;
  if (l.capped) return `It already continued on its own 3 times today. The limit resets at ${at}; continue it when you're ready.`;
  return `Auto-continue is off for this ticket. The limit resets at ${at}.`;
}
