import type { HuddleView } from "./huddle";
import type { McpState } from "./mcp";
import type { QuickChatView } from "./quickchat";
import type { SessionSummary } from "./session";
import type { HuddleMessage, Job, Profile, Schedule, Ticket } from "./types";

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
  /** An automation loop was created, changed (checked, fired, edited) or deleted (loop: null); `loop` is its LoopView. */
  | { type: "loop.updated"; profile: string; id: string; loop: unknown | null }
  /** An integration account was added, signed in, changed or removed; clients refetch. */
  | { type: "integration.updated" }
  /** A one-time job was created, changed (fired, finished, missed, edited) or cancelled. */
  | { type: "job.updated"; profile: string; id: string; job: Job | null }
  /** Prompt snippets changed (any scope); clients refetch. */
  | { type: "snippets.updated" }
  /** A daemon restart is waiting for `waiting` active runs; nothing new starts until then. */
  | { type: "restart.updated"; pending: boolean; waiting: number }
  /** The daemon started or stopped keeping the Mac awake for active work (awake.ts). */
  | { type: "awake.updated"; held: boolean }
  /** What the board learned on its own changed (learn.ts): a lesson saved or noted, a tidy step, an undo. profile null: notes every board shares. */
  | { type: "learned.updated"; profile: string | null }
  /** A huddle's status, roster or findings changed. */
  | { type: "huddle.updated"; profile: string; huddle: HuddleView }
  /** A message was posted in a huddle. */
  | { type: "huddle.message"; profile: string; huddleId: string; message: HuddleMessage }
  /** What a huddle participant is doing now (lastActivity), without a whole huddle.updated. */
  | { type: "huddle.activity"; profile: string; huddleId: string; handle: string; lastActivity: string | null; liveCostUsd?: number; contextTokens?: number }
  /** A huddle agent's session file changed (the session viewer refetches; polled, so at most every 2 s). */
  | { type: "huddle.session"; profile: string; huddleId: string; handle: string }
  /** A quick chat was created, changed (message, reply ended, renamed, made a ticket) or deleted (chat: null). */
  | { type: "chat.updated"; profile: string; id: string; chat: QuickChatView | null }
  /** Text Claude is writing right now in a quick chat; same rules as "draft". */
  | { type: "chat.draft"; profile: string; id: string; text: string; final?: string }
  /** A quick chat's run moved on (its conversation may have grown); activity: what Claude does now. */
  | { type: "chat.activity"; profile: string; id: string; activity: string | null };

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
