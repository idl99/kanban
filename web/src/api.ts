import type { SlashCommand } from "./slashText";
import type { TicketUsage, UsageResult } from "./usage";
import type { Status } from "./columns";
import type { PrStatus } from "./prText";
export type { PrCheck, PrStatus } from "./prText";
export type { Status } from "./columns";
/** limit: the run hit the Claude usage/spend limit (see Ticket.limit). */
export type Outcome = null | "done" | "blocked" | "failed" | "stopped" | "needs_input" | "limit";
export type TicketMode = "interview" | "auto";

export { BOARD_COLUMNS, COLUMNS, waitsForSlot } from "./columns";

/** Start work on a Backlog ticket nobody shaped yet goes through the Planning interview first. */
export function startWorkTarget(t: Ticket): "planning" | "ready" {
  const untouched = !t.refineStarted && !t.interviewed && t.runCount === 0 && !t.workdir && !t.sessionStarted;
  return t.status === "backlog" && untouched ? "planning" : "ready";
}

export interface Health {
  claude: boolean;
  git: boolean;
  gh: boolean;
  /** Server can run the embedded terminal (Bun ≥ 1.3.5). */
  pty?: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
}

/** The Changes tab: a ticket worktree's diff against its merge-base with the base branch (see src/server/diff.ts). */
export interface DiffLine {
  type: "ctx" | "add" | "del";
  text: string;
  old: number | null;
  new: number | null;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "A" | "M" | "D" | "R";
  additions: number;
  deletions: number;
  binary: boolean;
  tooLarge: boolean;
  hunks: { header: string; lines: DiffLine[] }[];
}

export interface TicketDiff {
  base: string;
  mergeBase: string;
  branch: string | null;
  files: DiffFile[];
  additions: number;
  deletions: number;
}

export interface FileContent {
  path: string;
  size: number;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
}

/** What a dock terminal is attached to: the profile's shell, or the quick Claude chat. */
export type PtyKind = "shell" | "claude";

/** WebSocket URL of the profile's interactive shell (or quick Claude chat). */
export const shellSocketUrl = (slug: string, cols: number, rows: number, kind: PtyKind = "shell") =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/profiles/${encodeURIComponent(slug)}/${kind}?cols=${cols}&rows=${rows}`;

export interface QuickChat {
  sessionId: string | null;
  running: boolean;
  /** The session file exists (at least one message was sent). */
  started: boolean;
  title: string | null;
}

export type AttentionKind = "failed" | "limit" | "blocked" | "questions" | "proposal" | "review" | "reply" | "huddle";
/** Why a ticket needs you (one server rule for cards, counts and the Inbox); since: when it started waiting. */
export interface Attention {
  kind: AttentionKind;
  label: string;
  since: string;
}

export interface Profile {
  name: string;
  slug: string;
  path: string;
  baseBranch: string;
  maxParallel: number;
  model?: string | null;
  createdAt: string;
  /** Git-ignored files copied into each new worktree (paths or globs relative to the folder). */
  copyFiles?: string[];
  /** Runs in each new worktree before Claude starts. */
  setupCommand?: string;
  /** Runs in a worktree before it is removed. */
  cleanupCommand?: string;
  /** What auto-detection last found (values equal to it show an "Auto-detected" badge). */
  setupDetected?: SetupDetection | null;
  /** Unattended runs start a review huddle themselves before landing important or risky work. Missing: on. */
  autoHuddles?: boolean;
  /** Spending cap per run in USD for its tickets' work runs; missing/null: none. */
  runCapUsd?: number | null;
  artifacts?: boolean;
  pathExists?: boolean;
  running?: number;
}

export interface Ticket {
  id: string;
  title: string;
  status: Status;
  mode?: TicketMode;
  interviewed?: boolean;
  sessionStarted?: boolean;
  refineStarted?: boolean;
  order: number;
  sessionId: string | null;
  worktree: string | null;
  workdir?: string | null;
  branch: string | null;
  prUrl: string | null;
  /** Last fetched PR status; stale when pr.url differs from prUrl. */
  pr?: PrStatus | null;
  outcome: Outcome;
  lastActivity: string | null;
  lastRunAt: string | null;
  /** When the current run or chat reply started (live elapsed time on the card). */
  runStartedAt?: string | null;
  /** Claude ended its turn and waits for these background tasks; it resumes when they finish. */
  waitingOn?: { id: string; description: string; startedAt: string }[] | null;
  runCount: number;
  error: string | null;
  /** Non-fatal heads-up about how the ticket runs (e.g. no worktree yet); dismissible. */
  notice?: string | null;
  /** Model set for this ticket with /model (overrides the board's). */
  model?: string | null;
  /** Created by this schedule. */
  scheduleId?: string | null;
  /** Planner ticket whose chat proposed this one. */
  parentId?: string | null;
  /** Ticket this one was branched from (copy of its conversation and committed code). */
  branchedFrom?: string | null;
  /** When it was branched: conversation entries before this are the copied history. */
  branchPoint?: { at: string; sourceTitle: string } | null;
  /** Short name siblings use in dependsOn. */
  planKey?: string | null;
  /** Siblings (ticket id or planKey) a running plan finishes before starting this one. */
  dependsOn?: string[];
  /** Exclusive resources (e.g. emulator): tickets needing the same one never run at the same time, on any board. */
  needs?: string[];
  /** For tickets with needs: holds them now, or which ones another ticket holds while this one would start. */
  resources?: { holding: boolean; waitingFor: string[] } | null;
  /** A plan child waiting on the user (questions, a proposal to apply, in Planning); the plan won't start it. */
  userWait?: string | null;
  /** Set once this ticket's plan was started: the board runs its children unattended. */
  plan?: Plan | null;
  /** Messages sent while Claude was working that it has not read yet; "unsent" ones were cut off by Stop. */
  queued?: QueuedMessage[];
  /** A reply a daemon restart cut off; the board resumes it. partial: what Claude had written so far. */
  interrupted?: { at: string; partial?: string; held?: boolean } | null;
  /** A chat reply waiting for a free run slot: shown queued in In Progress. */
  slotWait?: { at: string; from: { status: Status; outcome: Outcome } } | null;
  /** Set with outcome "limit": when it resets and whether the board sends "continue" then. */
  limit?: { resetAt: string; auto: boolean; capped?: boolean; at: string; message: string } | null;
  /** false: automatic continues after the usage limit are off for this ticket. */
  autoContinue?: boolean;
  /** Per-run spending cap for this ticket: a positive amount, 0 for none; missing/null: the board's. */
  runCapUsd?: number | null;
  /** The last run stopped at its spending cap. */
  capHit?: { capUsd: number; at: string } | null;
  /** Cap for the next run only ("Continue with +$Y"). */
  capNextUsd?: number | null;
  /** API-equivalent $ so far (In Progress and Review cards; null otherwise). */
  costUsd?: number | null;
  /** Spending cap its next work run gets (null: none). */
  runCap?: number | null;
  /** Its run takes one of the board's maxParallel slots. */
  holdsSlot?: boolean;
  /** ⭐ Important: unattended runs review it in an auto huddle before landing. */
  important?: boolean;
  /** The auto huddle its run started (live) or waits for (waiting, another one has the board's slot). */
  autoHuddle?: { state: "waiting" | "live"; reason: string; template: string; at: string; huddleId?: string | null } | null;
  createdAt: string;
  updatedAt: string;
  body: string;
  running?: boolean;
  /** Linked session currently open in a terminal. */
  terminalOpen?: boolean;
  /** The last run's error has a one-click fix: Start fresh session (session_missing) or Take over here (session_open). */
  recovery?: "session_missing" | "session_open" | null;
  resumeCommand?: string | null;
  session?: SessionSummary | null;
  /** Why the ticket is waiting on you ("Your turn"), computed by the server. */
  attention?: Attention | null;
  /** Its own huddle is working: the card shows the huddle badge instead of an outcome badge. */
  huddleBusy?: boolean;
  /** Output files published as claude.ai pages from the Share menu, one link per file. */
  shareLinks?: ShareLink[];
  /** Teammate cards in the chat the user answered, by entry uuid (src/server/types.ts). */
  teammateCards?: Record<string, TeammateCardState>;
  /** Share menu publishes in progress (or the last one's error), per output file. */
  shareJobs?: ShareJob[];
  /** Absolute path of the ticket's outputs folder. */
  outputDir?: string;
  /** The daemon can put a file on the system clipboard (macOS). */
  canCopyFile?: boolean;
}

export interface ShareLink { file: string; url: string; at: string }
export interface ShareJob { file: string; state: "publishing" | "failed"; error?: string; at: string }

export type PlanState = "running" | "paused" | "finishing" | "done" | "stuck";

export interface Plan {
  state: PlanState;
  maxConcurrent: number;
  wakeups: number;
  startedAt: string;
  finishedAt?: string | null;
  originalCount: number;
  awaiting?: "event" | "final" | null;
  reason?: string | null;
}

export type NewTicketDraft = { title: string; description: string; key?: string; dependsOn?: string[]; needs?: string[] };

export interface QueuedMessage {
  id: string;
  text: string;
  at: string;
  state: "queued" | "unsent";
  /** From another session (a huddle's messages): text is the full prompt. */
  peer?: boolean;
  /** A slash command: Claude Code runs it as its own turn, after the current one. */
  slash?: "prompt" | "local";
}

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
  /** A user-role message the user didn't write: a huddle digest. */
  from?: "huddle";
  /** Claude's quiet reply to such a message. */
  peerReply?: boolean;
}

export interface SessionSummary {
  title: string | null;
  lastMessage: SessionMessage | null;
  artifacts: { url: string; label: string; at: string }[];
  updatedAt: string;
  openQuestions: number;
  pendingProposal: { title: string; description: string } | null;
  pendingNewTickets?: { title: string; description: string }[];
  pendingTeammates?: string[];
}

export interface QuestionOption {
  label: string;
  description?: string;
  recommended: boolean;
  /** Mockup this option stands for (file name in outputs/mockups). */
  mockup?: string;
}

export interface Question {
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface SetupDetection {
  at: string;
  copyFiles: string[];
  setupCommand: string;
  setupFrom: string[];
}

/** What the board did to prepare a new worktree before Claude started. */
export interface SetupResult {
  copied: string[];
  missing: string[];
  command: string;
  ok: boolean | null;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

export interface SessionEntry {
  uuid: string;
  at: string;
  role: "user" | "assistant";
  /** agent: a subagent Claude started (its own row with status, steps and result). */
  kind: "text" | "tool" | "board" | "agent";
  text: string;
  /** Tool rows: the tool_use id (api.tool loads its full input and output). */
  toolUseId?: string;
  /** Tool rows whose result was an error. */
  error?: true;
  agent?: AgentInfo;
  questions?: Question[];
  proposal?: { title: string; description: string };
  newTickets?: NewTicketDraft[];
  /** Claude offered to branch this ticket (Branch button). */
  branch?: { reason: string };
  /** Claude proposed a huddle (propose_huddle): the roster card with Start. */
  huddle?: { roster: RosterEntry[]; reason: string; template?: string };
  /** Claude asked to delete tickets (propose_delete): the card with Cancel / Delete. */
  deletion?: { ids: string[]; reason: string };
  /** Claude proposed a teammate (propose_teammate): the card with Save teammate / Edit first / Dismiss. */
  teammate?: TeammateProposal;
  /** Mockups Claude sent in this reply, saved as outputs/mockups/<name>. */
  mockups?: string[];
  moved?: "planning";
  /** A board block whose JSON couldn't be read (left visible as text). */
  unreadable?: "questions" | "proposal" | "tickets";
  /** A message from outside the user (a huddle digest): in = into this session. */
  peer?: { dir: "in" | "out"; ticketId: string | null };
  /** Huddle messages delivered to this ticket's session (a peer entry too): the huddle's id. text is the digest. */
  huddleId?: string;
  /** Worktree setup that ran before this prompt (shown as a row before it). */
  setup?: SetupResult;
  /** A user message that ran this slash command (name without the slash). */
  command?: string;
  /** Output of a built-in command (/context), not a reply from Claude. */
  commandOutput?: boolean;
}

export type SubagentStatus = "running" | "done" | "failed" | "stopped";

/** One thing a subagent did: a tool call or a message it wrote. */
export interface AgentStep {
  kind: "tool" | "text";
  text: string;
  /** Tool calls: the tool_use id (api.tool loads its full input and output). */
  id?: string;
  error?: true;
}

/** One tool call in full, loaded when its row is opened. */
export interface ToolDetail {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** null while the call has no result yet (or the session lost it). */
  output: string | null;
  isError: boolean;
  truncated: boolean;
}

export interface AgentInfo {
  /** The parent's Agent tool_use id. */
  toolUseId: string;
  description: string;
  type: string | null;
  background: boolean;
  status: SubagentStatus;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
  /** In the conversation: only the last steps; stepCount counts all. */
  steps: AgentStep[];
  stepCount: number;
  current: string | null;
  result: string | null;
  error: string | null;
}

export interface Comment {
  id: string;
  author: "user" | "ai";
  text: string;
  at: string;
}

export interface ActivityEntry {
  run: number;
  at: string;
  event: any;
}

export interface OutputFile {
  name: string;
  size: number;
  updatedAt: string;
}

export interface ClaudeProject {
  path: string;
  name: string;
  lastUsed: string | null;
  hasProfile: boolean;
}

export interface ClaudeSession {
  id: string;
  title: string | null;
  firstPrompt: string | null;
  lastActive: string;
  live: boolean;
  ticket: { id: string; title: string } | null;
}

export type McpStatus = "connected" | "needs_auth" | "failed" | "pending" | "unknown";
export type McpScope = "user" | "local" | "project" | "claude.ai" | "other";
export type McpTransport = "stdio" | "http" | "sse";

export interface McpServer {
  name: string;
  target: string;
  transport: McpTransport | null;
  scope: McpScope;
  status: McpStatus;
  message: string | null;
  /** Counts toward the header badge: failed, or needs auth after having worked before. */
  attention: boolean;
  login: { state: "waiting" | "failed"; url: string | null; error: string | null; startedAt: string } | null;
}

export interface McpState {
  servers: McpServer[];
  unparsed: string[];
  checkedAt: string | null;
  checking: boolean;
  error: string | null;
}

export interface McpAddInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: { key: string; value: string }[];
  headers?: { name: string; value: string }[];
}

/** An outside agent that can use the board through `ckanban mcp`. */
export interface AgentStatus {
  id: "claude" | "codex";
  label: string;
  available: boolean;
  installed: boolean;
  /** Registered with this ckanban's command (false: an old path). */
  current: boolean;
  command: string | null;
  configPath: string;
}

export interface McpConfig extends McpAddInput {
  scope: McpScope;
  /** Shell line that starts a stdio server like Claude does (env included). Null for http/sse. */
  commandLine: string | null;
}

/** Where a teammate or template is saved (src/server/layers.ts): built-in, for every board (global) or this board. */
export type LayerSource = "builtin" | "global" | "board";
/** A saved level. */
export type Level = "global" | "board";

export interface LayerInfo {
  /** The level whose version is in effect. */
  source: LayerSource;
  /** The version Reset falls back to; null: deleting removes it. */
  base: LayerSource | null;
  /** The name is a built-in. */
  builtin: boolean;
}

/** A huddle role preset, a "teammate" in the UI (src/server/huddle-presets.ts). */
export interface HuddlePreset extends LayerInfo {
  name: string;
  role: string;
  prompt: string;
  model: string | null;
  mode: "tagged" | "monitor";
  lead: boolean;
  canEdit: boolean;
  workspace: "shared" | "own";
}

/** A teammate Claude proposed (src/server/teammate-proposal.ts): fields it left out keep an existing teammate's values. */
export type TeammateProposal = Pick<HuddlePreset, "name" | "prompt"> & Partial<Pick<HuddlePreset, "role" | "model" | "mode" | "lead" | "canEdit" | "workspace">> & { why: string };

/** What the user did with a teammate card. */
export interface TeammateCardState {
  state: "saved" | "dismissed";
  name?: string;
  scope?: Level;
  at: string;
}

/** A whole-huddle template (src/server/huddle-templates.ts): a roster and its rules. */
export interface HuddleTemplate extends LayerInfo {
  name: string;
  label: string;
  description: string;
  roster: RosterEntry[];
  /** Rounds of discussion before the lead wraps up; null: no limit. */
  rounds: number | null;
  /** Budget in USD; null: the default. */
  maxCostUsd: number | null;
  /** Report format ("" for none). */
  report: string;
}

/** What every board spent today (src/server/spend.ts). */
export interface TodaySpend {
  day: string;
  costUsd: number;
  boards: { slug: string; name: string; costUsd: number }[];
}

/** One huddle a teammate or template took part in (src/server/huddle-usage.ts). */
export interface UsageHuddle {
  board: string;
  huddle: string;
  ticket: string;
  title: string | null;
  at: string;
  costUsd: number;
}

export interface TeamUsage {
  huddles: number;
  lastUsed: string | null;
  costUsd: number;
  /** Newest first. */
  recent: UsageHuddle[];
}

/** One line of a huddle roster (src/server/huddle-roster.ts): `count` participants from a preset or a free-form role. */
export interface RosterEntry {
  preset?: string;
  role?: string;
  count?: number;
  focus?: string;
  model?: string | null;
  mode?: HuddleMode;
  workspace?: "shared" | "own";
  lead?: boolean;
  canEdit?: boolean;
  handle?: string;
  prompt?: string;
}

export type HuddleMode = "tagged" | "monitor";

/** A huddle participant as the daemon shows it (src/server/huddle.ts ParticipantView). */
export interface HuddleParticipant {
  handle: string;
  role: string;
  preset: string | null;
  focus?: string;
  model: string | null;
  mode: HuddleMode;
  lead: boolean;
  canEdit: boolean;
  workspace: "shared" | "own";
  /** done: finished its job (only a lead, @main or the user wakes it). blocked: waiting on something (statusReason). */
  status: "working" | "idle" | "stopped" | "failed" | "done" | "blocked";
  statusReason?: string | null;
  kind: "agent" | "ticket-main" | "human";
  ticketId?: string | null;
  joinedAt: string;
  lastActivity?: string | null;
  costUsd?: number;
  /** ≈ cost of the turn it is in now, not yet in costUsd. */
  liveCostUsd?: number;
  error?: string | null;
  running: boolean;
  /** Read-only agent: the host branch and commit its snapshot shows. */
  snapshot?: { branch: string | null; sha: string } | null;
  sessionId?: string | null;
}

/** One step of a huddle participant's session (src/server/huddle-session.ts SessionStep). */
export interface SessionStep {
  i: number;
  kind: "text" | "tool" | "post" | "wake";
  text: string;
  at: string | null;
  id?: string;
  out?: string;
  error?: true;
  pending?: true;
  seq?: number;
}

/** A participant's own session for the read-only viewer (src/server/huddle-session.ts ParticipantSession). */
export interface ParticipantSession {
  handle: string;
  kind: HuddleParticipant["kind"];
  role: string;
  model: string | null;
  mode: HuddleMode;
  status: HuddleParticipant["status"];
  live: boolean;
  costUsd: number;
  sessionId: string | null;
  snapshot: { branch: string | null; sha: string } | null;
  ticketId: string | null;
  file: string | null;
  steps: SessionStep[];
  total: number;
  hasMore: boolean;
  current: number | null;
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
  hostTicket: string;
  hostTitle: string | null;
  status: "live" | "stopped" | "closed";
  maxParticipants: number;
  participants: HuddleParticipant[];
  findings: HuddleFinding[];
  invited: string[];
  /** Highest message seq so far (the message count). */
  seq: number;
  /** Spending limit; the huddle stops when it is spent (default 20). */
  maxCostUsd?: number;
  /** Why it stopped by itself: budget spent, message limit, or too long without the user (routing paused). */
  stopReason?: "budget" | "messages" | "loop" | null;
  /** @main or a lead asked the user to close the huddle (its summary is in the host's outputs). */
  closeRequest?: { by: string; at: string; reason: string } | null;
  /** Live, nobody working, no unanswered tags, no open findings; idleSince: the last message or turn. */
  quiet?: boolean;
  idleSince?: string | null;
  /** Messages tagging @you since the user last posted, acted (Stop, Resume…) or viewed the latest message; forYouSince: that seq. */
  forYou?: number;
  forYouSince?: number;
  /** Pinned brief (goal, decisions) at the head of every digest. */
  brief?: { text: string; by: string; at: string } | null;
  /** Template it was started from. */
  template?: string | null;
  /** Lessons agents proposed when they turned done; only the user saves them as role notes. */
  learnings?: HuddleLearning[];
  /** Learnings waiting for review (they count in forYou). */
  learningsPending?: number;
  /** Its summary, relative to the host ticket's outputs folder (huddles/<id>/summary.md, or the older huddle-summary.md); null while there is none. */
  summary?: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
}

/** A lesson an agent proposed (src/server/types.ts). target: "_all", a preset name, or "new" (a preset from the ad-hoc role). */
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
  newRole?: boolean;
  /** A teammate the agent proposed instead of a lesson (text: its why; scope general: all boards, repo: this board). */
  teammate?: TeammateProposal;
}

/** A role note (src/server/huddle-notes.ts): by "you" or the agent's handle. */
export interface HuddleNote {
  text: string;
  by: string;
  date: string | null;
  huddle: string | null;
}

export type HuddleNotes = Record<string, { general: HuddleNote[]; repo: HuddleNote[] }>;

export interface HuddleMessage {
  id: string;
  seq: number;
  ts: string;
  from: string;
  text: string;
  mentions: string[];
  kind: "message" | "finding" | "system";
  /** Where a post came in from: the board UI, the MCP server/CLI, or a request with neither header. */
  source?: "ui" | "mcp" | "none";
}

/** `?a=1&b=2` from the defined values ("" when none). */
const query = (q: Record<string, number | undefined>) => {
  const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
  return s ? `?${s}` : "";
};
const hud = (slug: string, id?: string) => `/api/profiles/${encodeURIComponent(slug)}/huddles${id ? `/${encodeURIComponent(id)}` : ""}`;

export interface Schedule {
  id: string;
  name: string;
  title: string;
  body: string;
  mode: TicketMode;
  cron: string;
  enabled: boolean;
  skipIfRunning: boolean;
  createdAt: string;
  updatedAt: string;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  /** Plain-English cron, e.g. "Weekdays at 09:00". */
  summary: string;
  /** Its previous ticket is still queued or running. */
  active: boolean;
}

/** Reusable prompt text, inserted by typing `@name` in a composer. scope: "global" or a board slug. */
export interface Snippet {
  id: string;
  name: string;
  text: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
}

export type SnippetInput = Pick<Snippet, "name" | "text" | "scope">;

export type ScheduleInput = Pick<Schedule, "name" | "title" | "body" | "mode" | "cron" | "skipIfRunning">;

export type ScheduleTrigger = "schedule" | "missed" | "manual";

export type ScheduleHistoryItem = { at: string } & (
  | { kind: "fired" | "skipped"; trigger: ScheduleTrigger; ticketId: string | null }
  | { kind: "error"; trigger: ScheduleTrigger; message: string }
  /** by: who changed it (a ticket = Claude in that ticket's run). previous: old title/prompt/cron. */
  | {
      kind: "edited"; action: "created" | "updated" | "paused" | "resumed"; fields: string[];
      by: "user" | { ticketId: string }; previous?: { title?: string; body?: string; cron?: string };
    }
) & { ticket: { id: string; title: string; status: Status; outcome: Outcome; running: boolean } | null };

export interface CronPreview {
  valid: boolean;
  error: string | null;
  summary: string | null;
  next: string[];
}

export type BusEvent =
  | { type: "ticket.updated"; profile: string; ticket: Ticket }
  | { type: "ticket.deleted"; profile: string; id: string }
  | { type: "activity"; profile: string; id: string; run: number; event: any }
  | { type: "profile.updated"; slug: string; profile: Profile | null }
  | { type: "session.updated"; profile: string; id: string; session: SessionSummary }
  | { type: "draft"; profile: string; id: string; text: string; final?: string }
  | { type: "mcp.updated"; state: McpState }
  | { type: "snippets.updated" }
  | { type: "schedule.updated"; profile: string; id: string; schedule: Omit<Schedule, "summary" | "active"> | null }
  | { type: "restart.updated"; pending: boolean; waiting: number }
  | { type: "huddle.updated"; profile: string; huddle: Huddle }
  | { type: "huddle.message"; profile: string; huddleId: string; message: HuddleMessage }
  | { type: "huddle.activity"; profile: string; huddleId: string; handle: string; lastActivity: string | null; liveCostUsd?: number }
  | { type: "huddle.session"; profile: string; huddleId: string; handle: string };

/** Phone access over Tailscale (src/server/remote.ts). local: this page is open on the Mac, not the phone. */
export interface RemoteState {
  enabled: boolean;
  url: string | null;
  host: string | null;
  allowedLogin: string | null;
  lastVisit: string | null;
  warning?: string;
  qrSvg: string | null;
  local: boolean;
}

export interface InboxItem {
  profile: string;
  profileName: string;
  id: string;
  title: string;
  attention: Attention;
}

/** A ticket on any board, as the ⌘K command bar lists it. */
export interface TicketRow {
  profile: string;
  profileName: string;
  id: string;
  title: string;
  status: Status;
  running: boolean;
  updatedAt: string;
  body: string;
  /** Its last result summary (Claude's last comment), capped. */
  summary: string;
  prUrl: string | null;
}

export type BugBlockId = "env" | "ticket" | "log";

/** Context a bug report attaches; the user sees it and can leave it out. */
export interface BugBlock {
  id: BugBlockId;
  label: string;
  text: string;
}

export interface BugReportResult {
  url: string | null;
  fallbackUrl: string;
  error: string | null;
  /** Local /api/attachments/ URLs of screenshots that were not uploaded. */
  screenshots: string[];
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const hasBody = method === "POST" || method === "PATCH" || method === "PUT";
  const r = await fetch(url, {
    method,
    // x-ckanban-source: the daemon records where huddle posts come from.
    headers: hasBody ? { "content-type": "application/json", "x-ckanban-source": "ui" } : undefined,
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
  });
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as any).error ?? `${r.status} ${r.statusText}`);
  return data as T;
}

const sch = (slug: string, id?: string) =>
  `/api/profiles/${encodeURIComponent(slug)}/schedules${id ? `/${encodeURIComponent(id)}` : ""}`;

const t = (slug: string, id?: string) =>
  `/api/profiles/${encodeURIComponent(slug)}/tickets${id ? `/${encodeURIComponent(id)}` : ""}`;

export const api = {
  claudeProjects: () => req<ClaudeProject[]>("GET", "/api/claude/projects"),
  claudeDefaults: () => req<{ model: string | null }>("GET", "/api/claude/defaults"),
  pickFolder: () => req<{ path: string | null }>("POST", "/api/pick-folder"),
  /** Claude plan usage (5h / weekly windows) or a plain-words error. */
  usage: () => req<UsageResult>("GET", "/api/usage"),
  /** What every board spent today (local day). */
  spend: () => req<TodaySpend>("GET", "/api/spend"),
  version: () => req<{ version: string; latest: string | null; updateAvailable: boolean; url: string | null }>("GET", "/api/version"),
  health: () => req<Health>("GET", "/api/health"),
  /** pending: a daemon restart holds new runs until the `waiting` active runs finish. */
  remote: () => req<RemoteState>("GET", "/api/remote"),
  setRemote: (enabled: boolean) => req<RemoteState>("POST", "/api/remote", { enabled }),
  restartState: () => req<{ pending: boolean; waiting: number }>("GET", "/api/restart"),
  bugDraft: (ref: { profile: string; ticketId: string } | null) =>
    req<{ blocks: BugBlock[]; screenshots: string[] }>("POST", "/api/bug-report/draft", ref ?? {}),
  reportBug: (input: { title: string; description: string; include: BugBlockId[]; profile?: string; ticketId?: string }) =>
    req<BugReportResult>("POST", "/api/bug-report", { ...input, source: "ui" }),
  profiles: () => req<Profile[]>("GET", "/api/profiles"),
  createProfile: (p: { name: string; path: string; maxParallel?: number; model?: string; baseBranch?: string }) =>
    req<Profile>("POST", "/api/profiles", p),
  updateProfile: (slug: string, p: Partial<Profile>) => req<Profile>("PATCH", `/api/profiles/${slug}`, p),
  deleteProfile: (slug: string) => req<void>("DELETE", `/api/profiles/${slug}`),
  detectSetup: (slug: string) => req<SetupDetection>("POST", `/api/profiles/${slug}/detect-setup`),
  tickets: (slug: string) => req<Ticket[]>("GET", t(slug)),
  huddlePresets: (slug: string) => req<HuddlePreset[]>("GET", `/api/profiles/${encodeURIComponent(slug)}/huddle-presets`),
  /** scope: global (every board) or this board. */
  saveHuddlePreset: (slug: string, p: Partial<Omit<HuddlePreset, keyof LayerInfo>> & { name: string }, scope: Level) =>
    req<HuddlePreset>("POST", `/api/profiles/${encodeURIComponent(slug)}/huddle-presets`, { ...p, scope }),
  /** Deletes a teammate at one level: it falls back to the level below (all boards, then built-in), or goes away. */
  deleteHuddlePreset: (slug: string, name: string, scope: Level) =>
    req<{ reset: boolean; presets: HuddlePreset[] }>("DELETE", `/api/profiles/${encodeURIComponent(slug)}/huddle-presets/${encodeURIComponent(name)}?scope=${scope}`),
  /** How every teammate and template was used, from the huddles on every board. */
  teamUsage: () => req<{ teammates: Record<string, TeamUsage>; templates: Record<string, TeamUsage> }>("GET", "/api/team-usage"),
  /** Every huddle on the board (live, stopped and closed). */
  boardHuddles: (slug: string) => req<Huddle[]>("GET", hud(slug)),
  /** Huddles the ticket hosts or takes part in. */
  huddles: (slug: string, ticketId: string) => req<Huddle[]>("GET", `${hud(slug)}?ticket=${encodeURIComponent(ticketId)}`),
  /** A huddle and its newest messages (`before`: the page before that seq; `since`: the ones after it). */
  huddle: (slug: string, id: string, q: { before?: number; since?: number; limit?: number } = {}) =>
    req<{ huddle: Huddle; you: string; messages: HuddleMessage[]; hasMore: boolean }>("GET",
      `${hud(slug, id)}${query(q)}`),
  /** template: a template's name (its roster when `roster` is empty, its budget unless given, its rules as the brief). */
  startHuddle: (slug: string, ticketId: string, roster: RosterEntry[], maxParticipants?: number, maxCostUsd?: number, template?: string) =>
    req<Huddle>("POST", hud(slug), { ticketId, roster, maxParticipants, maxCostUsd, template }),
  setHuddleBrief: (slug: string, id: string, text: string) => req<Huddle>("PUT", `${hud(slug, id)}/brief`, { text }),
  huddleTemplates: (slug: string) => req<HuddleTemplate[]>("GET", `/api/profiles/${encodeURIComponent(slug)}/huddle-templates`),
  saveHuddleTemplate: (slug: string, t: Omit<HuddleTemplate, keyof LayerInfo>, scope: Level) =>
    req<HuddleTemplate>("POST", `/api/profiles/${encodeURIComponent(slug)}/huddle-templates`, { ...t, scope }),
  /** Deletes a template at one level: it falls back to the level below, or goes away. */
  deleteHuddleTemplate: (slug: string, name: string, scope: Level) =>
    req<{ reset: boolean; templates: HuddleTemplate[] }>("DELETE", `/api/profiles/${encodeURIComponent(slug)}/huddle-templates/${encodeURIComponent(name)}?scope=${scope}`),
  postHuddle: (slug: string, id: string, text: string) => req<HuddleMessage>("POST", `${hud(slug, id)}/messages`, { text }),
  addHuddleParticipants: (slug: string, id: string, entry: RosterEntry) =>
    req<{ added: HuddleParticipant[]; huddle: Huddle }>("POST", `${hud(slug, id)}/participants`, entry),
  setHuddleMode: (slug: string, id: string, handle: string, mode: HuddleMode) =>
    req<Huddle>("PATCH", `${hud(slug, id)}/participants/${encodeURIComponent(handle)}`, { mode }),
  stopHuddleParticipant: (slug: string, id: string, handle: string) =>
    req<Huddle>("POST", `${hud(slug, id)}/participants/${encodeURIComponent(handle)}/stop`),
  /** A failed or stopped participant is idle again (and wakes now on a live huddle). */
  restartHuddleParticipant: (slug: string, id: string, handle: string) =>
    req<Huddle>("POST", `${hud(slug, id)}/participants/${encodeURIComponent(handle)}/restart`),
  /** resume: addBudgetUsd raises the budget (needed once it is spent). */
  huddleAction: (slug: string, id: string, action: "stop" | "resume" | "close", addBudgetUsd?: number) =>
    req<Huddle>("POST", `${hud(slug, id)}/${action}`, addBudgetUsd ? { addBudgetUsd } : undefined),
  /** A participant's session, read-only: newest steps last (`before`: older page; `since`: every step from that index). */
  huddleSession: (slug: string, id: string, handle: string, q: { before?: number; since?: number; limit?: number } = {}) =>
    req<ParticipantSession>("GET", `${hud(slug, id)}/participants/${encodeURIComponent(handle)}/session${query(q)}`),
  huddleSessionTool: (slug: string, id: string, handle: string, toolUseId: string) =>
    req<ToolDetail>("GET", `${hud(slug, id)}/participants/${encodeURIComponent(handle)}/session/tool/${encodeURIComponent(toolUseId)}`),
  /** Show the participant's transcript file in Finder. */
  revealHuddleSession: (slug: string, id: string, handle: string) =>
    req<{ ok: true; file: string }>("POST", `${hud(slug, id)}/participants/${encodeURIComponent(handle)}/session/reveal`),
  /** The user viewed the huddle up to message seq: the "for you" count clears up to there. */
  huddleSeen: (slug: string, id: string, seq: number) => req<Huddle>("POST", `${hud(slug, id)}/seen`, { seq }),
  /** Change a pending learning (text, scope, where it goes) before saving it. */
  editLearning: (slug: string, id: string, lid: string, patch: Partial<Pick<HuddleLearning, "text" | "scope" | "target">>) =>
    req<HuddleLearning>("PATCH", `${hud(slug, id)}/learnings/${encodeURIComponent(lid)}`, patch),
  saveLearning: (slug: string, id: string, lid: string, patch: Partial<Pick<HuddleLearning, "text" | "scope" | "target">> = {}) =>
    req<HuddleLearning>("POST", `${hud(slug, id)}/learnings/${encodeURIComponent(lid)}/save`, patch),
  discardLearning: (slug: string, id: string, lid: string) => req<HuddleLearning>("POST", `${hud(slug, id)}/learnings/${encodeURIComponent(lid)}/discard`, {}),
  /** Every role's notes (general and this board's repo notes); cap: lines per file that go into instructions. */
  huddleNotes: (slug: string) => req<{ notes: HuddleNotes; cap: number }>("GET", `/api/profiles/${encodeURIComponent(slug)}/huddle-notes`),
  setHuddleNotes: (slug: string, role: string, scope: "general" | "repo", notes: HuddleNote[]) =>
    req<HuddleNote[]>("PUT", `/api/profiles/${encodeURIComponent(slug)}/huddle-notes/${encodeURIComponent(role)}/${scope}`, { notes }),
  inviteToHuddle: (slug: string, id: string, ticketId: string) => req<HuddleParticipant>("POST", `${hud(slug, id)}/invite`, { ticketId }),
  huddleFindings: (slug: string, id: string, action: "add" | "resolve", arg: { text?: string; id?: string }) =>
    req<HuddleFinding[]>("POST", `${hud(slug, id)}/findings`, { action, ...arg }),
  files: (slug: string, path: string) =>
    req<{ path: string; entries: FileEntry[] }>("GET", `/api/profiles/${encodeURIComponent(slug)}/files?path=${encodeURIComponent(path)}`),
  file: (slug: string, path: string) =>
    req<FileContent>("GET", `/api/profiles/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}`),
  ticket: (slug: string, id: string) => req<Ticket>("GET", t(slug, id)),
  quickChat: (slug: string) => req<QuickChat>("GET", `/api/profiles/${encodeURIComponent(slug)}/claude/session`),
  sessions: (slug: string) => req<ClaudeSession[]>("GET", `/api/profiles/${encodeURIComponent(slug)}/sessions`),
  branchTicket: (slug: string, id: string) => req<{ ticket: Ticket; warning: string | null }>("POST", `${t(slug, id)}/branch`),
  /** external: the session is open in a terminal the board can't close (nothing changed). */
  freshSession: (slug: string, id: string) => req<{ ticket: Ticket; external: boolean }>("POST", `${t(slug, id)}/fresh-session`),
  takeOver: (slug: string, id: string) => req<{ ticket: Ticket; external: boolean }>("POST", `${t(slug, id)}/take-over`),
  linkSession: (slug: string, id: string, sessionId: string | null) =>
    req<Ticket>("POST", `${t(slug, id)}/link-session`, { sessionId }),
  outputs: (slug: string, id: string) => req<OutputFile[]>("GET", `${t(slug, id)}/outputs`),
  outputUrl: (slug: string, id: string, name: string) => `${t(slug, id)}/outputs/${name.split("/").map(encodeURIComponent).join("/")}`,
  outputDownloadUrl: (slug: string, id: string, name: string) => `${api.outputUrl(slug, id, name)}?download=1`,
  /** Share menu: reveal in Finder, copy the file to the clipboard, or start publishing it as a claude.ai page. */
  outputAction: (slug: string, id: string, name: string, action: "reveal" | "copy" | "publish") =>
    req<unknown>("POST", `${api.outputUrl(slug, id, name)}?action=${action}`),
  outputText: async (slug: string, id: string, name: string) => {
    const r = await fetch(api.outputUrl(slug, id, name));
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.text();
  },
  createTicket: (slug: string, input: {
    title: string; body: string; status: Status; sessionId?: string; mode?: TicketMode; parentId?: string; planKey?: string; dependsOn?: string[];
    needs?: string[]; important?: boolean;
  }) => req<Ticket>("POST", t(slug), input),
  plan: (slug: string, id: string, action: "start" | "pause" | "resume" | "done" | "concurrency", maxConcurrent?: number) =>
    req<Ticket>("POST", `${t(slug, id)}/plan`, { action, maxConcurrent }),
  updateTicket: (slug: string, id: string, patch: Partial<Pick<Ticket, "title" | "body" | "status" | "order" | "mode" | "notice" | "needs" | "important" | "runCapUsd">> & { expectedBody?: string }) =>
    req<Ticket>("PATCH", t(slug, id), patch),
  deleteTicket: (slug: string, id: string) => req<void>("DELETE", t(slug, id)),
  /** The user answered a teammate card (saved it, or dismissed it). */
  answerTeammateCard: (slug: string, id: string, uuid: string, card: Omit<TeammateCardState, "at">) =>
    req<Ticket>("PUT", `${t(slug, id)}/teammate-cards/${encodeURIComponent(uuid)}`, card),
  comments: (slug: string, id: string) => req<Comment[]>("GET", `${t(slug, id)}/comments`),
  addComment: (slug: string, id: string, text: string) => req<Comment>("POST", `${t(slug, id)}/comments`, { text }),
  diff: (slug: string, id: string, ignoreWhitespace: boolean) =>
    req<TicketDiff>("GET", `${t(slug, id)}/diff${ignoreWhitespace ? "?w=1" : ""}`),
  chat: (slug: string, id: string, text: string) => req<Ticket>("POST", `${t(slug, id)}/chat`, { text }),
  sendQueued: (slug: string, id: string, msgId: string) => req<Ticket>("POST", `${t(slug, id)}/queued/${msgId}`),
  discardQueued: (slug: string, id: string, msgId: string) => req<Ticket>("DELETE", `${t(slug, id)}/queued/${msgId}`),
  editQueued: (slug: string, id: string, msgId: string, text: string) => req<Ticket>("PATCH", `${t(slug, id)}/queued/${msgId}`, { text }),
  conversation: (slug: string, id: string, before?: number) =>
    req<{ entries: SessionEntry[]; start: number; total: number; title: string | null }>(
      "GET", `${t(slug, id)}/conversation${before !== undefined ? `?before=${before}` : ""}`),
  /** One subagent of the ticket's conversation, with all of its steps. */
  agent: (slug: string, id: string, toolUseId: string) => req<AgentInfo>("GET", `${t(slug, id)}/agent/${encodeURIComponent(toolUseId)}`),
  /** A tool call's full input and output (main conversation or a subagent's). */
  tool: (slug: string, id: string, toolUseId: string) => req<ToolDetail>("GET", `${t(slug, id)}/tool/${encodeURIComponent(toolUseId)}`),
  /** What `/` can run in this ticket's chat (skills, custom commands, built-ins). */
  commands: (slug: string, id: string) => req<SlashCommand[]>("GET", `${t(slug, id)}/commands`),
  /** Skills and commands in the board's folder: the `/` picker of descriptions not tied to a ticket yet. */
  boardCommands: (slug: string) => req<SlashCommand[]>("GET", `/api/profiles/${slug}/commands`),
  activity: (slug: string, id: string) => req<ActivityEntry[]>("GET", `${t(slug, id)}/activity`),
  /** Cost, tokens and ≈ share of the 5h plan window per run. */
  ticketUsage: (slug: string, id: string) => req<TicketUsage>("GET", `${t(slug, id)}/usage`),
  inbox: () => req<InboxItem[]>("GET", "/api/inbox"),
  allTickets: () => req<TicketRow[]>("GET", "/api/tickets"),
  snippets: (slug: string) => req<Snippet[]>("GET", `/api/snippets?profile=${encodeURIComponent(slug)}`),
  createSnippet: (input: SnippetInput) => req<Snippet>("POST", "/api/snippets", input),
  updateSnippet: (id: string, patch: Partial<SnippetInput>) => req<Snippet>("PATCH", `/api/snippets/${encodeURIComponent(id)}`, patch),
  deleteSnippet: (id: string) => req<void>("DELETE", `/api/snippets/${encodeURIComponent(id)}`),
  schedules: (slug: string) => req<Schedule[]>("GET", sch(slug)),
  createSchedule: (slug: string, input: ScheduleInput) => req<Schedule>("POST", sch(slug), input),
  updateSchedule: (slug: string, id: string, patch: Partial<ScheduleInput & { enabled: boolean }>) => req<Schedule>("PATCH", sch(slug, id), patch),
  deleteSchedule: (slug: string, id: string) => req<void>("DELETE", sch(slug, id)),
  runSchedule: (slug: string, id: string) => req<{ entry: ScheduleHistoryItem; schedule: Schedule }>("POST", `${sch(slug, id)}/run`),
  scheduleHistory: (slug: string, id: string) => req<ScheduleHistoryItem[]>("GET", `${sch(slug, id)}/history`),
  cronPreview: (expr: string) => req<CronPreview>("GET", `/api/cron/preview?expr=${encodeURIComponent(expr)}`),
  mcp: () => req<McpState>("GET", "/api/mcp"),
  mcpRefresh: () => req<McpState>("POST", "/api/mcp/refresh"),
  mcpAdd: (input: McpAddInput) => req<McpState>("POST", "/api/mcp", input),
  mcpRemove: (name: string) => req<McpState>("DELETE", `/api/mcp/${encodeURIComponent(name)}`),
  mcpLogin: (name: string) => req<McpState>("POST", `/api/mcp/${encodeURIComponent(name)}/login`),
  mcpCancelLogin: (name: string) => req<McpState>("POST", `/api/mcp/${encodeURIComponent(name)}/cancel-login`),
  mcpLogout: (name: string) => req<McpState>("POST", `/api/mcp/${encodeURIComponent(name)}/logout`),
  mcpRecheck: (name: string) => req<McpState>("POST", `/api/mcp/${encodeURIComponent(name)}/recheck`),
  mcpConfig: (name: string) => req<McpConfig>("GET", `/api/mcp/${encodeURIComponent(name)}/config`),
  mcpUpdate: (name: string, input: McpAddInput) => req<McpState>("PUT", `/api/mcp/${encodeURIComponent(name)}`, input),
  agents: () => req<AgentStatus[]>("GET", "/api/agents"),
  agentInstall: (id: AgentStatus["id"]) => req<AgentStatus[]>("POST", `/api/agents/${id}/install`),
  agentUninstall: (id: AgentStatus["id"]) => req<AgentStatus[]>("POST", `/api/agents/${id}/uninstall`),
  openFile: (slug: string, path: string) => req<{ ok: true }>("POST", `/api/profiles/${encodeURIComponent(slug)}/open-file`, { path }),
  stop: (slug: string, id: string) => req<{ stopped: boolean }>("POST", `${t(slug, id)}/stop`).then((r) => {
    if (!r.stopped) throw new Error("Claude is not running on this ticket.");
    return r;
  }),
  checkPr: (slug: string, id: string) => req<{ state: string | null }>("POST", `${t(slug, id)}/check-pr`),
  /** force: skip the server's 30s reuse of a fresh status. */
  prRefresh: (slug: string, id: string, force = false) => req<{ pr: PrStatus | null; ticket: Ticket }>("POST", `${t(slug, id)}/pr/refresh`, { force }),
  prSendFailures: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/pr/send-failures`),
  prMerge: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/pr/merge`),
  /** Usage limit: send "continue" now. */
  /** "Continue with +$Y" after a run stopped at its spending cap. */
  capContinue: (slug: string, id: string, addUsd: number) => req<Ticket>("POST", `${t(slug, id)}/cap-continue`, { addUsd }),
  limitContinue: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/limit`, { action: "continue" }),
  /** Usage limit: turn the automatic continue at the reset on or off for this ticket. */
  limitAuto: (slug: string, id: string, auto: boolean) => req<Ticket>("POST", `${t(slug, id)}/limit`, { auto }),
  planningCommand: (slug: string, id: string) => req<{ command: string }>("POST", `${t(slug, id)}/planning-command`),
  /** Raw image bytes; the server saves them and returns the URL to put in markdown. */
  uploadImage: async (file: Blob) => {
    const r = await fetch("/api/attachments", { method: "POST", headers: { "content-type": file.type }, body: file });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data as any).error ?? `${r.status} ${r.statusText}`);
    return data as { url: string; path: string };
  },
};

type Listener = (e: BusEvent) => void;
const listeners = new Set<Listener>();
const reconnectListeners = new Set<() => void>();
let source: EventSource | null = null;
let lostConnection = false;

function connect() {
  source = new EventSource("/api/events");
  source.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as BusEvent;
      for (const l of listeners) l(e);
    } catch {}
  };
  source.onerror = () => {
    // EventSource retries on its own; remember that we missed events meanwhile.
    lostConnection = true;
  };
  source.onopen = () => {
    if (!lostConnection) return;
    lostConnection = false;
    for (const fn of reconnectListeners) fn();
  };
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  if (!source) connect();
  return () => listeners.delete(fn);
}

/** Called after the live connection comes back (daemon restart, laptop sleep): refetch state. */
export function onReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn);
  if (!source) connect();
  return () => reconnectListeners.delete(fn);
}

/** Only allow https links from untrusted data (e.g. PR URLs reported by Claude). */
export function safeHref(url: string | null | undefined): string | undefined {
  return url && /^https:\/\//.test(url) ? url : undefined;
}

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
