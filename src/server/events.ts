import type { HuddleView } from "./huddle";
import type { McpState } from "./mcp";
import type { SessionSummary } from "./session";
import type { HuddleMessage, Profile, Schedule, Ticket } from "./types";

export type BusEvent =
  | { type: "ticket.updated"; profile: string; ticket: Ticket }
  | { type: "ticket.deleted"; profile: string; id: string }
  | { type: "activity"; profile: string; id: string; run: number; event: unknown }
  | { type: "profile.updated"; slug: string; profile: Profile | null }
  | { type: "session.updated"; profile: string; id: string; session: SessionSummary }
  /** Text Claude is writing right now in this ticket's run ("" = cleared). Not persisted.
   * final: on a clear, the complete text of the message that just ended (shown until its saved copy loads). */
  | { type: "draft"; profile: string; id: string; text: string; final?: string }
  /** Connections panel: cached `claude mcp list` result, login progress. */
  | { type: "mcp.updated"; state: McpState }
  /** A schedule was created, changed (fired, paused, edited) or deleted (schedule: null). */
  | { type: "schedule.updated"; profile: string; id: string; schedule: Schedule | null }
  /** Prompt snippets changed (any scope); clients refetch. */
  | { type: "snippets.updated" }
  /** A daemon restart is waiting for `waiting` active runs; nothing new starts until then. */
  | { type: "restart.updated"; pending: boolean; waiting: number }
  /** A huddle's status, roster or findings changed. */
  | { type: "huddle.updated"; profile: string; huddle: HuddleView }
  /** A message was posted in a huddle. */
  | { type: "huddle.message"; profile: string; huddleId: string; message: HuddleMessage }
  /** What a huddle participant is doing now (lastActivity), without a whole huddle.updated. */
  | { type: "huddle.activity"; profile: string; huddleId: string; handle: string; lastActivity: string | null; liveCostUsd?: number; contextTokens?: number }
  /** A huddle agent's session file changed (the session viewer refetches; polled, so at most every 2 s). */
  | { type: "huddle.session"; profile: string; huddleId: string; handle: string };

export class Bus {
  private listeners = new Set<(e: BusEvent) => void>();

  on(fn: (e: BusEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: BusEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error("bus listener error", err);
      }
    }
  }
}
