import { isImageFile } from "./attachText";
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

/** A folder's version history: none (plain), git without commits (empty), commits without a remote (local), or a remote. */
export type RepoKind = "plain" | "empty" | "local" | "remote";

export interface VersionHistory {
  /** git is installed (the offer is hidden without it). */
  git: boolean;
  /** Null: the folder doesn't exist or git isn't installed. */
  repo: RepoKind | null;
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

export type Workspace = "worktree" | "folder";

/** "Help me understand" questions (src/server/explain.ts). */
export type HelpKind = "recap" | "changes";

/** One "Help me understand" answer, shown as a card in the ticket's chat. */
export interface HelpCard {
  id: string;
  /** "lessons": an old "Learn from this ticket" card (not shown any more). */
  kind: HelpKind | "lessons";
  at: string;
  text: string;
  costUsd: number;
  model: string;
}

/** Where a lesson the board learned came from (src/server/learn.ts). */
export interface LearnSource {
  kind: "ticket" | "huddle";
  slug: string;
  id: string;
  title: string;
  /** "you" or the agent's handle. */
  by: string;
  at: string;
  quote: string;
  key: string;
  /** A huddle's host ticket. */
  ticket?: string;
}

/** A lesson in the board's pile, seen once so far. */
export interface LearnCandidate {
  id: string;
  kind: "ticket" | "huddle";
  text: string;
  general: boolean;
  dest: { kind: "rules"; slug: string } | { kind: "notes"; role: string; scope: "general" | "repo"; slug: string };
  sources: LearnSource[];
  firstAt: string;
  lastAt: string;
  state: "watching" | "saved" | "undone" | "dropped";
}

/** A lesson the board saved, or one step of its weekly tidy, with its undo state. */
export interface LearnChange {
  id: string;
  at: string;
  kind: "saved" | "merged" | "rewrote" | "removed";
  slug: string | null;
  text: string;
  old: string[];
  why?: string;
  where: string;
  candidateId?: string;
  sources?: LearnSource[];
  undoneAt?: string | null;
}

/** The Team tab's Learned view (src/server/learner.ts). */
export interface LearnedView {
  saved: LearnChange[];
  cleaned: LearnChange[];
  watching: LearnCandidate[];
  newCount: number;
  tidyAt: string | null;
}

export interface TicketDiff {
  base: string;
  mergeBase: string;
  branch: string | null;
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** Shown instead of files when the changes can't be worked out. */
  note?: string;
}

export interface FileContent {
  path: string;
  size: number;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
}

/** WebSocket URL of the profile's interactive shell. */
export const shellSocketUrl = (slug: string, cols: number, rows: number) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/profiles/${encodeURIComponent(slug)}/shell?cols=${cols}&rows=${rows}`;

/** A quick chat with Claude in the board's folder, no ticket (src/server/quickchat.ts QuickChatView). */
export interface QuickChat {
  id: string;
  sessionId: string;
  /** The user's title, else the first message's first line. */
  title: string;
  renamed: boolean;
  firstMessage: string | null;
  createdAt: string;
  updatedAt: string;
  /** Claude saved the conversation (Make ticket needs it). */
  started: boolean;
  /** Make ticket turned it into this ticket; the conversation continues there. */
  ticketId: string | null;
  error: string | null;
  running: boolean;
  /** What Claude is doing now. */
  activity: string | null;
  /** Messages waiting for a board restart to finish. */
  waiting: number;
}

export interface FollowUp { dueAt: string; note: string; cancelOnReply: boolean; setAt: string; missedAt?: string | null }
export interface FollowUpLogEntry {
  at: string;
  kind: "set" | "woke" | "cancelled" | "replied" | "missed";
  dueAt?: string;
  note?: string;
  by?: "user" | "claude" | "reply";
  run?: number;
  costUsd?: number;
}

export type AttentionKind = "stalled" | "failed" | "limit" | "blocked" | "questions" | "proposal" | "review" | "reply" | "huddle";
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
  effort?: string | null;
  createdAt: string;
  /** Git-ignored files copied into each new worktree (paths or globs relative to the folder). */
  copyFiles?: string[];
  /** Installs dependencies in a ticket's worktree, only when its Claude asks for it. */
  setupCommand?: string;
  /** Runs in a worktree before it is removed. */
  cleanupCommand?: string;
  /** What auto-detection last found (values equal to it show an "Auto-detected" badge). */
  setupDetected?: SetupDetection | null;
  /** Unattended runs start a review huddle themselves before landing important or risky work. Missing: on. */
  autoHuddles?: boolean;
  /** While this board has work going, the daemon keeps the Mac from idle sleep. Missing: on. */
  keepAwake?: boolean;
  /** Spending cap per run in USD for its tickets' work runs; missing/null: none. */
  runCapUsd?: number | null;
  artifacts?: boolean;
  /** Minutes without output before a run counts as stalled; 0: off. Missing: 20. */
  stallMinutes?: number;
  /** Where new runs work: a worktree per ticket (missing: this) or the project folder itself. */
  workspace?: Workspace;
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
  /** HEAD of the board's folder at the ticket's first run there (its Changes base without a worktree). */
  baseSha?: string | null;
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
  /** Reasoning effort set for this ticket (overrides the board's). */
  effort?: string | null;
  /** Created by this schedule. */
  scheduleId?: string | null;
  /** Created by this one-time scheduled job. */
  jobId?: string | null;
  /** Created by an automation from an event in another service: where to open it. */
  source?: { provider: string; label: string; url: string; loopId: string } | null;
  /** Planner ticket whose chat proposed this one. */
  parentId?: string | null;
  /** Ticket this one was branched from (copy of its conversation and committed code). */
  branchedFrom?: string | null;
  /** When it was branched: conversation entries before this are the copied history. */
  branchPoint?: { at: string; sourceTitle: string } | null;
  /** Ticket this one is an add-on to (a new requirement on a ticket that already ran). */
  addOnOf?: string | null;
  /** Claude comes back to this ticket at dueAt (follow_up); missedAt: it came due while the board was off, the user decides. */
  followUp?: FollowUp | null;
  /** Follow-ups set, woken, cancelled and replied to, oldest first. */
  followUpLog?: FollowUpLogEntry[];
  /** Claude stopped following up, and why (shown on the card until a new follow-up is set). */
  followUpStopped?: { at: string; reason: string } | null;
  seenAt?: string | null;
  /** Where it was before it moved from Review/Done back to Planning or Backlog. */
  reopenedFrom?: { status: Status; outcome: Outcome } | null;
  /** Short name siblings use in dependsOn. */
  planKey?: string | null;
  /** Siblings (ticket id or planKey) a running plan finishes before starting this one. */
  dependsOn?: string[];
  /** Exclusive resources (e.g. emulator): tickets needing the same one never run at the same time, on any board. */
  needs?: string[];
  /** The user's labels for finding related tickets (e.g. "post"), lowercase. */
  tags?: string[];
  /** Tags Claude suggested: shown dashed until the user keeps (moves to tags) or drops each one. */
  suggestedTags?: string[];
  /** For tickets with needs: holds them now, or which ones another ticket holds while this one would start. */
  resources?: { holding: boolean; waitingFor: string[] } | null;
  /** It would start now, but another ticket is editing the board's folder in place (no version history). */
  folderWait?: boolean;
  /** A plan child waiting on the user (questions, a proposal to apply, in Planning); the plan won't start it. */
  userWait?: string | null;
  /** Set once this ticket's plan was started: the board runs its children unattended. */
  plan?: Plan | null;
  /** Messages Claude has not read yet (sent while it worked, or the one that started its reply); "unsent" ones were cut off by Stop. */
  queued?: QueuedMessage[];
  /** A reply a daemon restart cut off; the board resumes it. partial: what Claude had written so far. */
  interrupted?: { at: string; partial?: string; held?: boolean } | null;
  /** A chat reply waiting for a free run slot: shown queued in In Progress. */
  slotWait?: { at: string; from: { status: Status; outcome: Outcome } } | null;
  /** The run has sent no output for the board's stall time: Stop, Keep waiting or Restart. */
  stalled?: { at: string; minutes: number } | null;
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
  /** Snoozed from the Inbox: what it waits for and until when (attention is null meanwhile). */
  snoozed?: { attention: Attention; until: string } | null;
  /** Its own huddle is working: the card shows the huddle badge instead of an outcome badge. */
  huddleBusy?: boolean;
  /** Output files published as claude.ai pages from the Share menu, one link per file. */
  shareLinks?: ShareLink[];
  /** Artifacts and share links, newest first (src/server/links.ts). */
  links?: TicketLink[];
  /** Teammate cards in the chat the user answered, by entry uuid (src/server/types.ts). */
  teammateCards?: Record<string, TeammateCardState>;
  /** Automation cards in the chat the user saved (by entry uuid). */
  automationCards?: Record<string, { loopId: string; at: string }>;
  /** Made by Automations → Set up with Claude. */
  automationSetup?: boolean;
  /** Share menu publishes in progress (or the last one's error), per output file. */
  shareJobs?: ShareJob[];
  /** Absolute path of the ticket's outputs folder. */
  outputDir?: string;
  /** The daemon can put a file on the system clipboard (macOS). */
  canCopyFile?: boolean;
}

export interface ShareLink { file: string; url: string; at: string }
/** Where a link was found: the ticket's session, a huddle teammate's session ("huddle:@handle"), a result summary or the Share menu. */
export interface TicketLink { url: string; label: string; at: string; source: string }
export const isArtifactLink = (l: TicketLink) => l.source !== "share";
/** The ticket's newest claude.ai artifact (share links of output files aside). */
export const newestArtifact = (t: Pick<Ticket, "links">) => t.links?.find(isArtifactLink) ?? null;
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

export type NewTicketDraft = { title: string; description: string; important?: true; key?: string; dependsOn?: string[]; needs?: string[]; tags?: string[] };

export interface QueuedMessage {
  id: string;
  text: string;
  at: string;
  state: "queued" | "unsent";
  /** From another session (a huddle's messages): text is the full prompt. */
  peer?: boolean;
  /** Sent by another ticket's Claude: which one (shown with that ticket's name, not as yours). */
  from?: { ticketId: string; title: string };
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
  /** A plain message of the user's: the chat can rewind to it. */
  rewind?: true;
  agent?: AgentInfo;
  questions?: Question[];
  proposal?: { title: string; description: string; important?: true };
  newTickets?: NewTicketDraft[];
  /** Claude offered to branch this ticket (Branch button). */
  branch?: { reason: string };
  /** Claude proposed a huddle (propose_huddle): the roster card with Start. */
  huddle?: { roster: RosterEntry[]; reason: string; template?: string; maxCostUsd?: number };
  /** Claude asked to delete tickets (propose_delete): the card with Cancel / Delete. */
  deletion?: { ids: string[]; reason: string };
  /** Claude proposed a teammate (propose_teammate): the card with Save teammate / Edit first / Dismiss. */
  teammate?: TeammateProposal;
  /** Claude proposed an automation (propose_automation): the card with Connect and Save automation. */
  automation?: AutomationProposal;
  /** Mockups Claude sent in this reply, saved as outputs/mockups/<name>. */
  mockups?: string[];
  moved?: "planning";
  /** A board block whose JSON couldn't be read (left visible as text). */
  unreadable?: "questions" | "proposal" | "tickets";
  /** A message from outside the user (a huddle digest): in = into this session. */
  /** ticketId and title: a message another ticket's Claude sent (text is just the message); ticketId null: a huddle digest. */
  peer?: { dir: "in" | "out"; ticketId: string | null; title?: string };
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
  login: {
    state: "waiting" | "failed"; url: string | null; error: string | null; startedAt: string;
    /** A claude.ai connector: sign-in happens on claude.ai. */
    claudeAi: boolean;
    /** Takes the address the sign-in page ended on (signed in on another device). */
    canPaste: boolean;
  } | null;
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
  /** Runs the huddle instead of @main (one entry, count 1; made a lead). */
  host?: boolean;
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
  /** Its conversation's size at its latest step (tokens Claude re-reads every step). */
  contextTokens?: number;
  error?: string | null;
  running: boolean;
  /** Read-only agent: the host branch and commit its snapshot shows. */
  snapshot?: { branch: string | null; sha: string } | null;
  sessionId?: string | null;
  /** May change files: its own copy of the ticket's folder, once made. */
  copy?: { kind: "git" | "folder"; dir: string; at: string } | null;
}

/** Changes a helper handed in from its copy (src/server/types.ts HandIn). */
export interface HandIn {
  id: string;
  from: string;
  summary: string;
  files: { path: string; change: "added" | "changed" | "removed" }[];
  status: "waiting" | "accepted" | "rejected" | "conflict";
  at: string;
  by?: string | null;
  decidedAt?: string | null;
  reason?: string | null;
  conflicts?: string[];
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
  /** The budget stopped it after its work was finished: Close is the next step, not Resume. */
  finishedAtStop?: boolean;
  /** @main or a lead asked the user to close the huddle (its summary is in the host's outputs). */
  closeRequest?: { by: string; at: string; reason: string } | null;
  /** The lead that runs the huddle instead of @main (it gets the idle nudges, notes and hand-ins); null: @main runs it. */
  host?: string | null;
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
  /** Changes helpers handed in, oldest first. */
  handIns?: HandIn[];
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
  kind: "message" | "finding" | "system" | "handin";
  /** Where a post came in from: the board UI, the MCP server/CLI, or a request with neither header. */
  source?: "ui" | "mcp" | "none";
  /** kind handin: the hand-in it shows. */
  handIn?: string;
}

/** `?a=1&b=2` from the defined values ("" when none). */
const query = (q: Record<string, number | undefined>) => {
  const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
  return s ? `?${s}` : "";
};
const hud = (slug: string, id?: string) => `/api/profiles/${encodeURIComponent(slug)}/huddles${id ? `/${encodeURIComponent(id)}` : ""}`;

export type { AutomationProposal, Loop, LoopColumn, LoopInput, LoopSeenItem, LoopTest, Pass } from "./automationTypes";
import type { AutomationProposal, Loop, LoopInput, LoopTest, Pass } from "./automationTypes";

export interface Schedule {
  id: string;
  name: string;
  title: string;
  body: string;
  mode: TicketMode;
  cron: string;
  enabled: boolean;
  skipIfRunning: boolean;
  /** Tags every ticket it creates gets. */
  tags?: string[];
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

/** What a one-time scheduled job does when it runs (src/server/jobs.ts). */
export type JobAction =
  | { kind: "ticket"; title: string; body: string; mode: TicketMode }
  | { kind: "command"; command: string; timeoutSec?: number; ifLate?: "skip" | "run" };

export type { JobState } from "./jobText";
import type { JobState } from "./jobText";

export interface JobResult {
  ticketId?: string;
  exitCode?: number | null;
  durationMs?: number;
  output?: string;
  timedOut?: boolean;
  message?: string;
}

/** Runs once at `at`: starts a ticket or runs a command. sourceTicketId: the ticket whose run scheduled it (null: the user). */
export interface Job {
  id: string;
  name: string;
  at: string;
  action: JobAction;
  state: JobState;
  sourceTicketId: string | null;
  createdAt: string;
  updatedAt: string;
  firedAt: string | null;
  result: JobResult | null;
}

export type ScheduleInput = Pick<Schedule, "name" | "title" | "body" | "mode" | "cron" | "skipIfRunning" | "tags">;

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
  | { type: "loop.updated"; profile: string; id: string; loop: Loop | null }
  | { type: "integration.updated" }
  | { type: "job.updated"; profile: string; id: string; job: Job | null }
  | { type: "restart.updated"; pending: boolean; waiting: number }
  | { type: "awake.updated"; held: boolean }
  | { type: "learned.updated"; profile: string | null }
  | { type: "huddle.updated"; profile: string; huddle: Huddle }
  | { type: "huddle.message"; profile: string; huddleId: string; message: HuddleMessage }
  | { type: "huddle.activity"; profile: string; huddleId: string; handle: string; lastActivity: string | null; liveCostUsd?: number; contextTokens?: number }
  | { type: "huddle.session"; profile: string; huddleId: string; handle: string }
  | { type: "chat.updated"; profile: string; id: string; chat: QuickChat | null }
  | { type: "chat.draft"; profile: string; id: string; text: string; final?: string }
  | { type: "chat.activity"; profile: string; id: string; activity: string | null };

/** Phone access over Tailscale (src/server/remote.ts). local: this page is open on the Mac, not the phone. */
export interface RemoteState {
  enabled: boolean;
  url: string | null;
  host: string | null;
  allowedLogin: string | null;
  lastVisit: string | null;
  warning?: string;
  /** Live Tailscale state on the Mac while phone access is on; missing means not checked. */
  tailscale?: "running" | "stopped" | "unavailable";
  backendState?: string;
  qrSvg: string | null;
  local: boolean;
}

/** A device that turned phone notifications on (src/server/push.ts). */
export interface PushDevice {
  id: string;
  label: string;
  createdAt: string;
}

/** "Needs you" notifications (src/server/notify.ts): webhook (ntfy or JSON), macOS banner, per-kind toggles. */
export type NotifyKind = "stalled" | "questions" | "proposal" | "review" | "failed" | "limit" | "blocked" | "huddle" | "reply" | "message";
export interface NotifyState {
  webhookUrl: string;
  format: "auto" | "ntfy" | "json";
  mac: boolean;
  kinds: Record<NotifyKind, boolean>;
  lastSentAt: string | null;
  lastError: string | null;
  /** A browser on this Mac gets notifications: they replace the macOS banner. */
  macBrowser: boolean;
}

export interface InboxItem {
  profile: string;
  profileName: string;
  id: string;
  title: string;
  attention: Attention;
  /** Snoozed from the Inbox until then: listed apart, not counted. */
  snoozedUntil?: string;
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

/** A question the daemon wants the user to answer before it goes on (e.g. a run and a huddle on the same ticket). */
export interface ServerConfirm { kind: string; message: string }
let askConfirm: ((q: ServerConfirm) => Promise<boolean>) | null = null;
/** The user answered a ServerConfirm with Cancel: nothing changed. */
export class NotStarted extends Error {
  constructor() { super("Not started."); }
}
/** ParallelConfirm registers the dialog that answers ServerConfirm questions (null: unregister). */
export function setServerConfirm(fn: typeof askConfirm) { askConfirm = fn; }

/** Where a file mentioned in a chat was found: the ticket's copy of the folder, the project folder or Outputs. */
export type FileRootName = "ticket" | "project" | "outputs";

export interface TicketFile {
  /** Relative to `dir`. */
  path: string;
  size: number;
  /** null when the file is binary or too large to show. */
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  root: FileRootName;
  dir: string;
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
  // The daemon asks first (409 + confirm): resend with the user's yes, or stop with nothing started.
  const confirm = (data as any).confirm;
  if (r.status === 409 && typeof confirm === "string" && askConfirm && body && typeof body === "object") {
    if (await askConfirm({ kind: confirm, message: (data as any).error ?? "" })) return req<T>(method, url, { ...body, confirmParallel: true });
    throw new NotStarted();
  }
  if (!r.ok) {
    const e = new Error((data as any).error ?? `${r.status} ${r.statusText}`) as Error & { code?: string };
    if (typeof (data as any).code === "string") e.code = (data as any).code;
    throw e;
  }
  return data as T;
}

const sch = (slug: string, id?: string) =>
  `/api/profiles/${encodeURIComponent(slug)}/schedules${id ? `/${encodeURIComponent(id)}` : ""}`;

const lp = (slug: string, id?: string) =>
  `/api/profiles/${encodeURIComponent(slug)}/loops${id ? `/${encodeURIComponent(id)}` : ""}`;

const jb = (slug: string, id?: string) =>
  `/api/profiles/${encodeURIComponent(slug)}/jobs${id ? `/${encodeURIComponent(id)}` : ""}`;

const t = (slug: string, id?: string) =>
  `/api/profiles/${encodeURIComponent(slug)}/tickets${id ? `/${encodeURIComponent(id)}` : ""}`;

const chatsUrl = (slug: string, id?: string) =>
  `/api/profiles/${encodeURIComponent(slug)}/chats${id ? `/${encodeURIComponent(id)}` : ""}`;

const sizes = new Map<string, Promise<number | null>>();

export const api = {
  claudeProjects: () => req<ClaudeProject[]>("GET", "/api/claude/projects"),
  claudeDefaults: () => req<{ model: string | null }>("GET", "/api/claude/defaults"),
  pickFolder: () => req<{ path: string | null }>("POST", "/api/pick-folder"),
  versionHistory: (path: string) => req<VersionHistory>("GET", `/api/version-history?path=${encodeURIComponent(path)}`),
  enableVersionHistory: (path: string) => req<{ changed: boolean; sha: string | null; ignored: string[]; repo: RepoKind }>("POST", "/api/version-history", { path }),
  /** Claude plan usage (5h / weekly windows) or a plain-words error. */
  usage: () => req<UsageResult>("GET", "/api/usage"),
  /** What every board spent today (local day). */
  spend: () => req<TodaySpend>("GET", "/api/spend"),
  version: () => req<{ version: string; latest: string | null; updateAvailable: boolean; url: string | null }>("GET", "/api/version"),
  health: () => req<Health>("GET", "/api/health"),
  /** pending: a daemon restart holds new runs until the `waiting` active runs finish. */
  remote: () => req<RemoteState>("GET", "/api/remote"),
  setRemote: (enabled: boolean) => req<RemoteState>("POST", "/api/remote", { enabled }),
  notify: () => req<NotifyState>("GET", "/api/notify"),
  setNotify: (patch: Partial<Pick<NotifyState, "webhookUrl" | "format" | "mac">> & { kinds?: Partial<Record<NotifyKind, boolean>> }) => req<NotifyState>("POST", "/api/notify", patch),
  testNotify: (profile: string | null) =>
    req<{ ok: boolean; error: string | null; webhook: boolean; devices: number; state: NotifyState }>("POST", "/api/notify/test", profile ? { profile } : {}),
  push: () => req<{ publicKey: string; devices: PushDevice[] }>("GET", "/api/push"),
  pushSubscribe: (subscription: PushSubscriptionJSON, label: string) => req<PushDevice>("POST", "/api/push/subscribe", { subscription, label }),
  pushRemove: (key: { id: string } | { endpoint: string }) => req<{ removed: boolean; devices: PushDevice[] }>("POST", "/api/push/remove", key),
  pushTest: (id: string, profile: string | null) => req<{ ok: boolean; error: string | null }>("POST", "/api/push/test", profile ? { id, profile } : { id }),
  pushVisible: (endpoint: string, visible: boolean) => req<{ ok: boolean }>("POST", "/api/push/visible", { endpoint, visible }),
  restartState: () => req<{ pending: boolean; waiting: number }>("GET", "/api/restart"),
  awakeState: () => req<{ held: boolean }>("GET", "/api/awake"),
  bugDraft: (ref: { profile: string; ticketId: string } | null) =>
    req<{ blocks: BugBlock[]; screenshots: string[] }>("POST", "/api/bug-report/draft", ref ?? {}),
  reportBug: (input: { title: string; description: string; include: BugBlockId[]; profile?: string; ticketId?: string }) =>
    req<BugReportResult>("POST", "/api/bug-report", { ...input, source: "ui" }),
  profiles: () => req<Profile[]>("GET", "/api/profiles"),
  createProfile: (p: { name: string; path: string; maxParallel?: number; model?: string; effort?: string; baseBranch?: string; workspace?: Workspace }) =>
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
  /** Accept (into the ticket's folder) or reject changes a helper handed in. */
  reviewHandIn: (slug: string, id: string, handInId: string, accept: boolean, reason = "") =>
    req<HandIn>("POST", `${hud(slug, id)}/hand-ins/${encodeURIComponent(handInId)}/${accept ? "accept" : "reject"}`, { reason }),
  /** Let a helper change files: it works in its own copy of the folder and hands its changes in. */
  allowHuddleChanges: (slug: string, id: string, handle: string) =>
    req<HuddleParticipant>("POST", `${hud(slug, id)}/participants/${encodeURIComponent(handle)}/allow-changes`, {}),
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
  /** What the board learned on its own: saved this week, cleaned up, seen once. */
  learned: (slug: string) => req<LearnedView>("GET", `/api/profiles/${encodeURIComponent(slug)}/learned`),
  /** The user opened the Learned view: the new count goes back to 0. */
  learnedSeen: (slug: string) => req<LearnedView>("POST", `/api/profiles/${encodeURIComponent(slug)}/learned/seen`),
  /** Undo (or redo) a saved lesson or a tidy step. */
  undoLearned: (slug: string, id: string, redo = false) =>
    req<LearnChange>("POST", `/api/profiles/${encodeURIComponent(slug)}/learned/changes/${encodeURIComponent(id)}/${redo ? "redo" : "undo"}`),
  /** A lesson seen once: save it now, drop it, or keep it after a drop. */
  learnedLesson: (slug: string, id: string, act: "save" | "drop" | "keep") =>
    req<LearnCandidate>("POST", `/api/profiles/${encodeURIComponent(slug)}/learned/lessons/${encodeURIComponent(id)}/${act}`),
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
  chats: (slug: string) => req<QuickChat[]>("GET", chatsUrl(slug)),
  /** A new chat starts with its first message. */
  newChat: (slug: string, text: string) => req<QuickChat>("POST", chatsUrl(slug), { text }),
  chatSend: (slug: string, id: string, text: string) => req<QuickChat>("POST", `${chatsUrl(slug, id)}/messages`, { text }),
  chatStop: (slug: string, id: string) => req<QuickChat>("POST", `${chatsUrl(slug, id)}/stop`, {}),
  chatRename: (slug: string, id: string, title: string) => req<QuickChat>("PATCH", chatsUrl(slug, id), { title }),
  chatDelete: (slug: string, id: string) => req<void>("DELETE", chatsUrl(slug, id)),
  chatTicket: (slug: string, id: string) => req<{ ticket: Ticket; chat: QuickChat }>("POST", `${chatsUrl(slug, id)}/ticket`, {}),
  chatConversation: (slug: string, id: string, before?: number) =>
    req<{ entries: SessionEntry[]; start: number; total: number }>("GET", `${chatsUrl(slug, id)}/conversation${before !== undefined ? `?before=${before}` : ""}`),
  chatTool: (slug: string, id: string, toolUseId: string) => req<ToolDetail>("GET", `${chatsUrl(slug, id)}/tool/${encodeURIComponent(toolUseId)}`),
  chatSimplified: (slug: string, id: string) => req<Record<string, string>>("GET", `${chatsUrl(slug, id)}/simplified`),
  chatSimplify: (slug: string, id: string, uuid: string) => req<{ text: string; cached: boolean }>("POST", `${chatsUrl(slug, id)}/simplify`, { uuid }),
  sessions: (slug: string) => req<ClaudeSession[]>("GET", `/api/profiles/${encodeURIComponent(slug)}/sessions`),
  addOnTicket: (slug: string, id: string, input: { title: string; body: string; start?: boolean; important?: boolean }) =>
    req<Ticket>("POST", `${t(slug, id)}/add-on`, input),
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
  /** Which of these file paths (as written in a chat message) exist in the ticket's folders. */
  findFiles: (slug: string, id: string, paths: string[]) =>
    req<{ found: Record<string, { root: FileRootName; rel: string }> }>("POST", `${t(slug, id)}/find-files`, { paths }),
  ticketFile: (slug: string, id: string, path: string) =>
    req<TicketFile>("GET", `${t(slug, id)}/file?path=${encodeURIComponent(path)}`),
  ticketFileUrl: (slug: string, id: string, path: string, download = false) =>
    `${t(slug, id)}/file?raw=1${download ? "&download=1" : ""}&path=${encodeURIComponent(path)}`,
  createTicket: (slug: string, input: {
    title: string; body: string; status: Status; sessionId?: string; mode?: TicketMode; parentId?: string; planKey?: string; dependsOn?: string[];
    needs?: string[]; tags?: string[]; important?: boolean;
  }) => req<Ticket>("POST", t(slug), input),
  plan: (slug: string, id: string, action: "start" | "pause" | "resume" | "done" | "concurrency", maxConcurrent?: number) =>
    req<Ticket>("POST", `${t(slug, id)}/plan`, { action, maxConcurrent }),
  updateTicket: (slug: string, id: string, patch: Partial<Pick<Ticket, "title" | "body" | "status" | "order" | "mode" | "notice" | "needs" | "tags" | "suggestedTags" | "important" | "runCapUsd" | "model" | "effort">> & { expectedBody?: string }) =>
    req<Ticket>("PATCH", t(slug, id), patch),
  deleteTicket: (slug: string, id: string) => req<void>("DELETE", t(slug, id)),
  /** Inbox Snooze: hide what the ticket waits for now for a day (or until its state changes). */
  followUpNow: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/follow-up/now`, {}),
  stopFollowUp: (slug: string, id: string) => req<Ticket>("DELETE", `${t(slug, id)}/follow-up`, {}),
  markSeen: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/seen`, {}),
  snooze: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/snooze`, {}),
  unsnooze: (slug: string, id: string) => req<Ticket>("DELETE", `${t(slug, id)}/snooze`),
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
  /** Rewind: what going back to one of the user's messages would change (files null: they can't be changed back, filesReason says why). */
  rewindPreview: (slug: string, id: string, uuid: string) =>
    req<{ blocked: string | null; files: { path: string; status: "A" | "D" | "M" }[] | null; filesReason: "no-history" | "no-snapshot" | null }>(
      "GET", `${t(slug, id)}/rewind?uuid=${encodeURIComponent(uuid)}`),
  /** Rewind: cut the chat before the message and, with files, put the project files back. Returns the message text. */
  rewind: (slug: string, id: string, uuid: string, files: boolean) =>
    req<{ text: string; restored: number }>("POST", `${t(slug, id)}/rewind`, { uuid, files }),
  /** Saved plain-words versions of the ticket's Claude replies, by message uuid. */
  simplified: (slug: string, id: string) => req<Record<string, string>>("GET", `${t(slug, id)}/simplified`),
  /** "Say it simpler": one reply rewritten in plain words (a side call; saved, so the second time is free). */
  simplify: (slug: string, id: string, uuid: string) => req<{ text: string; cached: boolean }>("POST", `${t(slug, id)}/simplify`, { uuid }),
  /** "Help me understand": saved answer cards, the kinds being answered, and whether a recap has anything to tell. */
  help: (slug: string, id: string) => req<{ cards: HelpCard[]; busy: HelpKind[]; recap: boolean }>("GET", `${t(slug, id)}/help`),
  /** A new "Help me understand" answer (a side call reading the ticket; its cost goes on the ticket). */
  askHelp: (slug: string, id: string, kind: HelpKind) => req<HelpCard>("POST", `${t(slug, id)}/help`, { kind }),
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
  passes: () => req<{ passes: Pass[]; automations: number }>("GET", "/api/passes"),
  addPass: (input: { kind: Pass["kind"]; name?: string; claudeName?: string | null; url?: string; envName?: string; secret?: string }) =>
    req<Pass>("POST", "/api/passes", input),
  replacePassKey: (id: string, secret: string) => req<Pass>("PATCH", `/api/passes/${encodeURIComponent(id)}`, { secret }),
  deletePass: (id: string) => req<void>("DELETE", `/api/passes/${encodeURIComponent(id)}`),
  authorizePass: (id: string) => req<{ url: string }>("POST", `/api/passes/${encodeURIComponent(id)}/authorize`),
  testLoop: (slug: string, script: string, passes: string[]) => req<LoopTest>("POST", `${lp(slug)}/test`, { script, passes }),
  automationSetup: (slug: string) => req<Ticket>("POST", `/api/profiles/${encodeURIComponent(slug)}/automation-setup`),
  answerAutomationCard: (slug: string, ticketId: string, uuid: string, loopId: string) =>
    req<Ticket>("PUT", `/api/profiles/${encodeURIComponent(slug)}/tickets/${encodeURIComponent(ticketId)}/automation-cards/${encodeURIComponent(uuid)}`, { loopId }),
  loops: (slug: string) => req<Loop[]>("GET", lp(slug)),
  createLoop: (slug: string, input: LoopInput) => req<Loop>("POST", lp(slug), input),
  updateLoop: (slug: string, id: string, patch: Partial<LoopInput>) => req<Loop>("PATCH", lp(slug, id), patch),
  deleteLoop: (slug: string, id: string) => req<void>("DELETE", lp(slug, id)),
  checkLoop: (slug: string, id: string) => req<Loop>("POST", `${lp(slug, id)}/check`),
  copyLoop: (slug: string, id: string, to: string) => req<Loop>("POST", `${lp(slug, id)}/copy`, { to }),
  schedules: (slug: string) => req<Schedule[]>("GET", sch(slug)),
  createSchedule: (slug: string, input: ScheduleInput) => req<Schedule>("POST", sch(slug), input),
  updateSchedule: (slug: string, id: string, patch: Partial<ScheduleInput & { enabled: boolean }>) => req<Schedule>("PATCH", sch(slug, id), patch),
  deleteSchedule: (slug: string, id: string) => req<void>("DELETE", sch(slug, id)),
  runSchedule: (slug: string, id: string) => req<{ entry: ScheduleHistoryItem; schedule: Schedule }>("POST", `${sch(slug, id)}/run`),
  scheduleHistory: (slug: string, id: string) => req<ScheduleHistoryItem[]>("GET", `${sch(slug, id)}/history`),
  /** Upcoming jobs plus every one that finished in the last 7 days. */
  jobs: (slug: string) => req<Job[]>("GET", `${jb(slug)}?finishedDays=7`),
  /** at: local "YYYY-MM-DDTHH:MM" (this computer's time). */
  updateJob: (slug: string, id: string, patch: { name?: string; at?: string }) => req<Job>("PATCH", jb(slug, id), patch),
  cancelJob: (slug: string, id: string) => req<Job>("POST", `${jb(slug, id)}/cancel`),
  runJobNow: (slug: string, id: string) => req<Job>("POST", `${jb(slug, id)}/run`),
  cronPreview: (expr: string) => req<CronPreview>("GET", `/api/cron/preview?expr=${encodeURIComponent(expr)}`),
  mcp: () => req<McpState>("GET", "/api/mcp"),
  mcpRefresh: () => req<McpState>("POST", "/api/mcp/refresh"),
  mcpAdd: (input: McpAddInput) => req<McpState>("POST", "/api/mcp", input),
  mcpRemove: (name: string) => req<McpState>("DELETE", `/api/mcp/${encodeURIComponent(name)}`),
  mcpLogin: (name: string) => req<McpState>("POST", `/api/mcp/${encodeURIComponent(name)}/login`),
  mcpLoginPaste: (name: string, text: string) => req<McpState>("POST", `/api/mcp/${encodeURIComponent(name)}/login-paste`, { text }),
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
  prResolveConflicts: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/pr/resolve-conflicts`),
  prMerge: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/pr/merge`),
  /** Stalled run: stop it, keep waiting, or restart it in the same session. */
  stall: (slug: string, id: string, action: "stop" | "wait" | "restart") => req<Ticket>("POST", `${t(slug, id)}/stall`, { action }),
  /** Usage limit: send "continue" now. */
  /** "Continue with +$Y" after a run stopped at its spending cap. */
  capContinue: (slug: string, id: string, addUsd: number) => req<Ticket>("POST", `${t(slug, id)}/cap-continue`, { addUsd }),
  limitContinue: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/limit`, { action: "continue" }),
  /** Usage limit: turn the automatic continue at the reset on or off for this ticket. */
  limitAuto: (slug: string, id: string, auto: boolean) => req<Ticket>("POST", `${t(slug, id)}/limit`, { auto }),
  planningCommand: (slug: string, id: string) => req<{ command: string }>("POST", `${t(slug, id)}/planning-command`),
  /** Raw image bytes; the server saves them and returns the URL to put in markdown. */
  /** Images go up with their type; other files as bytes with their name (the server checks both). */
  uploadAttachment: async (file: File, signal?: AbortSignal) => {
    const headers: Record<string, string> = isImageFile(file)
      ? { "content-type": file.type }
      : { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) };
    const r = await fetch("/api/attachments", { method: "POST", headers, body: file, signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data as any).error ?? `${r.status} ${r.statusText}`);
    return data as { url: string; path: string };
  },
  /** Size of a stored attachment, fetched once per file (file cards show it). */
  attachmentSize: (stored: string): Promise<number | null> => {
    let p = sizes.get(stored);
    if (!p) {
      p = fetch(`/api/attachments/${stored}/info`).then((r) => (r.ok ? r.json() : null)).then((d: any) => d?.size ?? null, () => null);
      sizes.set(stored, p);
    }
    return p;
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

/** Resolves false when nothing could be copied. Over plain http (a phone on the LAN) navigator.clipboard is missing. */
export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Off-screen and read-only: no scroll jump and no phone keyboard popping up.
    ta.readOnly = true;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS Safari ignores select() alone
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* not supported */ }
    ta.remove();
    return ok;
  }
}
