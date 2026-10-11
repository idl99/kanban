import type { TeammateProposal } from "./teammate-proposal";

export type Status = "backlog" | "planning" | "ready" | "in_progress" | "review" | "done";
/** limit: the run ended because the Claude usage/spend limit was hit (see Ticket.limit). */
export type Outcome = null | "done" | "blocked" | "failed" | "stopped" | "needs_input" | "limit";
/** interview: Claude asks clarifying questions before doing the work. auto: just do it. */
export type TicketMode = "interview" | "auto";

export const STATUSES: Status[] = ["backlog", "planning", "ready", "in_progress", "review", "done"];

export interface Profile {
  name: string;
  slug: string;
  path: string;
  baseBranch: string;
  maxParallel: number;
  model?: string | null;
  createdAt: string;
  /** Git-ignored files (paths or globs relative to the board folder) copied into each new worktree. */
  copyFiles?: string[];
  /** Runs in each new worktree (user's shell) after copyFiles, before Claude starts. */
  setupCommand?: string;
  /** Runs in a worktree before the board removes it. */
  cleanupCommand?: string;
  /** What auto-detection last found; missing: detection never ran (the board runs it on start). */
  setupDetected?: SetupDetection | null;
  /**
   * Unattended runs may start a review huddle by themselves (start_huddle) before landing important or risky work.
   * Missing: on (see autoHuddlesOn).
   */
  autoHuddles?: boolean;
  /** Spending cap per run in USD (claude --max-budget-usd) for its tickets' work runs. Missing/null: none. */
  runCapUsd?: number | null;
}

/** Board setting "Auto huddles": on unless turned off. */
export const autoHuddlesOn = (p: Pick<Profile, "autoHuddles"> | null | undefined): boolean => p?.autoHuddles !== false;

/**
 * A review huddle the ticket's unattended run started by itself (start_huddle). waiting: another auto huddle is live
 * on the board, so the ticket waits in In Progress and the board wakes it when that one ends. live: huddleId runs.
 */
export interface AutoHuddle {
  state: "waiting" | "live";
  reason: string;
  template: string;
  at: string;
  huddleId?: string | null;
  /** Budget the run asked for (already capped); the slot wake passes it back to start_huddle. */
  maxCostUsd?: number;
}

/** Worktree setup values detected from the board folder (see worktree-setup.ts). */
export interface SetupDetection {
  at: string;
  copyFiles: string[];
  setupCommand: string;
  /** Lockfiles the setup command came from, e.g. "bun.lock", "web/bun.lock". */
  setupFrom: string[];
}

/** A tool Claude left running in the background (a long Bash call, a subagent). */
export interface BackgroundTask {
  id: string;
  description: string;
  /** When the board first saw it. */
  startedAt: string;
}

export interface Ticket {
  id: string;
  title: string;
  status: Status;
  /** Missing on tickets created before modes existed: treated as "auto". */
  mode?: TicketMode;
  /** True once Claude has asked the user a round of questions on this ticket. */
  interviewed?: boolean;
  /** True once any claude run used this ticket's sessionId (so later runs must --resume). */
  sessionStarted?: boolean;
  /** The next run starts a new session that picks up from the worktree (Start fresh session after a lost session). */
  freshSession?: boolean;
  /** True once a refine conversation began (auto-start on entering Planning happens only once). */
  refineStarted?: boolean;
  order: number;
  sessionId: string | null;
  worktree: string | null;
  /** Folder of a linked pre-existing Claude session (runs happen here instead of a worktree). */
  workdir?: string | null;
  branch: string | null;
  prUrl: string | null;
  /** Last fetched state of prUrl's PR (checks, conflicts, reviews); stale once pr.url differs from prUrl. */
  pr?: PrStatus | null;
  outcome: Outcome;
  lastActivity: string | null;
  lastRunAt: string | null;
  /** When the current run or chat reply started; null when Claude is not working. Missing on old tickets. */
  runStartedAt?: string | null;
  /** Claude ended its turn and waits for these background tasks; it resumes when they finish. */
  waitingOn?: BackgroundTask[] | null;
  runCount: number;
  error: string | null;
  /** Non-fatal heads-up about how the ticket runs (e.g. no worktree yet); the user can dismiss it. */
  notice?: string | null;
  /** Model for this ticket's runs, set with /model in its chat; overrides the board's model. */
  model?: string | null;
  /** Set on tickets created by a schedule (see Schedule). */
  scheduleId?: string | null;
  /** Planner ticket whose Planning chat proposed this one. Missing on most tickets. */
  parentId?: string | null;
  /** Short name siblings use in dependsOn (from the planner's proposal). */
  planKey?: string | null;
  /** Siblings (ticket id or planKey) that must be done before a running plan starts this ticket. */
  dependsOn?: string[];
  /**
   * Exclusive resources this ticket's runs use (e.g. "emulator"), lowercase. Tickets that need the same one never
   * run at the same time, on any board of this machine; it adds no order (that is dependsOn).
   */
  needs?: string[];
  /** Ticket this one was branched from (a copy of its conversation and committed code). Not a plan parent. */
  branchedFrom?: string | null;
  /** When the branch was made: conversation entries before this are the copied history. */
  branchPoint?: BranchPoint | null;
  /** Set on a planner ticket once its plan was started: the board runs its children unattended. */
  plan?: Plan | null;
  /** Chat messages sent while Claude was working that it has not read yet, oldest first. */
  queued?: QueuedMessage[];
  /** A chat reply the daemon cut off by restarting (or held back while a restart waited); recover() resumes it. */
  interrupted?: Interrupted | null;
  /**
   * A chat reply waiting for a free run slot: the card shows In Progress, queued, and dispatch() starts it before
   * Ready tickets. from: where the card was, so Stop puts it back.
   */
  slotWait?: { at: string; from: Pick<Ticket, "status" | "outcome"> } | null;
  /** ⭐ Important: set by the user (or Claude when the user says so); unattended runs review it in an auto huddle before landing. */
  important?: boolean;
  /** The auto huddle this ticket's run started or waits for; the card stays In Progress until it ends. */
  autoHuddle?: AutoHuddle | null;
  /** Set with outcome "limit": when the limit resets and whether the board sends "continue" then (see limit.ts). */
  limit?: LimitHit | null;
  /** Per-run spending cap for this ticket, overriding the board's: a positive amount, 0 for none. Missing/null: the board's. */
  runCapUsd?: number | null;
  /** The last run stopped at its spending cap (outcome "blocked"); cleared when the next run starts. */
  capHit?: { capUsd: number; at: string } | null;
  /** Cap for the next run only ("Continue with +$Y"), then cleared. */
  capNextUsd?: number | null;
  /** false: the user turned automatic continues off for this ticket ("Don't auto-continue"). Missing: on. */
  autoContinue?: boolean;
  /** Automatic continues sent on day (local YYYY-MM-DD), for the per-day cap. */
  autoContinued?: { day: string; count: number } | null;
  /** Output files the user published as claude.ai pages from the Outputs tab, one link per file. */
  shareLinks?: ShareLink[];
  /** Teammate cards in this ticket's chat (propose_teammate) the user answered, by entry uuid (the tool_use id). */
  teammateCards?: Record<string, TeammateCardState>;
  createdAt: string;
  updatedAt: string;
  body: string;
}

/** A run hit the Claude usage/spend limit. */
export interface LimitHit {
  /** When the limit resets (from the message, else the next full hour). */
  resetAt: string;
  /** The board sends "continue" at resetAt + 1 minute. */
  auto: boolean;
  /** Auto is off because the ticket already used its automatic continues today. */
  capped?: boolean;
  /** When the run hit it. */
  at: string;
  /** Claude's limit message, as shown in the run. */
  message: string;
}

export interface PrCheck {
  name: string;
  state: "pass" | "fail" | "pending" | "skipped";
  /** Details page (an Actions job log for GitHub Actions checks). */
  url: string | null;
  /** When it finished, or started while running. */
  at: string | null;
}

/** A ticket's pull request as `gh pr view` last reported it (see prstatus.ts). */
export interface PrStatus {
  url: string;
  number: number | null;
  state: "OPEN" | "MERGED" | "CLOSED" | null;
  checks: PrCheck[];
  failing: number;
  pending: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  conflicts: boolean;
  mergeStateStatus: string | null;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or null when no review is required. */
  reviewDecision: string | null;
  comments: number;
  fetchedAt: string;
}

/** What the user did with a proposed teammate: saved it (as `name`, for all boards or this board) or dismissed it. */
export interface TeammateCardState {
  state: "saved" | "dismissed";
  name?: string;
  scope?: "global" | "board";
  at: string;
}

export interface ShareLink {
  /** Path relative to the outputs folder. */
  file: string;
  url: string;
  at: string;
}

export interface BranchPoint {
  at: string;
  /** Source title at branch time (shown if the source is deleted later). */
  sourceTitle: string;
}

/** Recurring ticket template: on each cron tick the board creates a ticket from it and runs it. */
export interface Schedule {
  id: string;
  name: string;
  /** Ticket title; `{date}` and `{time}` are filled in when it fires. */
  title: string;
  /** Ticket description (the prompt). */
  body: string;
  mode: TicketMode;
  cron: string;
  enabled: boolean;
  /** Skip a fire while the previous ticket from this schedule is still queued or running. */
  skipIfRunning: boolean;
  createdAt: string;
  updatedAt: string;
  lastFiredAt: string | null;
  /** Null while paused. */
  nextRunAt: string | null;
  /** Why the last fire could not create its ticket (cleared by the next successful fire). */
  lastError: string | null;
}

export type ScheduleTrigger = "schedule" | "missed" | "manual";

/** Who changed a schedule: the user (board UI, CLI, Claude outside a run) or the board run of a ticket. */
export type ScheduleEditor = "user" | { ticketId: string };

export type ScheduleEditAction = "created" | "updated" | "paused" | "resumed";

/** Fields whose old value an "updated" entry keeps, so a bad edit (e.g. a run rewriting its own prompt) can be undone. */
export type SchedulePrevious = Partial<Pick<Schedule, "title" | "body" | "cron">>;

export type ScheduleHistoryEntry =
  | { at: string; kind: "fired"; trigger: ScheduleTrigger; ticketId: string }
  | { at: string; kind: "skipped"; trigger: ScheduleTrigger; ticketId: string | null }
  | { at: string; kind: "error"; trigger: ScheduleTrigger; message: string }
  | { at: string; kind: "edited"; action: ScheduleEditAction; fields: string[]; by: ScheduleEditor; previous?: SchedulePrevious };

export interface Interrupted {
  at: string;
  mode: "refine" | "act";
  /** A reply to another ticket's Claude: the card stays as it was. */
  quiet?: boolean;
  /** What Claude had written of its reply when it was cut off (shown greyed until the resumed reply arrives). */
  partial?: string;
  /** Claude never got this prompt (cut off during setup, or held while a restart waited): send it again as is. */
  prompt?: { text: string; raw?: boolean };
  /** Held back while a restart waited, not cut off: resumed without the interruption note. */
  held?: boolean;
  /** The reply answers a message the user typed (see ActiveRun.chat.user); the resumed run keeps its rights. */
  user?: boolean;
}

export interface QueuedMessage {
  id: string;
  text: string;
  at: string;
  /** queued: Claude reads it at its next step. unsent: the run was stopped first; the user sends or discards it. */
  state: "queued" | "unsent";
  /**
   * From another ticket's Claude (ask_ticket / a late reply): sent as-is, without the ticket-chat note, and
   * a reply run it starts leaves the card, outcome and run count alone.
   */
  peer?: boolean;
  /** Sent by a planner's run (chat_ticket), not typed by the user: the reply run gets no planner rights of its own. */
  fromPlanner?: boolean;
  /**
   * The text is a slash command Claude Code runs itself (see commands.ts): sent alone, without the board's note.
   * local: a built-in that runs without a model turn (/compact), so Claude never echoes it back.
   */
  slash?: "prompt" | "local";
  /** From the ticket's own auto huddle (findings, the budget brake) or a freed auto-huddle slot: sent as-is, run as its work. */
  hostWake?: boolean;
}

/** A question one ticket's Claude asked another's (ask_ticket), kept per board in questions.json. */
export interface TicketQuestion {
  id: string;
  /** Asking ticket. */
  from: string;
  /** Ticket whose Claude is asked. */
  to: string;
  text: string;
  askedAt: string;
  /** The asker's ask_ticket call waits for the reply until then. */
  waitUntil: string;
  /** The asker's call is still waiting (false once it took the reply or gave up). */
  waiting: boolean;
  reply: string | null;
  repliedAt: string | null;
  /** How the reply reached the asker: its waiting call, a message into its run, or a comment for its next run. */
  delivered: null | "call" | "steer" | "comment";
}

export interface Comment {
  id: string;
  author: "user" | "ai";
  text: string;
  at: string;
}

export interface Config {
  port: number;
  prPollMinutes: number;
  /** Loopback port `tailscale serve` points at for phone access (default port + 1, see remote.ts). */
  remotePort?: number;
}

export interface OutputFile {
  name: string;
  size: number;
  updatedAt: string;
}

export interface ActivityEntry {
  run: number;
  at: string;
  event: any;
}

export type PlanState = "running" | "paused" | "finishing" | "done" | "stuck";

/** A planner's unattended run of its child tickets (see plan.ts and Board.advancePlans). */
export interface Plan {
  state: PlanState;
  /** Children of this plan in Ready or In progress at once. */
  maxConcurrent: number;
  /** Times the planner's Claude session was woken up (capped, see plan.ts). */
  wakeups: number;
  startedAt: string;
  finishedAt?: string | null;
  /** Children when the plan started; the planner may add up to the same number again. */
  originalCount: number;
  /** Child events waiting for the planner's next wake-up, so several arrive as one message. */
  inbox?: string[];
  /** Last child state the planner was told about, per child id, so it is told once. */
  seen?: Record<string, string>;
  /** Planner restarts of a child that already ran, per child id (capped). */
  retries?: Record<string, number>;
  /** The planner was woken and its reply decides what happens next. */
  awaiting?: "event" | "final" | null;
  /** Why the plan is stuck. */
  reason?: string | null;
}

// ---- Huddles: several Claude sessions working on one ticket in a shared message room (see huddle.ts) ----

export type HuddleStatus = "live" | "stopped" | "closed";
/**
 * Why a huddle stopped by itself (none: the user stopped it). budget: maxCostUsd spent. messages: maxMessages posted.
 * loop: too many messages without the user (routing paused, runs keep going).
 */
export type HuddleStopReason = "budget" | "messages" | "loop";
/** tagged: sleeps until @mentioned. monitor: every new message reaches its live session at its next turn boundary. */
export type HuddleMode = "tagged" | "monitor";
/** shared: the host ticket's worktree. own: a new git worktree branched off the host ticket's branch. */
export type HuddleWorkspace = "shared" | "own";
/** done: finished its job, only a lead, @main or the user wakes it again. blocked: waiting on something (statusReason). */
export type HuddleParticipantStatus = "working" | "idle" | "stopped" | "failed" | "done" | "blocked";
/** agent: a headless session the huddle runs. ticket-main: a ticket's own session (the host's is @main). human: the user (@you). */
export type HuddleParticipantKind = "agent" | "ticket-main" | "human";

export interface HuddleParticipant {
  /** Unique in the huddle, used in @mentions: main, reviewer, qa-1, api-main, you. */
  handle: string;
  role: string;
  /** Preset it was made from (see huddle-presets.ts) and that preset's prompt. */
  preset: string | null;
  prompt: string;
  /** What this participant should look at (from the roster). */
  focus?: string;
  model: string | null;
  mode: HuddleMode;
  /** May add participants and manage findings. The coordinator (@main) always may. */
  lead: boolean;
  /** May edit tracked files; only the coordinator (and agents in their own worktree) by default. */
  canEdit: boolean;
  workspace: HuddleWorkspace;
  /**
   * workspace own: its worktree and branch, once made. A read-only agent in the shared workspace: its detached
   * snapshot worktree at the host branch's HEAD (branch stays null), refreshed at every wake.
   */
  worktree?: string | null;
  branch?: string | null;
  /** Read-only snapshot: the host branch and the commit it shows (see huddle.ts snapshot()). */
  snapshot?: { branch: string | null; sha: string } | null;
  /** Its own Claude session (agents only; a ticket-main uses its ticket's session). */
  sessionId: string | null;
  sessionStarted?: boolean;
  status: HuddleParticipantStatus;
  /** done / blocked: why, as the participant said it (huddle_status or huddle_post). */
  statusReason?: string | null;
  kind: HuddleParticipantKind;
  /** ticket-main: the ticket whose session this is. */
  ticketId?: string | null;
  /** seq of the last message it was given (or posted); later ones are unread. */
  cursor: number;
  joinedAt: string;
  lastActivity?: string | null;
  /**
   * What its runs cost so far, and the session's running total at its last result (results carry running totals).
   * Agents: every run. The coordinator (@main): the runs the huddle woke it for.
   */
  costUsd?: number;
  sessionCostUsd?: number;
  error?: string | null;
  /** When its last run or turn ended (the huddle's idleSince). */
  idleAt?: string | null;
  /** A daemon restart cut its turn off (or held it back while a restart was pending): recover() resumes it. */
  interrupted?: boolean;
  /** Secret the agent's run proves its identity with (CKANBAN_HUDDLE_AGENT); never sent to clients. */
  token?: string;
}

export interface HuddleFinding {
  id: string;
  text: string;
  by: string;
  status: "open" | "resolved";
  resolvedBy: string | null;
  at: string;
}

export interface Huddle {
  id: string;
  /** Ticket whose work the huddle is about; its session is @main, the coordinator. */
  hostTicket: string;
  status: HuddleStatus;
  maxParticipants: number;
  participants: HuddleParticipant[];
  findings: HuddleFinding[];
  /** Other tickets (same board) whose main session was invited. */
  invited: string[];
  /** Highest message seq so far. */
  seq: number;
  /** Spending limit (all participants' costUsd): at 80% the leads are warned, at 100% the huddle stops (default 20). */
  maxCostUsd?: number;
  /** Non-system messages before the huddle stops (default 150). */
  maxMessages?: number;
  /** Non-system messages so far, and since the user last posted or resumed (agent-only stretch). */
  posts?: number;
  sinceUser?: number;
  /** The 80% budget warning went out. */
  budgetWarned?: boolean;
  /** Two participants who kept answering each other: they no longer wake each other until a lead, @main or the user tags them, or Resume. */
  held?: string[] | null;
  /** Tags that didn't wake their target (done, blocked or stopped), noted once each: target handle -> senders. Cleared when the target wakes. */
  unwoken?: Record<string, string[]>;
  /** Seq of the last non-system message the idle watchdog already woke @main about. */
  idleNudged?: number;
  stopReason?: HuddleStopReason | null;
  /** @main or a lead asked the user to close the huddle (huddle_close); only the user closes it. */
  closeRequest?: { by: string; at: string; reason: string } | null;
  /** Pinned brief (goal, decisions) the leads, @main and the user keep current; it heads every digest. */
  brief?: { text: string; by: string; at: string } | null;
  /** Template the huddle was started from (see huddle-templates.ts). */
  template?: string | null;
  /** Started by the host ticket's unattended run (start_huddle), with its reason; @main may close it itself. */
  auto?: { reason: string } | null;
  /** Lessons agents proposed when they turned done; only the user saves them as role notes (see huddle-notes.ts). */
  learnings?: HuddleLearning[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
}

/**
 * A lesson an agent proposed with huddle_status done. target: where it goes when saved, "_all" (every role), a preset
 * name, or "new" (a new board preset made from the agent's ad-hoc role); once saved, the preset it went to.
 */
export interface HuddleLearning {
  id: string;
  from: string;
  role: string;
  preset: string | null;
  text: string;
  evidence: string;
  scope: "general" | "repo";
  status: "pending" | "saved" | "discarded";
  target: string;
  at: string;
  /** Saved as the first note of a new preset made from the ad-hoc role. */
  newRole?: boolean;
  /**
   * A teammate the agent proposed (propose_teammate) instead of a lesson: text is its why, scope general saves it for
   * all boards, repo for this board; once saved, target is its name.
   */
  teammate?: TeammateProposal;
}

export type HuddleMessageKind = "message" | "finding" | "system";
/** Where a post came in from: the board UI, the MCP server or CLI (BoardClient), or a request with neither header (e.g. curl). */
export type HuddleSource = "ui" | "mcp" | "none";

export interface HuddleMessage {
  id: string;
  seq: number;
  ts: string;
  /** Handle of the sender, stamped by the daemon from the calling run's identity (never from tool input). "system" for system messages. */
  from: string;
  text: string;
  /** Handles mentioned with @handle; "all" for @all. */
  mentions: string[];
  kind: HuddleMessageKind;
  /** Posts only (system messages have none). */
  source?: HuddleSource;
}

/** The spending cap a ticket's next work run gets (claude --max-budget-usd), or null for none. */
export function runCapFor(t: Pick<Ticket, "runCapUsd" | "capNextUsd">, p: Pick<Profile, "runCapUsd"> | null | undefined): number | null {
  const pos = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);
  if (pos(t.capNextUsd)) return t.capNextUsd!;
  if (t.runCapUsd === 0) return null;
  return pos(t.runCapUsd) ?? pos(p?.runCapUsd);
}
