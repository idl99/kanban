// How the chat groups messages into turns and where time dividers go (kept DOM-free so tests can import it).

/** A new avatar and name line after this long a pause, even when the same speaker goes on. */
export const GROUP_GAP_MS = 10 * 60_000;
/** A "Today 14:05" divider after this long a pause (and at every day change). */
export const DIVIDER_GAP_MS = 60 * 60_000;

/** One row of the timeline: who said it ("claude", "user", "board", "peer:<ticket>"...), when, and whether it is a reply Claude wrote. */
export interface TurnItem { speaker: string; at: string; reply?: boolean }

/**
 * start: the first row of a turn (shows the avatar and name line). lastReply: the turn's last reply (its actions row
 * stays visible on a phone). divider: the label of a time divider shown before the row, or null.
 */
export interface TurnLayout { start: boolean; lastReply: boolean; divider: string | null }

const ms = (iso: string) => (iso ? Date.parse(iso) : NaN);
const dayKey = (t: number) => new Date(t).toDateString();

export function layoutTurns(items: TurnItem[], now = Date.now()): TurnLayout[] {
  const out: TurnLayout[] = [];
  let lastReply = -1;
  items.forEach((it, i) => {
    const prev = items[i - 1];
    const t = ms(it.at), p = prev ? ms(prev.at) : NaN;
    const gap = Number.isFinite(t) && Number.isFinite(p) ? t - p : 0;
    const dayChange = Number.isFinite(t) && (!prev || (Number.isFinite(p) && dayKey(t) !== dayKey(p)));
    const divider = Number.isFinite(t) && (dayChange && !!prev || gap >= DIVIDER_GAP_MS) ? dividerLabel(it.at, now) : null;
    const start = !prev || prev.speaker !== it.speaker || gap >= GROUP_GAP_MS || !!divider;
    if (start) lastReply = -1;
    out.push({ start, lastReply: false, divider });
    if (it.reply) {
      if (lastReply >= 0) out[lastReply].lastReply = false;
      out[i].lastReply = true;
      lastReply = i;
    }
  });
  return out;
}

/** "Today 14:05", "Yesterday 09:12", else "Sun 20 Oct, 21:00" (in the browser's language). */
export function dividerLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (dayKey(d.getTime()) === dayKey(now)) return `Today ${time}`;
  if (dayKey(d.getTime()) === dayKey(now - 86_400_000)) return `Yesterday ${time}`;
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The steps line under a reply: running "Step 4 · Reading api.ts", done "Did 6 steps · ran the tests"; failed: how many errored. */
export function stepsSummary(items: { text: string; error?: true }[], running: boolean): { text: string; failed: number } {
  const last = items.at(-1)?.text ?? "";
  const failed = items.filter((t) => t.error).length;
  const n = items.length;
  return { text: running ? `Step ${n} · ${last}` : `Did ${n} step${n === 1 ? "" : "s"} · ${last}`, failed };
}

/** A message another ticket's Claude sent, as the board labels it (src/server/session.ts fromTicketText): its sender and text. */
export function fromTicket(text: string): { ticketId: string; title: string; text: string } | null {
  const m = /^Message from ticket (t_[\w-]+) \("([\s\S]*?)"\): ([\s\S]*)$/.exec(text);
  return m ? { ticketId: m[1], title: m[2], text: m[3].trim() } : null;
}
