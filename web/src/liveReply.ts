/** The fields used here of api.ts's SessionEntry (kept DOM-free so the root typecheck and tests can import it). */
interface Entry { role: "user" | "assistant"; kind: string; text: string; peer?: unknown }

/** What to show of a half-written reply: hide board blocks (questions/proposal JSON) and the result line. */
export function liveView(text: string): { text: string; preparing: string | null } {
  const cut = text.indexOf("<ckanban-");
  const visible = (cut >= 0 ? text.slice(0, cut) : text).replace(/^CKANBAN_RESULT.*$/gm, "").trim();
  if (cut < 0) return { text: visible, preparing: null };
  const rest = text.slice(cut);
  return {
    text: visible,
    preparing: rest.startsWith("<ckanban-questions") ? "Preparing questions…"
      : rest.startsWith("<ckanban-mockup") ? "Drawing mockup…"
      : rest.startsWith("<ckanban-tickets") ? "Preparing tickets…"
      : rest.startsWith("<ckanban-ticket") ? "Preparing ticket proposal…" : null,
  };
}

/** Reply text compared loosely: no result line, whitespace collapsed. */
export const flat = (s: string) => s.replace(/^.*CKANBAN_RESULT.*$/gm, "").replace(/\s+/g, " ").trim();

/** A finished live reply kept on screen until the conversation shows its saved copy. */
export type Handoff = { text: string; flat: string; at: number; count: number };

export function handoff(final: string, count: number, at = Date.now()): Handoff {
  return { text: final, flat: flat(liveView(final).text), at, count };
}

/**
 * Adds a finished reply once: the run's end and the stream's last clear can both hand the same reply over, one of them
 * from the last throttled update (a little shorter). The longer copy stays, in the first one's place.
 */
export function withHandoff(hs: Handoff[], h: Handoff): Handoff[] {
  const i = hs.findIndex((x) => x.text.startsWith(h.text) || h.text.startsWith(x.text));
  if (i < 0) return [...hs, h];
  if (hs[i].text.length >= h.text.length) return hs;
  return hs.map((x, j) => (j === i ? { ...h, at: x.at, count: x.count } : x));
}

/** Whether the loaded entries contain the saved copy of a finished live reply. */
export function saved(entries: Entry[], h: Handoff): boolean {
  // Only board blocks (questions, proposal…): nothing to compare, so wait for any new entry.
  if (!h.flat) return entries.length > h.count;
  const recent = entries.filter((e) => e.role === "assistant" && e.kind === "text" && !e.peer).slice(-30);
  // Joined by line breaks: with a space, one reply's result line would run into the next reply's first line
  // and flat() would drop both, so a reply after a result line never matched.
  return flat(recent.map((e) => e.text).join("\n")).includes(h.flat);
}

/** How long a finished live reply waits for its saved copy once the run is over (the file is complete by then). */
export const HANDOFF_AFTER_RUN_MS = 5000;
/** A cap while the run goes on, should a saved copy never match: no stale copy for the rest of a long run. */
export const HANDOFF_RUNNING_MS = 180_000;

/**
 * Whether a finished live reply stops waiting for its saved copy. Claude Code writes a message to the session file
 * only once the whole message ends, tool calls included: a long tool call after the text (a file write, a proposal)
 * keeps the saved copy away for as long as it streams, so while the run goes on the live copy stays.
 */
export function expired(h: Handoff, now: number, endedAt: number | null): boolean {
  if (endedAt === null) return now - h.at >= HANDOFF_RUNNING_MS;
  return now - Math.max(h.at, endedAt) >= HANDOFF_AFTER_RUN_MS;
}

/** Whether the run's status line (an 80-character excerpt of the last text, see summarizeEvent) repeats a reply on screen. */
export function repeats(activity: string | null | undefined, texts: string[]): boolean {
  const a = activity?.replace(/\s+/g, " ").trim();
  if (!a) return false;
  return texts.some((t) => t.replace(/\s+/g, " ").includes(a));
}
