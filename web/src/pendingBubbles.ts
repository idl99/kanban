// Which chat bubble shows a message the user just sent (kept DOM-free so the root typecheck and tests can import it).

/** A sent message not yet in the session file. steer: sent while Claude was working. */
export interface Pending { text: string; steer: boolean }
/** The fields used here of api.ts's QueuedMessage. */
interface Queued { text: string; state: "queued" | "unsent"; peer?: boolean }

/** The message that started Claude's reply, held by the board until Claude reads it: its plain bubble already shows it. */
export const heldByReply = (q: Queued, pending: Pending[]) => q.state === "queued" && pending.some((p) => !p.steer && p.text === q.text);

/** Stop came before Claude read the reply's message: the board keeps it unsent, and that bubble replaces the plain one. */
export const unsentNow = (pending: Pending[], queued: Queued[]) =>
  pending.filter((p) => !p.steer && queued.some((q) => !q.peer && q.state === "unsent" && q.text === p.text));
