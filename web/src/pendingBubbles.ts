// Which chat bubble shows a message the user just sent (kept DOM-free so the root typecheck and tests can import it).

/** A sent message not yet in the session file. steer: sent while Claude was working. */
export interface Pending { text: string; steer: boolean }
/** The fields used here of api.ts's QueuedMessage. */
interface Queued { text: string; state: "queued" | "unsent"; peer?: boolean }
/** The fields used here of api.ts's SessionEntry. */
interface Entry { role: "user" | "assistant"; text: string; at: string }

// Image links reach the session as local file paths, so compare by file name.
export const norm = (s: string) => s.trim().replace(/\S*\/attachments\/([0-9a-f]{32}\.\w+)/g, "$1");

/** The message that started Claude's reply, held by the board until Claude reads it: its plain bubble already shows it. */
export const heldByReply = (q: Queued, pending: Pending[]) => q.state === "queued" && pending.some((p) => !p.steer && p.text === q.text);

/** Stop came before Claude read the reply's message: the board keeps it unsent, and that bubble replaces the plain one. */
export const unsentNow = (pending: Pending[], queued: Queued[]) =>
  pending.filter((p) => !p.steer && queued.some((q) => !q.peer && q.state === "unsent" && q.text === p.text));

/**
 * The session already shows a message the board still holds (Claude's echo comes later, or at the end of its turn):
 * its timeline bubble shows it. Only entries from when it was queued on count, so an older message with the same text doesn't.
 */
export const inSession = (q: Queued & { at: string }, entries: Entry[]) =>
  q.state === "queued" && entries.some((e) => e.role === "user" && Date.parse(e.at) >= Date.parse(q.at) && norm(e.text) === norm(q.text));
