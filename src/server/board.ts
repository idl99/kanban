import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { extractFinalText, summarizeEvent } from "./activity";
import { copyAttachments, deleteAttachments, localizeAttachments, localizeUrls, referencedAttachments } from "./attachments";
import type { Bus } from "./events";
import { isSessionLive as psSessionLive, sessionTitle } from "./claude";
import { addWorktree, branchesWithPrefix, branchExists, FetchError, isGitRepo, latestBase, listWorktrees, removeWorktree, repoKind, resolveBaseBranch, worktreeDir, type RepoKind } from "./git";
import { MOVE_TO_PLANNING_RE, STAY_RE } from "./session";
import { forkSessionFile } from "./fork";
import { saveMockups } from "./mockups";
import { macBanner } from "./notify";
import { type HostHuddle, ticketAttention, userWaitReason } from "./attention";
import type { SessionSummary } from "./session";
import { recallBlock } from "./recall";
import { learnedRulesBlock } from "./learn";
import { lessonsBlock } from "./lessons";
import { chatPrompt, firstRunPrompt, followUpWakePrompt, freshSessionPrompt, interruptedPrompt, orchestratorPrompt, planningCommand, planningPrompt, resumePrompt, setupNote, steerPrompt, type ChatMode, type PlanWake } from "./prompts";
import {
  childrenOf, DEFAULT_MAX_CONCURRENT, findCycle, isComplete, MAX_RUN_CHAIN, MAX_RUN_STARTS, normalizeNeeds, planActive, planProblem, planStep, planTable,
  resolveDeps, wakeupCap,
} from "./plan";
import { run as runCmd } from "./git";
import { takeSnapshot } from "./rewind";
import { parseResult } from "./result";
import { FOLLOW_UP_LATE_MS, FOLLOW_UP_NOTE_MAX, FOLLOW_UP_REASON_MAX, FollowUpError, followUpTime, logFollowUp } from "./followup";
import { formatAt } from "./jobs";
import { ticketRuns } from "./ticket-usage";
import { AUTO_CONTINUE_PER_DAY, clockTime, CONTINUE_TEXT, dayKey, limitMessage, parseReset } from "./limit";
import { DraftTracker } from "./draft";
import { buildArgs, DEFAULT_STALL_MINUTES, PLANNING_DISALLOWED_TOOLS, startRun, type RunHandle } from "./runner";
import { RETRY_DELAY_MS, RETRY_TEXT, transientError } from "./retry";
import { BOARD_COMMANDS, commandText, EFFORT_HELP, validEffort, listCommands, MODEL_HELP, parseSlash, REFUSED_COMMANDS, rememberInit, slashMessage, useBundledFile, validModel, type SlashCommand } from "./commands";
import { mcpConfig } from "./agents";
import type { OwnedSession } from "./shell";
import type { Store } from "./store";
import { normalizeTags } from "./tags";
import { autoHuddlesOn, runCapFor, workspaceOf, type FollowUp, type Interrupted, type LimitHit, type Plan, type PrStatus, type Profile, type QueuedMessage, type SelfMove, type Status, type Ticket, type TicketMode, type TicketSource } from "./types";
import { CLEANUP_TIMEOUT_MS, copySetupFiles, prepareWorktree, runShell, SETUP_TIMEOUT_MS, withBoardText, type SetupOutcome, type SetupResult } from "./worktree-setup";

const INSTALLING = "Installing project dependencies…";
import { nowIso, slugify, starredTitle } from "./util";

export interface BoardOptions {
  claudeBin: string;
  /** Whether Claude has a stored session with this id (used to pick --resume vs --session-id). */
  sessionExists?: (sessionId: string) => boolean;
  /** Whether an interactive claude process currently has this session open. */
  isSessionLive?: (sessionId: string, title: string | null) => Promise<boolean>;
  /** The ticket's session open in one of the board's own terminals (the dock), which the board can close (Take over here). */
  findOwnedSession?: (sessionId: string) => Promise<OwnedSession | null>;
  /**
   * Tells the user about board events that aren't "needs you", e.g. a plan done, about ticket `id` on board `slug`
   * (default: a macOS banner, see notify.ts).
   */
  notify?: (title: string, body: string, slug: string, id: string) => void;
  /** Child events that arrive within this window wake the planner once (default 3s). */
  planWakeDelayMs?: number;
  /** The ticket's Claude session as the board UI sees it (open questions, pending proposal); a plan skips children waiting on the user. */
  sessionSummary?: (sessionId: string) => SessionSummary | null;
  /** The clock for usage-limit resets and the daily auto-continue cap (tests pass a fake one). */
  now?: () => Date;
  /** Pause before the one automatic retry after a passing API error (default RETRY_DELAY_MS; tests pass a short one). */
  retryDelayMs?: number;
  /** Stall watchdog time in ms, overriding the board's stallMinutes (tests). */
  stallMs?: number;
}

interface ActiveRun {
  slug: string;
  id: string;
  handle: RunHandle | null;
  promise: Promise<void>;
  /** Status to land on when the run ends because the user moved the card. */
  targetStatus: Status | null;
  /** The user asked this run, in its own chat, to move its card: the board moves it once the run ends (see requestSelfMove). */
  selfMove?: SelfMove;
  stopRequested: boolean;
  /**
   * Set for runs started from the ticket chat (not the Ready queue). raw: text is the full prompt (planner wake-ups);
   * returnTo: the column such a run goes back to, since a wake-up is housekeeping, not new work to review.
   * quiet: a reply to another ticket's Claude; the card, outcome and run count stay as they were.
   * from: the column the card was in when the message was sent (a reply that only proposed tickets goes back there).
   * user: answers a message the user typed in this ticket's chat, so the run may manage the ticket's own children
   * (see plannerRights); plan wake-ups, peer replies and messages from a planner's run don't.
   */
  chat?: {
    text: string; mode: ChatMode; raw?: boolean; returnTo?: Status; quiet?: boolean; from?: Pick<Ticket, "status" | "outcome">; user?: boolean;
    /** text is a slash command (see QueuedMessage.slash). */
    slash?: "prompt" | "local";
    /** A wake for the ticket's own auto huddle (see QueuedMessage.hostWake): a full prompt, run as the ticket's work. */
    hostWake?: boolean;
    /** The board's follow-up wake (see Board.wakeFollowUp): a full prompt; afterwards the card goes back to returnTo. */
    followUp?: boolean;
  };
  /** This message's run already got its one automatic retry after a passing API error. */
  retried?: boolean;
  /** The user chose Restart on a stalled run: once it is stopped, it resumes in the same session. */
  restartRequested?: boolean;
  /** This run started an auto huddle (start_huddle): one per run. */
  autoHuddleStarted?: boolean;
  /** Other tickets' runs this run started (see runStart). */
  runStarts?: number;
  /** The user typed a message in the ticket's chat that was handed to this run while it worked (see userAskedRun). */
  userSteered?: boolean;
  /** Queued messages (ticket.queued) written to this claude process, keyed by id, with the text it was given. */
  inFlight: Map<string, string>;
  /** Queued message this chat run was started with; it leaves the queue once Claude reads the prompt. */
  promptMsgId?: string;
  /** Reply text streaming in right now; kept on the ticket if a restart cuts the run off. */
  draft?: DraftTracker;
}

/** A finished assistant message with text in it (not just thinking or a tool call). */
function hasText(ev: any): boolean {
  if (ev?.type !== "assistant" || ev.parent_tool_use_id) return false;
  const c = ev.message?.content;
  return Array.isArray(c) && c.some((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim());
}

function replayText(ev: any): string | null {
  if (ev?.type !== "user" || !ev.isReplay) return null;
  const c = ev.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : null;
  // A slash command comes back as Claude Code's command tags: match it with the `/name args` the board sent.
  return text === null ? null : commandText(text) ?? text;
}

/** Backlog/Planning chats refine the ticket (no file edits); everywhere else Claude acts on the message. */
export function chatModeFor(status: Status): ChatMode {
  return status === "backlog" || status === "planning" ? "refine" : "act";
}

/** How a chat run handles a queued message: a peer message (from another ticket's Claude) is sent as-is, quietly. */
function chatFor(
  t: Pick<Ticket, "status" | "outcome">, msg: { text: string; peer?: boolean; fromPlanner?: boolean; slash?: "prompt" | "local"; hostWake?: boolean; followUp?: boolean },
): NonNullable<ActiveRun["chat"]> {
  // A follow-up comes back to the ticket's own work, wherever the card is; afterwards the card goes back there.
  if (msg.followUp) return { text: msg.text, mode: "act", raw: true, returnTo: t.status === "in_progress" ? "review" : t.status, followUp: true };
  // The ticket's auto huddle wakes it: unattended work on its own ticket, so it ends like a work run (result line, column).
  if (msg.hostWake) return { text: msg.text, mode: "act", raw: true, hostWake: true };
  const mode = chatModeFor(t.status);
  if (msg.peer) return { text: msg.text, mode, raw: true, quiet: true };
  const chat: NonNullable<ActiveRun["chat"]> = { text: msg.text, mode, from: { status: t.status, outcome: t.outcome }, ...(msg.fromPlanner ? {} : { user: true }) };
  if (!msg.slash) return chat;
  // A local command (/compact) gets no reply from Claude: like a peer reply, the card and outcome stay as they were.
  return { ...chat, slash: msg.slash, ...(msg.slash === "local" ? { quiet: true } : {}) };
}

/** Queued-message flags from Board.chat options. */
function flags(o: ChatOptions): Pick<QueuedMessage, "peer" | "fromPlanner" | "from" | "slash" | "hostWake" | "followUp"> {
  return {
    ...(o.from ? { from: o.from } : {}),
    ...(o.peer ? { peer: true } : {}), ...(o.fromPlanner ? { fromPlanner: true } : {}), ...(o.slash ? { slash: o.slash } : {}),
    ...(o.hostWake ? { hostWake: true } : {}), ...(o.followUp ? { followUp: true } : {}),
  };
}

/** Board.chat options; hostWake: the ticket's own auto huddle (or a free auto-huddle slot) wakes it; followUp: its follow-up is due. */
export interface ChatOptions {
  peer?: boolean;
  fromPlanner?: boolean;
  /** Sent by another ticket's Claude: which one (shown with the message instead of "You"). */
  from?: { ticketId: string; title: string };
  slash?: "prompt" | "local";
  hostWake?: boolean;
  followUp?: boolean;
}

/** What the card says while the ticket waits for its auto huddle. */
export function autoHuddleActivity(a: NonNullable<Ticket["autoHuddle"]>): string {
  return a.state === "waiting" ? "Waiting for huddle slot" : "Auto huddle: waiting for the review";
}

/** Holding a resource: Claude works on the ticket (In progress or a chat reply), or it is queued in Ready. */
/** Statuses whose ticket already did its work: moving it back to Planning or Backlog remembers it (Ticket.reopenedFrom). */
function reopenable(s: Status): boolean {
  return s === "review" || s === "done";
}

function holding(t: Ticket, running: boolean, withReady: boolean): boolean {
  return running || t.status === "in_progress" || (withReady && t.status === "ready");
}

/**
 * Runs that take a maxParallel slot: work, and chat replies that act on the ticket. Planning interviews, replies to
 * another ticket's Claude (its asker waits on them) and planner wake-ups are short housekeeping and don't.
 */
function takesSlot(chat?: ActiveRun["chat"]): boolean {
  return !chat || (chat.mode === "act" && !chat.quiet && (!chat.returnTo || !!chat.followUp));
}

const ACTIVITY_THROTTLE_MS = 1000;
/** How long a board folder's cached version history (see Board.repoState) is trusted. */
const REPO_TTL_MS = 10_000;
/** A run that would edit the board's folder while another ticket does waits with this on its card. */
export const FOLDER_WAIT = "waiting: another ticket is using the folder";

/** Where a ticket's runs work (see Board.ensureSession). */
export interface Session {
  dir: string;
  sessionId: string;
  existed: boolean;
  isGit: boolean;
  /** The board folder's version history. */
  repo: RepoKind;
  /** The run edits the board's folder itself (no worktree, not a linked session). */
  inPlace: boolean;
}
/** What a stalled run's session is told when the user restarts it. */
const STALL_RESTART_TEXT = "Your previous run stopped responding and the user restarted it. Continue where you left off.";
/** A requested restart waits this long for active runs to finish, then restarts anyway (recover() resumes them). */
export const RESTART_MAX_WAIT_MS = 10 * 60_000;
const DRAFT_THROTTLE_MS = 120;

/** The session's transcript file under Claude's projects folder, if any. */
export function claudeSessionFile(sessionId: string): string | null {
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  if (!existsSync(root)) return null;
  try {
    const d = readdirSync(root).find((d) => existsSync(join(root, d, `${sessionId}.jsonl`)));
    return d ? join(root, d, `${sessionId}.jsonl`) : null;
  } catch {
    return null;
  }
}

export function claudeSessionExists(sessionId: string): boolean {
  return claudeSessionFile(sessionId) !== null;
}

/** Claude's answer to `--resume` with a session it has no transcript for. */
export function sessionMissing(error: string, events: any[]): boolean {
  const re = /No conversation found with session ID/i;
  return re.test(error) || events.some((e) => e?.type === "result" && Array.isArray(e.errors) && e.errors.some((m: unknown) => typeof m === "string" && re.test(m)));
}

export const SESSION_OPEN_MSG = "This ticket's Claude session is still open in a terminal. Exit it there (Ctrl+D or /exit), then try again.";

/** Run errors the board offers a one-click fix for: Start fresh session, or Take over here. */
export type Recovery = "session_missing" | "session_open";

export function recoveryFor(error: string | null | undefined): Recovery | null {
  if (!error) return null;
  if (sessionMissing(error, [])) return "session_missing";
  if (error === SESSION_OPEN_MSG) return "session_open";
  return null;
}

/** Board comments that aren't Claude's result (a fresh session's prompt skips them for "Last result"). */
const BOARD_NOTE_RE = /^(Run failed|Could not start|Run stopped|Planner stopped|Started a fresh session|Took over the session|This ticket's Claude session is still open)/;

export class ConflictError extends Error {}

export class Board {
  private runs = new Map<string, ActiveRun>();
  /** Setup commands running now (`ckanban ticket setup`; stopping the ticket's run aborts them), per ticket key. */
  private setups = new Map<string, { done: Promise<SetupOutcome>; abort: AbortController }>();
  private shuttingDown = false;
  /** A restart waits for active runs to finish: no new run starts until then (see requestRestart). */
  private restartPending = false;
  /** Other work a restart waits for besides board runs (huddle agents mid-turn), see onRestartBusy. */
  private restartBusy: (() => string[])[] = [];
  /** Each board's open huddles by host ticket (see onHostHuddles); none until Huddles registers. */
  private hostHuddleStates: (slug: string) => Map<string, HostHuddle> = () => new Map();
  private sessionExists: (id: string) => boolean;
  private isSessionLive: (id: string, title: string | null) => Promise<boolean>;
  private notify: (title: string, body: string, slug: string, id: string) => void;

  private sessionSummary: (sessionId: string) => SessionSummary | null;

  constructor(private store: Store, private bus: Bus, private opts: BoardOptions) {
    this.sessionSummary = opts.sessionSummary ?? (() => null);
    this.sessionExists = opts.sessionExists ?? claudeSessionExists;
    this.isSessionLive = opts.isSessionLive ?? psSessionLive;
    this.notify = opts.notify ?? ((title, body) => macBanner(title, body));
    useBundledFile(join(store.root, "claude-commands.json"));
  }

  private key(slug: string, id: string) {
    return `${slug}/${id}`;
  }

  private emitTicket(slug: string, t: Ticket) {
    this.bus.emit({ type: "ticket.updated", profile: slug, ticket: t });
  }

  private patch(slug: string, id: string, patch: Partial<Ticket>): Ticket {
    const before = "needs" in patch ? this.store.getTicket(slug, id) : null;
    const t = this.store.updateTicket(slug, id, patch);
    this.emitTicket(slug, t);
    const needs = [...(before?.needs ?? []), ...(t.needs ?? [])];
    if (needs.length && ("status" in patch || "runStartedAt" in patch || "needs" in patch)) this.resourceChanged(needs);
    return t;
  }

  /** Cache the ticket's PR status (prpoller.ts) and tell the UI. */
  setPr(slug: string, id: string, pr: PrStatus): Ticket {
    return this.patch(slug, id, { pr });
  }

  // ---- Exclusive resources (Ticket.needs): one ticket per resource at a time, across every board ----

  private resourceDirty = new Set<string>();

  /**
   * A ticket started or stopped holding these resources: once the current change is done, refresh the cards that
   * wait for them and let every board start what can start now (the holder may be on another board).
   */
  private resourceChanged(names: string[]): void {
    const first = !this.resourceDirty.size;
    for (const n of names) this.resourceDirty.add(n);
    if (!first) return;
    queueMicrotask(() => {
      const dirty = new Set(this.resourceDirty);
      this.resourceDirty.clear();
      if (this.shuttingDown) return;
      for (const p of this.store.listProfiles()) {
        for (const t of this.store.listTickets(p.slug)) {
          if (t.needs?.some((n) => dirty.has(n)) && !holding(t, this.isRunning(p.slug, t.id), false)) this.emitTicket(p.slug, t);
        }
        this.dispatch(p.slug);
        this.advancePlans(p.slug);
      }
    });
  }

  /**
   * Resources `t` needs that another ticket holds right now, on any board. withReady: a ticket queued in Ready
   * counts as holding (when deciding what a plan moves to Ready); dispatch() leaves it out, Ready is the queue.
   */
  heldResources(slug: string, t: Ticket, withReady: boolean): string[] {
    const want = t.needs ?? [];
    if (!want.length) return [];
    const busy = new Set<string>();
    for (const p of this.store.listProfiles()) {
      for (const o of this.store.listTickets(p.slug)) {
        if ((p.slug === slug && o.id === t.id) || !o.needs?.length) continue;
        if (!holding(o, this.isRunning(p.slug, o.id), withReady)) continue;
        for (const n of o.needs) if (want.includes(n)) busy.add(n);
      }
    }
    return want.filter((n) => busy.has(n));
  }

  /** For the card: whether the ticket holds its resources now, or which ones it waits for. */
  resourceState(slug: string, t: Ticket): { holding: boolean; waitingFor: string[] } | null {
    if (!t.needs?.length) return null;
    const running = this.isRunning(slug, t.id);
    if (holding(t, running, false)) return { holding: true, waitingFor: [] };
    // Only cards the board would start soon can wait: Ready, or Backlog children of a running plan.
    const parent = t.parentId ? this.store.getTicket(slug, t.parentId) : null;
    if (t.status !== "ready" && !(t.status === "backlog" && planActive(parent?.plan))) return { holding: false, waitingFor: [] };
    return { holding: false, waitingFor: this.heldResources(slug, t, t.status === "backlog") };
  }

  /** Why a plan child waits on the user (questions, a proposal to apply, in Planning), or null. */
  userWait(t: Ticket): string | null {
    return userWaitReason(t, t.sessionId ? this.sessionSummary(t.sessionId) : null);
  }

  /** The card still needs the user (questions, a proposal or new tickets to apply, a failed run), not just a look. */
  waitsOnUser(slug: string, id: string): boolean {
    const t = this.store.getTicket(slug, id);
    if (!t) return false;
    const a = ticketAttention(this.store, slug, t, t.sessionId ? this.sessionSummary(t.sessionId) : null, this.isRunning(slug, id),
      this.hostHuddles(slug).get(id));
    return !!a && a.kind !== "review";
  }

  /** Snooze the ticket from the Inbox until a time (null: unsnooze); key: snoozeKey of what it waits for now. */
  setSnooze(slug: string, id: string, snooze: { until: string; key: string } | null): Ticket {
    return this.patch(slug, id, { snooze });
  }

  /** Runs holding a maxParallel slot (see takesSlot). */
  running(slug: string): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.slug === slug && takesSlot(r.chat)) n++;
    return n;
  }

  /** The ticket's run holds one of the board's maxParallel slots. */
  holdsSlot(slug: string, id: string): boolean {
    const r = this.runs.get(this.key(slug, id));
    return !!r && takesSlot(r.chat);
  }

  private full(slug: string): boolean {
    return this.running(slug) >= Math.max(1, this.store.getProfile(slug)?.maxParallel ?? 1);
  }

  isRunning(slug: string, id: string): boolean {
    return this.runs.has(this.key(slug, id));
  }

  /** The ticket's current run is a quiet reply to another session's message (a peer run, e.g. a huddle's). */
  isPeerRun(slug: string, id: string): boolean {
    return !!this.runs.get(this.key(slug, id))?.chat?.quiet;
  }

  dispatch(slug: string): void {
    if (this.restartPending || this.shuttingDown) return; // Ready tickets start after the restart
    const profile = this.store.getProfile(slug);
    if (!profile || !existsSync(profile.path)) return;
    const idle = this.store.listTickets(slug).filter((t) => !t.error?.startsWith("corrupt") && !this.isRunning(slug, t.id));
    // Chat replies waiting for a slot go first, oldest first: they continue work that is already underway.
    for (const t of idle.filter((t) => t.slotWait).sort((a, b) => a.slotWait!.at.localeCompare(b.slotWait!.at))) {
      const next = this.waiting(slug, t.id)[0];
      if (!next) {
        this.cancelSlotWait(slug, t.id);
        continue;
      }
      const chat = next.peer || next.hostWake ? chatFor(t, next) : next.followUp ? chatFor(t.slotWait!.from, next) : { ...chatFor(t, next), mode: "act" as const, from: t.slotWait!.from };
      if (takesSlot(chat) && this.full(slug)) return;
      if (chat.mode === "act" && this.folderBusy(slug, t)) continue;
      this.patch(slug, t.id, { slotWait: null });
      this.start(slug, t.id, chat, next.id);
    }
    const ready = idle.filter((t) => t.status === "ready").sort((a, b) => a.order - b.order);
    for (const t of ready) {
      if (this.full(slug)) break;
      // Its resource (e.g. the emulator) is in use: it keeps its place and the next ticket starts instead.
      if (t.needs?.length && this.heldResources(slug, t, false).length) continue;
      // It would edit the board's folder in place while another ticket does: it waits its turn the same way.
      if (this.folderBusy(slug, t)) continue;
      this.start(slug, t.id);
    }
  }

  /** All slots are busy (or the folder is): the card waits in In Progress with its queued message(s) until dispatch() starts it. */
  private waitForSlot(slug: string, id: string): Ticket {
    const t = this.store.getTicket(slug, id)!;
    return this.patch(slug, id, {
      status: "in_progress", outcome: null, error: null, lastActivity: this.full(slug) ? "Waiting for a free slot" : FOLDER_WAIT,
      slotWait: t.slotWait ?? { at: nowIso(), from: { status: t.status, outcome: t.outcome } },
    });
  }

  /** Stop (or a move) before a waiting reply started: its messages stay for the user to send or discard. */
  private cancelSlotWait(slug: string, id: string): Ticket {
    const t = this.store.getTicket(slug, id)!;
    const from = t.slotWait?.from ?? { status: "review" as Status, outcome: t.outcome };
    return this.patch(slug, id, {
      status: from.status, outcome: from.outcome, slotWait: null, lastActivity: null,
      queued: (t.queued ?? []).map((m) => (m.state === "queued" ? { ...m, state: "unsent" } : m)),
    });
  }

  /**
   * Send a chat message: resumes the ticket's session right away, like typing in the terminal.
   * While Claude is working the message steers the run instead: Claude reads it at its next step.
   * peer: the message comes from another session (a huddle) and is already a full prompt.
   */
  async chat(slug: string, id: string, text: string, opts: ChatOptions = {}): Promise<Ticket> {
    // Rewind needs the folder as it is right before this message: saved quietly, the user's own history is untouched.
    // Done first, so everything below still runs in one go (a message can't slip in between the checks and the start).
    if (!opts.peer && !opts.hostWake && !opts.followUp && text.trim()) {
      const dir = this.rewindDir(slug, id);
      if (dir) await takeSnapshot(dir, id, text);
    }
    return this.chatNow(slug, id, text, opts);
  }

  private async chatNow(slug: string, id: string, text: string, opts: ChatOptions): Promise<Ticket> {
    let t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    if (!text.trim()) throw new Error("message is empty");
    if (t.error?.startsWith("corrupt")) throw new Error("ticket file is corrupt");
    const active = this.runs.get(this.key(slug, id));
    if (!opts.peer && !opts.slash && !opts.hostWake && !opts.followUp) {
      const refused = parseSlash(text)?.name;
      if (refused && REFUSED_COMMANDS.has(refused)) {
        throw new Error(`/${refused} isn't available here: start a new ticket for a fresh conversation.`);
      }
      const slash = slashMessage(text, this.commands(slug, id));
      if (slash && BOARD_COMMANDS.has(slash.command.name)) return this.boardCommand(slug, id, slash.command.name, slash.args);
      if (slash) [text, opts] = [slash.text, { ...opts, slash: slash.command.local ? "local" : "prompt" }];
    }
    // The user chats on a Backlog card: it is being shaped now, so it shows in Planning (a running plan's children stay put).
    const parent = t.parentId ? this.store.getTicket(slug, t.parentId) : null;
    if (t.status === "backlog" && !opts.peer && !opts.fromPlanner && !opts.hostWake && !opts.followUp && opts.slash !== "local" && !planActive(parent?.plan)) {
      t = this.patch(slug, id, { status: "planning", refineStarted: true });
    }
    // The user (or the board's automatic continue) picks the conversation up again: the limit wait is over.
    if (t.limit && !opts.peer && !opts.hostWake && !opts.followUp) this.patch(slug, id, { limit: null });
    if (active) {
      if (active.stopRequested || this.shuttingDown) throw new ConflictError("Claude is stopping; send your message once it has stopped");
      // Saved on the ticket until Claude reads it, so closing the chat, Stop or a restart can't lose it.
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      this.patch(slug, id, { queued: [...(t.queued ?? []), msg] });
      this.steer(active, msg);
      return this.store.getTicket(slug, id)!;
    }
    if (this.restartPending) {
      // Starts after the restart: recover() answers queued messages.
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      return this.patch(slug, id, { queued: [...(t.queued ?? []), msg] });
    }
    const chat = chatFor(t, { text, ...opts });
    // A reply that may edit files (not a read-only Planning one) waits while another ticket edits the folder in place.
    const folderBusy = chat.mode === "act" && this.folderBusy(slug, t);
    if (!takesSlot(chat) && (folderBusy || t.slotWait)) {
      // A reply to another session (a huddle) holds no slot: it waits on the ticket without moving the card.
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      this.patch(slug, id, {
        queued: [...(t.queued ?? []), msg], lastActivity: FOLDER_WAIT,
        slotWait: t.slotWait ?? { at: nowIso(), from: { status: t.status, outcome: t.outcome } },
      });
      this.dispatch(slug);
      return this.store.getTicket(slug, id)!;
    }
    if (takesSlot(chat) && (t.slotWait || this.full(slug) || folderBusy)) {
      // Every run slot is busy: the reply waits on the ticket like a Ready ticket, but starts before them.
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      this.patch(slug, id, { queued: [...(t.queued ?? []), msg] });
      this.waitForSlot(slug, id);
      this.dispatch(slug);
      return this.store.getTicket(slug, id)!;
    }
    // The user's message is saved until Claude reads it: Stop before then leaves it unsent, not lost.
    if (opts.peer || opts.hostWake || opts.followUp) this.start(slug, id, chat);
    else {
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      this.start(slug, id, chat, msg.id);
      // Added once the run is registered, so the chat never shows it as waiting with no run behind it.
      this.patch(slug, id, { queued: [...(this.store.getTicket(slug, id)!.queued ?? []), msg] });
    }
    return this.store.getTicket(slug, id)!;
  }

  /**
   * The folder a ticket's Claude edits, once it is known (its own copy, a linked folder, or the project folder after
   * the first run edited it in place); null before that, so rewind never snapshots the wrong folder.
   */
  rewindDir(slug: string, id: string): string | null {
    const t = this.store.getTicket(slug, id);
    const profile = this.store.getProfile(slug);
    if (!t || !profile) return null;
    if (t.workdir || t.worktree) return t.workdir ?? t.worktree ?? null;
    return t.baseSha ? profile.path : null;
  }

  /** Why the chat can't be rewound right now, or null when it can. */
  rewindBlocked(slug: string, id: string): string | null {
    const t = this.store.getTicket(slug, id);
    if (!t) return "ticket not found";
    if (this.isRunning(slug, id)) return "Claude is working. Stop it or wait until it has replied.";
    if (t.queued?.length) return "A message is still waiting to be sent. Send or discard it first.";
    // In the project folder itself, another ticket's run edits the same files: putting them back would undo its work too.
    if (!t.workdir && !t.worktree && this.folderBusy(slug, t)) return "Another ticket is editing this folder right now. Try again when it has finished.";
    return null;
  }

  /** The conversation was cut by a rewind: with nothing left of it, the next message starts a new session. */
  rewound(slug: string, id: string, emptied: boolean): Ticket {
    this.recoverable(slug, id);
    return this.patch(slug, id, emptied
      ? { sessionId: crypto.randomUUID(), sessionStarted: false, freshSession: true, lastActivity: null }
      : { lastActivity: null });
  }

  /** What `/` can run in this ticket's chat (the composer's picker lists the same). */
  commands(slug: string, id: string): SlashCommand[] {
    const t = this.store.getTicket(slug, id);
    const profile = this.store.getProfile(slug);
    if (!t || !profile) return [];
    return listCommands(t.workdir ?? t.worktree ?? profile.path, { projects: [profile.path] });
  }

  /** /model: the board's own command. Claude Code's version only lasts for one run (see commands.ts). */
  private boardCommand(slug: string, id: string, name: string, args: string): Ticket {
    const t = this.store.getTicket(slug, id)!;
    if (name === "model") {
      const profile = this.store.getProfile(slug)!;
      const fallback = profile.model ? `the board's model (${profile.model})` : "Claude Code's default model";
      if (!args) {
        return this.patch(slug, id, { notice: t.model ? `This ticket uses model ${t.model}. Change it with /model <name>, or /model default.` : `This ticket uses ${fallback}. Change it with /model <name>, e.g. /model sonnet.` });
      }
      const reset = args === "default" || args === "reset";
      if (!reset && !validModel(args)) throw new Error(`"${args}" is not a model name. Use ${MODEL_HELP}.`);
      const when = this.isRunning(slug, id) ? "from the next run (the current one keeps its model)" : "from the next run";
      return this.patch(slug, id, { model: reset ? null : args, notice: reset ? `Model reset: this ticket uses ${fallback} ${when}.` : `Model set to ${args} for this ticket, ${when}.` });
    }
    if (name === "effort") {
      const profile = this.store.getProfile(slug)!;
      const fallback = profile.effort ? `the board's effort (${profile.effort})` : "Claude Code's default effort";
      if (!args) {
        return this.patch(slug, id, { notice: t.effort ? `This ticket uses effort ${t.effort}. Change it with /effort <level>, or /effort default.` : `This ticket uses ${fallback}. Change it with /effort <level>, e.g. /effort high.` });
      }
      const reset = args === "default" || args === "reset";
      if (!reset && !validEffort(args)) throw new Error(`"${args}" is not an effort level. Use ${EFFORT_HELP}.`);
      const when = this.isRunning(slug, id) ? "from the next run (the current one keeps its effort)" : "from the next run";
      return this.patch(slug, id, { effort: reset ? null : args, notice: reset ? `Effort reset: this ticket uses ${fallback} ${when}.` : `Effort set to ${args} for this ticket, ${when}.` });
    }
    return t;
  }

  /** Send a message that was left unsent by Stop, as if the user typed it now. */
  async sendQueued(slug: string, id: string, msgId: string): Promise<Ticket> {
    const msg = this.store.getTicket(slug, id)?.queued?.find((m) => m.id === msgId);
    if (!msg) throw new Error("message not found");
    if (msg.state !== "unsent") throw new ConflictError("message is already on its way to Claude");
    this.dropQueued(slug, id, [msgId]);
    return this.chat(slug, id, msg.text, { peer: msg.peer, fromPlanner: msg.fromPlanner, from: msg.from, slash: msg.slash, hostWake: msg.hostWake, followUp: msg.followUp });
  }

  discardQueued(slug: string, id: string, msgId: string): Ticket {
    const msg = this.held(slug, id, msgId);
    const t = this.dropQueued(slug, id, [msgId]);
    // The last reply waiting for a slot is gone: nothing is left to start, so the card goes back.
    return t.slotWait && !this.waiting(slug, id).length ? this.cancelSlotWait(slug, id) : t;
  }

  /** Fix a message Claude hasn't received yet: it keeps its place in the queue. */
  editQueued(slug: string, id: string, msgId: string, text: string): Ticket {
    if (!text.trim()) throw new Error("message is empty");
    const msg = this.held(slug, id, msgId);
    const t = this.store.getTicket(slug, id)!;
    return this.patch(slug, id, { queued: (t.queued ?? []).map((m) => (m.id === msg.id ? { ...m, text } : m)) });
  }

  /**
   * A queued message the user can still change: left unsent by Stop, or waiting for a run slot or a restart.
   * With a run going it was written to Claude's stdin at once (peer messages included), so it is delivered.
   */
  private held(slug: string, id: string, msgId: string): QueuedMessage {
    const msg = this.store.getTicket(slug, id)?.queued?.find((m) => m.id === msgId);
    if (!msg) throw new Error("message not found");
    if (msg.state === "unsent") return msg;
    if (msg.peer || this.isRunning(slug, id)) throw new ConflictError("message is already on its way to Claude");
    return msg;
  }

  private dropQueued(slug: string, id: string, ids: string[]): Ticket {
    const t = this.store.getTicket(slug, id)!;
    return this.patch(slug, id, { queued: (t.queued ?? []).filter((m) => !ids.includes(m.id)) });
  }

  /** Hand a queued message to the live claude process; false when there is none to take it yet. */
  private steer(run: ActiveRun, msg: QueuedMessage): boolean {
    if (run.inFlight.has(msg.id) || run.promptMsgId === msg.id) return true;
    // A slash command goes alone: anything after it would become the command's arguments.
    const text = msg.slash ? localizeUrls(msg.text, this.store.attachmentsDir) : localizeAttachments(msg.peer || msg.hostWake || msg.followUp ? msg.text : steerPrompt(msg.text), this.store.attachmentsDir);
    if (!run.handle?.send(text, { local: msg.slash === "local" })) return false;
    // Claude never echoes a local command back: it is read once it is written.
    if (msg.slash === "local") this.dropQueued(run.slug, run.id, [msg.id]);
    else run.inFlight.set(msg.id, text);
    if (!msg.peer && !msg.fromPlanner && !msg.hostWake && !msg.followUp && !msg.slash) run.userSteered = true;
    return true;
  }

  /** Messages Claude has not read yet, waiting to be handed to a run. */
  private waiting(slug: string, id: string): QueuedMessage[] {
    return (this.store.getTicket(slug, id)?.queued ?? []).filter((m) => m.state === "queued");
  }

  /** Claude echoed a user message back: it has read it, so it leaves the queue. */
  private delivered(run: ActiveRun, text: string) {
    let msgId = [...run.inFlight].find(([, sent]) => sent === text)?.[0];
    if (msgId) run.inFlight.delete(msgId);
    // Anything else echoed back is the run's own prompt.
    else if (run.promptMsgId) [msgId, run.promptMsgId] = [run.promptMsgId, undefined];
    if (msgId) this.dropQueued(run.slug, run.id, [msgId]);
  }

  /** Entering Planning means "shape this with Claude": start the interview once, without a click. */
  private autoRefine(slug: string, id: string): void {
    const t = this.store.getTicket(slug, id);
    if (!t || t.status !== "planning" || t.refineStarted || this.isRunning(slug, id) || this.shuttingDown) return;
    if (t.error?.startsWith("corrupt")) return;
    // A linked session is already a conversation about work underway; an interview would be noise.
    // A run stopped before Claude saved its session left nothing to talk over: interview as if new.
    if (t.workdir || (t.sessionStarted && t.sessionId && this.sessionExists(t.sessionId))) return;
    if (this.restartPending) {
      this.patch(slug, id, { refineStarted: true, interrupted: { at: nowIso(), mode: "refine", prompt: { text: "" }, held: true } });
      return;
    }
    this.start(slug, id, { text: "", mode: "refine" });
  }

  private start(slug: string, id: string, chat?: ActiveRun["chat"], promptMsgId?: string) {
    const run: ActiveRun = {
      slug, id, handle: null, promise: Promise.resolve(), targetStatus: null, stopRequested: false, chat, inFlight: new Map(), promptMsgId,
    };
    this.runs.set(this.key(slug, id), run);
    this.begin(run);
    run.promise = this.execute(run)
      .catch((e) => {
        console.error(`run ${slug}/${id} crashed`, e);
        try {
          this.patch(slug, id, { ...this.endStatus(run), outcome: "failed", error: String(e?.message ?? e) });
        } catch {}
      })
      .finally(async () => {
        this.runs.delete(this.key(slug, id));
        // Before a pending restart, so the move the user asked for isn't lost.
        await this.applySelfMove(run);
        if (this.restartPending) this.emitRestart();
        // Tell the UI the run is over (earlier updates were sent while it was still registered).
        const now = this.store.getTicket(slug, id);
        if (now && !this.shuttingDown) {
          if (now.runStartedAt || now.interrupted || now.waitingOn || now.stalled || now.followUpRun) this.patch(slug, id, { runStartedAt: null, interrupted: null, waitingOn: null, stalled: null, followUpRun: null });
          else this.emitTicket(slug, now);
        }
        // When the user moved the card, updateTicket() writes the new status and dispatches itself.
        if (!this.shuttingDown && !run.targetStatus) this.dispatch(slug);
        if (!this.shuttingDown) this.advancePlans(slug);
      });
  }

  /** The move the user asked the run for, now that its reply is over; not when the user stopped or moved it meanwhile. */
  private async applySelfMove(run: ActiveRun): Promise<void> {
    const status = run.selfMove;
    if (!status || run.stopRequested || run.targetStatus || this.shuttingDown || this.isRunning(run.slug, run.id)) return;
    const t = this.store.getTicket(run.slug, run.id);
    if (!t || t.status === status) return;
    try {
      await this.updateTicket(run.slug, run.id, { status });
      this.store.addComment(run.slug, run.id, "ai", `Moved it to ${status} by its own chat (user request).`);
    } catch (e) {
      this.store.addComment(run.slug, run.id, "ai", `Couldn't move it to ${status} as asked in the chat: ${(e as Error).message}`);
    }
  }

  private begin(run: ActiveRun) {
    const t = this.store.getTicket(run.slug, run.id);
    const followUpRun = run.chat?.followUp && run.chat.returnTo ? { returnTo: run.chat.returnTo } : null;
    if (followUpRun || t?.followUpRun) this.patch(run.slug, run.id, { followUpRun });
    this.patch(run.slug, run.id, run.chat?.quiet
      ? { error: null, lastActivity: "Claude is replying…", runStartedAt: nowIso(), waitingOn: null, stalled: null }
      : run.chat?.mode === "refine"
      ? { error: null, lastActivity: "Claude is replying…", refineStarted: true, runStartedAt: nowIso(), waitingOn: null, stalled: null }
      : { status: "in_progress", outcome: null, error: null, limit: null, capHit: null, lastActivity: "Starting…", runStartedAt: nowIso(), waitingOn: null, stalled: null });
  }

  /** One claude run, then a chat reply for each message that came in too late for it. */
  private async execute(run: ActiveRun): Promise<void> {
    await this.executeOnce(run);
    if (run.chat?.followUp) this.followUpCost(run.slug, run.id);
    for (;;) {
      if (this.shuttingDown || this.restartPending) return; // queue stays on the ticket; recover() delivers it
      const t = this.store.getTicket(run.slug, run.id);
      if (!t) return;
      const next = this.waiting(run.slug, run.id)[0];
      if (!next) return;
      // Stopped, or the last reply could not even start: keep them for the user to send or discard.
      if (run.stopRequested || run.promptMsgId === next.id) {
        this.patch(run.slug, run.id, { queued: (t.queued ?? []).map((m) => (m.state === "queued" ? { ...m, state: "unsent" } : m)) });
        return;
      }
      const chat = chatFor(t, next);
      // A Planning or peer reply run doesn't hold a slot: one that would now act waits for one like any other.
      if (takesSlot(chat) && !takesSlot(run.chat) && this.full(run.slug)) {
        this.waitForSlot(run.slug, run.id);
        return;
      }
      run.chat = chat;
      run.retried = false;
      run.restartRequested = false;
      run.promptMsgId = next.id;
      run.inFlight = new Map();
      run.handle = null;
      this.begin(run);
      await this.executeOnce(run);
      if (run.chat?.followUp) this.followUpCost(run.slug, run.id);
    }
  }

  /** Where the card lands after a run: refine chats and replies to other tickets never move it. */
  private endStatus(run: ActiveRun): Partial<Ticket> {
    if (run.chat?.mode === "refine" || run.chat?.quiet) return run.targetStatus ? { status: run.targetStatus } : {};
    const status = run.targetStatus ?? run.chat?.returnTo ?? "review";
    // Done would close the ticket's open huddle: the card waits in Review until the user closes it.
    return { status: status === "done" && !run.targetStatus && this.huddleOpen(run.slug, run.id) ? "review" : status };
  }

  /** The ticket hosts a huddle that isn't closed. */
  private huddleOpen(slug: string, id: string): boolean {
    return this.hostHuddles(slug).has(id);
  }

  /**
   * healed: this is the one retry in a new session after Claude could not find the old one.
   * resume: the board continues this run's own work in its session (a passing API error, a stall restart) with this
   * text as the whole prompt; the run otherwise ends as the one it continues (result line, column, card). Without a
   * saved session (it hung before Claude saved one) there is nothing to continue: the run starts over with its prompt.
   */
  private async executeOnce(run: ActiveRun, healed = false, resumeText?: string): Promise<void> {
    const { slug, id } = run;
    const startedAt = nowIso();
    let session: Session;
    try {
      session = await this.ensureSession(slug, id);
    } catch (e) {
      const msg = (e as Error).message;
      this.store.addComment(slug, id, "ai", `Could not start: ${msg}`);
      // refineStarted back off: moving the card into Planning again retries the interview.
      // Offline or signed out (FetchError): nothing is wrong with the ticket; the user fixes it and sends a message.
      this.patch(slug, id, { ...this.endStatus(run), outcome: e instanceof FetchError ? "blocked" : "failed", error: msg, lastActivity: null, ...(run.chat?.mode === "refine" ? { refineStarted: false } : {}) });
      return;
    }
    if (this.shuttingDown) return;
    // Unattended runs refuse to share a session with an open terminal; chat messages are the user's call (UI warns).
    if (session.existed && !run.stopRequested && !run.chat) {
      const t0 = this.store.getTicket(slug, id)!;
      const title = t0.workdir ? sessionTitle(t0.workdir, session.sessionId) : null;
      if (await this.isSessionLive(session.sessionId, title)) {
        const msg = SESSION_OPEN_MSG;
        this.store.addComment(slug, id, "ai", msg);
        this.patch(slug, id, { ...this.endStatus(run), outcome: "blocked", error: msg, lastActivity: null });
        return;
      }
    }
    if (run.stopRequested) {
      this.store.addComment(slug, id, "ai", "Run stopped by user.");
      this.patch(slug, id, { ...this.endStatus(run), outcome: "stopped", lastActivity: null });
      return;
    }

    const t = this.store.getTicket(slug, id)!;
    const resume = session.existed ? resumeText : undefined;
    const refine = run.chat?.mode === "refine";
    // A reply to another ticket's Claude: not a run of this ticket's own work.
    const quiet = !!run.chat?.quiet;
    const profile = this.store.getProfile(slug)!;
    const runNo = t.runCount + 1;
    const newComments = this.store.listComments(slug, id).filter((c) => (c.author === "user" || c.from) && (!t.lastRunAt || c.at > t.lastRunAt));
    const outputDir = this.store.outputsDir(slug, id);
    // Start fresh session: a work run in a new session that picks up from the branch (until that session exists).
    const fresh = !!t.freshSession && !run.chat;
    let prompt = resume ?? this.withSetupNote(slug, t, profile, session, refine, localizeAttachments(run.chat?.raw
      ? run.chat.text
      : run.chat
      ? chatPrompt(t, run.chat.text, run.chat.mode, outputDir, !!profile.artifacts, session.repo, session.inPlace, refine && !session.existed ? this.recall(slug, t) : "")
      : fresh
      ? this.freshPrompt(slug, t, session, outputDir)
      : t.runCount === 0 || !session.existed
      ? firstRunPrompt(t, {
        repo: session.repo, inPlace: session.inPlace, home: { folder: profile.path, baseBranch: profile.baseBranch }, linked: !!t.workdir,
        // Notes other tickets' runs left reach even a ticket's first run: nobody else passes them on.
        comments: t.workdir || t.runCount > 0 ? newComments : newComments.filter((c) => c.from), outputDir,
        schedule: t.scheduleId ? { id: t.scheduleId, name: this.store.getSchedule(slug, t.scheduleId)?.name ?? null, board: slug } : undefined,
        autoHuddles: autoHuddlesOn(profile), artifacts: !!profile.artifacts, recall: this.recall(slug, t),
      })
      : resumePrompt(t, newComments, outputDir, autoHuddlesOn(profile), !!profile.artifacts, session.repo, session.inPlace, { folder: profile.path, baseBranch: profile.baseBranch }), this.store.attachmentsDir));
    // A slash command only runs when it is the whole message: Claude Code passes everything after the name to
    // it as arguments (the board's note too). So the command goes alone and the board's instructions go in
    // the system prompt for this run.
    let systemPrompt: string | undefined;
    if (run.chat?.slash && !resume) {
      const cut = prompt.indexOf("\n\n<ckanban-context");
      if (cut >= 0) {
        systemPrompt = `The user's message in this turn is a slash command sent from the kanban board's ticket chat. The board's instructions for this run:\n\n${prompt.slice(cut + 2)}`;
        prompt = prompt.slice(0, cut);
      }
    }

    let lastWrite = 0;
    let pendingActivity: string | null = null;
    const draft = new DraftTracker();
    run.draft = draft;
    // A reply cut off by a restart stays on screen until this run's reply replaces it.
    let showsInterrupted = !!t.interrupted;
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    const emitDraft = () => {
      draftTimer = null;
      this.bus.emit({ type: "draft", profile: slug, id, text: draft.text });
    };
    // The spending cap applies to the ticket's own work (not Planning chats or replies to other tickets).
    const cap = refine || quiet ? null : runCapFor(t, profile);
    if (!refine && !quiet && t.capNextUsd) this.patch(slug, id, { capNextUsd: null });
    // Marks where this run starts in the log and what it was (the Usage tab lists runs by kind).
    // A resumed attempt (retry, stall restart) continues the same run in the log.
    if (!resumeText) this.store.appendActivity(slug, id, runNo, { type: "ckanban_run", kind: refine ? "planning" : quiet ? "reply" : run.chat?.followUp ? "follow-up" : run.chat ? "chat" : "work" });
    run.handle = startRun({
      bin: this.opts.claudeBin,
      cwd: session.dir,
      args: buildArgs(session.sessionId, session.existed, t.model ?? profile.model, refine ? PLANNING_DISALLOWED_TOOLS : [], mcpConfig(), systemPrompt, cap, t.effort ?? profile.effort),
      input: prompt,
      inputLocal: run.chat?.slash === "local" && !resume,
      planning: refine,
      // CKANBAN_TICKET marks board runs: the ckanban MCP/CLI refuses board changes there (no runs starting runs).
      env: { CKANBAN_OUTPUT_DIR: outputDir, CKANBAN_TICKET: `${slug}/${id}` },
      onEvent: (ev) => {
        const changed = draft.feed(ev);
        if (changed !== null) {
          // Clears go out at once with the finished text (the batched tail may not have gone out yet);
          // growing text is batched (~8 updates/s).
          if (changed === "") {
            if (draftTimer) clearTimeout(draftTimer);
            draftTimer = null;
            this.bus.emit({ type: "draft", profile: slug, id, text: "", ...(draft.finished ? { final: draft.finished } : {}) });
          } else if (!draftTimer) draftTimer = setTimeout(emitDraft, DRAFT_THROTTLE_MS);
        }
        if (ev?.type === "stream_event") return;
        rememberInit(session.dir, ev, { projects: [profile.path] });
        if (refine && ev?.type === "assistant") this.saveMockups(slug, id, outputDir, ev);
        if (showsInterrupted && !this.shuttingDown && hasText(ev)) {
          showsInterrupted = false;
          this.patch(slug, id, { interrupted: null });
        }
        const read = replayText(ev);
        if (read !== null) this.delivered(run, read);
        this.store.appendActivity(slug, id, runNo, ev);
        this.bus.emit({ type: "activity", profile: slug, id, run: runNo, event: ev });
        const s = summarizeEvent(ev);
        // Keep "Stopping…" on the card until the process is gone.
        if (!s || run.stopRequested) return;
        pendingActivity = s;
        const now = Date.now();
        if (now - lastWrite >= ACTIVITY_THROTTLE_MS) {
          lastWrite = now;
          pendingActivity = null;
          this.patch(slug, id, { lastActivity: s });
        }
      },
      stallMs: this.stallMs(profile),
      onStall: (stalled) => {
        if (this.shuttingDown || !this.store.getTicket(slug, id)) return;
        if (!stalled) {
          if (this.store.getTicket(slug, id)?.stalled) this.patch(slug, id, { stalled: null });
          return;
        }
        if (run.stopRequested) return;
        const minutes = Math.max(1, Math.round(this.stallMs(profile) / 60_000));
        // The Notifier sees the new "stalled" attention and tells the user (webhook / macOS banner).
        this.patch(slug, id, { stalled: { at: nowIso(), minutes } });
      },
      onWaiting: (tasks) => {
        if (run.stopRequested || this.shuttingDown) return;
        const what = !tasks ? null : tasks.length === 1 ? `Waiting for background task: ${tasks[0].description}` : `Waiting for ${tasks.length} background tasks`;
        if (what) pendingActivity = null;
        this.patch(slug, id, { waitingOn: tasks, ...(what ? { lastActivity: what } : {}) });
      },
    });

    // A local command is never echoed back: it was read once it was written.
    if (run.chat?.slash === "local" && !resume && run.promptMsgId) {
      this.dropQueued(slug, id, [run.promptMsgId]);
      run.promptMsgId = undefined;
    }
    // Messages sent while the run was starting up, or left over from a run the daemon restarted.
    for (const msg of this.waiting(slug, id)) this.steer(run, msg);

    const out = await run.handle.done;
    if (draftTimer) clearTimeout(draftTimer);
    // A reply cut off before its message ended (Stop, a crash): the chat keeps it until it knows what was saved.
    if (draft.text) this.bus.emit({ type: "draft", profile: slug, id, text: "", final: draft.text });
    // Daemon is exiting: leave the ticket in_progress so recover() resumes it on next start.
    if (this.shuttingDown) return;
    const finalText = extractFinalText(out.events);
    // A steering message can get its own turn after the result line; the ticket outcome is still the last one given.
    const result = parseResult(finalText) ?? out.events
      .filter((e) => e?.type === "result" && typeof e.result === "string")
      .map((e) => parseResult(e.result))
      .findLast((r) => r !== null) ?? null;
    // Stopped before Claude got going: there is no session to resume, so the next run starts a new one.
    const started = session.existed || this.sessionExists(session.sessionId)
      || out.events.some((e) => (e?.type === "system" && e.subtype === "init") || e?.type === "assistant");
    const base: Partial<Ticket> = {
      ...this.endStatus(run),
      stalled: null,
      sessionStarted: started,
      ...(fresh && started ? { freshSession: false } : {}),
      ...(refine || quiet ? {} : { lastRunAt: startedAt, runCount: runNo }),
      lastActivity: pendingActivity ?? this.store.getTicket(slug, id)?.lastActivity ?? null,
    };

    // Restart on a stalled run: the stuck process is gone, now the same session picks the work up again.
    if (run.handle.stopped && run.restartRequested && !run.stopRequested) {
      run.restartRequested = false;
      this.store.addComment(slug, id, "ai", "Restarted the stalled run: it continues in the same session.");
      this.patch(slug, id, { sessionStarted: started, stalled: null, lastActivity: "Restarting…" });
      return this.executeOnce(run, healed, STALL_RESTART_TEXT);
    }
    if (run.handle.stopped) {
      this.store.addComment(slug, id, "ai", "Run stopped by user.");
      this.patch(slug, id, { ...base, outcome: "stopped", error: null, lastActivity: null, ...this.dropAutoWait(slug, id) });
      return;
    }
    if (cap !== null && out.events.some((e) => e?.type === "result" && e.subtype === "error_max_budget_usd")) {
      this.capReached(slug, id, base, cap);
      return;
    }
    // The account hit its usage limit: not a failure of the work, it continues once the limit resets.
    const limited = quiet || result ? null : limitMessage(out.events, out.code !== 0 ? out.stderr : "");
    if (limited) {
      this.limitHit(slug, id, base, limited);
      return;
    }
    if (out.code !== 0) {
      const error = out.stderr.trim() || finalText.trim() || `claude exited with code ${out.code}`;
      // Claude can't find the session (stopped before it was saved, cleaned up, or saved for another folder):
      // retry once in a new session instead of failing every run from now on.
      if (!healed && !this.store.getTicket(slug, id)?.workdir && sessionMissing(error, out.events)) {
        console.log(`ticket ${slug}/${id}: session ${session.sessionId} not found, starting a new one`);
        this.patch(slug, id, { sessionId: crypto.randomUUID(), sessionStarted: false, error: null });
        return this.executeOnce(run, true);
      }
      // A passing API problem (overloaded, a 5xx, a dropped connection): resume the same session once after a pause.
      const transient = run.retried || run.stopRequested ? null : transientError(out.events, out.stderr);
      if (transient) {
        run.retried = true;
        const delay = this.opts.retryDelayMs ?? RETRY_DELAY_MS;
        const line = transient.split("\n").findLast((l) => l.trim())?.trim().slice(0, 200) ?? transient;
        this.store.addComment(slug, id, "ai", `Run hit a temporary API error (${line}). Retrying once in ${Math.max(1, Math.round(delay / 1000))}s in the same session.`);
        this.patch(slug, id, { sessionStarted: started, error: null, lastActivity: "Temporary API error, retrying shortly…" });
        await Bun.sleep(delay);
        if (this.shuttingDown) return;
        if (run.stopRequested) {
          this.store.addComment(slug, id, "ai", "Run stopped by user.");
          this.patch(slug, id, { ...base, outcome: "stopped", error: null, lastActivity: null, ...this.dropAutoWait(slug, id) });
          return;
        }
        return this.executeOnce(run, healed, RETRY_TEXT);
      }
      // Claude reports a lost session only in its result event: keep it in the error so the UI offers Start fresh session.
      const shown = sessionMissing(error, out.events) && !sessionMissing(error, []) ? `No conversation found with session ID: ${session.sessionId}` : error;
      this.store.addComment(slug, id, "ai", `Run failed (exit ${out.code}): ${shown.split("\n").slice(-3).join("\n")}`);
      this.patch(slug, id, { ...base, outcome: "failed", error: shown });
      return;
    }
    if (refine || quiet) {
      this.patch(slug, id, { ...base, lastActivity: null, error: null });
      return;
    }
    const body = finalText.replace(/^.*CKANBAN_RESULT:.*$/gm, "").replace(MOVE_TO_PLANNING_RE, "").trim();
    // A Review/Done message that only asked for planning: show the ticket where it really is.
    if (run.chat?.mode === "act" && !run.targetStatus && result?.status !== "blocked" && MOVE_TO_PLANNING_RE.test(finalText)) {
      this.store.addComment(slug, id, "ai", result?.summary || body || "(no output)");
      this.patch(slug, id, {
        ...base, status: "planning",
        outcome: null, error: null, refineStarted: true, lastActivity: null,
        ...(run.chat.from && reopenable(run.chat.from.status) ? { reopenedFrom: run.chat.from } : {}),
      });
      return;
    }
    // A Review/Done message that only asked for new tickets: the card goes back where it was, outcome unchanged.
    // Not while the ticket hosts an open huddle: back in Done would close it, so the card goes to Review.
    const from = run.chat?.from;
    if (run.chat?.mode === "act" && !run.chat.raw && !run.targetStatus && from && from.status !== "in_progress" && result?.status !== "blocked" && STAY_RE.test(finalText) && !this.huddleOpen(slug, id)) {
      this.patch(slug, id, { ...base, status: from.status, outcome: from.outcome, error: null, lastActivity: null });
      return;
    }
    const current = this.store.getTicket(slug, id)!;
    // Questions must reach the user verbatim; otherwise the short summary is enough.
    const summary = (result?.status === "questions" ? body : result?.summary) || body || "(no output)";
    this.store.addComment(slug, id, "ai", summary);
    // Its auto huddle reviews the work (or it waits for the slot): the card stays In Progress until the huddle wakes it.
    const auto = current.autoHuddle;
    if (auto && !run.targetStatus && result?.status !== "blocked" && result?.status !== "questions") {
      this.patch(slug, id, {
        ...base, status: "in_progress", outcome: null, error: null, lastActivity: autoHuddleActivity(auto),
        prUrl: result?.prUrl ?? current.prUrl,
      });
      return;
    }
    // A follow-up on a Done or Backlog card that needs the user: Review, where the user sees it (those columns never ask).
    const asks = result?.status === "questions" || result?.status === "blocked";
    if (run.chat?.followUp && asks && (base.status === "done" || base.status === "backlog")) base.status = "review";
    this.patch(slug, id, {
      ...base,
      outcome: result?.status === "questions" ? "needs_input" : result?.status ?? "done",
      ...(result?.status === "questions" ? { interviewed: true } : {}),
      // A planner wake-up reports its children's PRs; the planner keeps its own.
      prUrl: run.chat?.raw && !run.chat.hostWake ? current.prUrl : result?.prUrl ?? current.prUrl,
      error: null,
    });
  }

  /** The watchdog time for this board's runs in ms (0: off). */
  private stallMs(profile: Profile): number {
    if (this.opts.stallMs !== undefined) return this.opts.stallMs;
    const m = profile.stallMinutes ?? DEFAULT_STALL_MINUTES;
    return m > 0 ? m * 60_000 : 0;
  }

  /**
   * The Inbox's answer to a stalled run. stop: as Stop. wait: clear the flag, the watchdog counts again. restart: stop the
   * stuck process and resume the same session.
   */
  stallAction(slug: string, id: string, action: "stop" | "wait" | "restart"): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const run = this.runs.get(this.key(slug, id));
    if (!run?.handle) {
      if (t.stalled) return this.patch(slug, id, { stalled: null });
      throw new Error("this ticket has no running run");
    }
    // A stale card (or a second click) must not stop or restart a run that is working again.
    if (!t.stalled || run.restartRequested) throw new Error("this run is not stalled anymore");
    if (action === "stop") {
      this.stopRun(run);
    } else if (action === "wait") {
      run.handle.keepWaiting();
      this.store.addComment(slug, id, "ai", "Kept waiting on the stalled run.");
      if (t.stalled) this.patch(slug, id, { stalled: null });
    } else {
      run.restartRequested = true;
      this.patch(slug, id, { lastActivity: "Restarting…" });
      run.handle.stop();
    }
    return this.store.getTicket(slug, id)!;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** A run stopped at its spending cap: blocked until the user continues it with more budget (continueAfterCap). */
  private capReached(slug: string, id: string, base: Partial<Ticket>, cap: number): void {
    const msg = `Stopped at $${cap.toFixed(2)} cap`;
    this.store.addComment(slug, id, "ai", `${msg}: this run spent its budget before it finished. Continue it with more budget, or change the ticket's cap in its ⋯ menu.`);
    this.patch(slug, id, { ...base, outcome: "blocked", error: msg, capHit: { capUsd: cap, at: nowIso() } });
  }

  /** "Continue with +$Y" after a run stopped at its cap: "continue" in the same session, with a cap of addUsd for that run. */
  async continueAfterCap(slug: string, id: string, addUsd: number): Promise<Ticket> {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    if (!(Number.isFinite(addUsd) && addUsd > 0)) throw new Error("addUsd must be a positive amount");
    if (this.isRunning(slug, id)) throw new Error("this ticket is already running");
    this.patch(slug, id, { capNextUsd: addUsd });
    try {
      return await this.chat(slug, id, CONTINUE_TEXT);
    } catch (e) {
      this.patch(slug, id, { capNextUsd: null });
      throw e;
    }
  }

  /** A run ended on the usage limit: wait for the reset, then continue on its own unless turned off or capped. */
  private limitHit(slug: string, id: string, base: Partial<Ticket>, message: string): void {
    const t = this.store.getTicket(slug, id)!;
    const now = this.now();
    const resetAt = parseReset(message, now);
    const used = t.autoContinued?.day === dayKey(now) ? t.autoContinued.count : 0;
    const capped = used >= AUTO_CONTINUE_PER_DAY;
    const auto = t.autoContinue !== false && !capped;
    const limit: LimitHit = { resetAt: resetAt.toISOString(), auto, at: now.toISOString(), message, ...(capped && t.autoContinue !== false ? { capped: true } : {}) };
    const when = clockTime(resetAt, now);
    const next = auto ? `It continues automatically at ${when}.`
      : limit.capped ? `It resets at ${when}; it already continued automatically ${AUTO_CONTINUE_PER_DAY} times today, so continue it yourself.`
      : `It resets at ${when}.`;
    this.store.addComment(slug, id, "ai", `Usage limit hit: ${message}\n${next}`);
    this.patch(slug, id, { ...base, outcome: "limit", error: message, limit });
  }

  /**
   * Continue a ticket that hit the usage limit: "continue" to the same session through the normal chat path (run
   * slots, restart hold). auto: the board's own continue at the reset; it counts toward the daily cap.
   */
  async continueAfterLimit(slug: string, id: string, opts: { auto?: boolean } = {}): Promise<Ticket> {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    if (opts.auto) {
      if (t.outcome !== "limit" || !t.limit?.auto || this.isRunning(slug, id)) return t;
      const day = dayKey(this.now());
      const count = (t.autoContinued?.day === day ? t.autoContinued.count : 0) + 1;
      this.patch(slug, id, { autoContinued: { day, count } });
      this.store.addComment(slug, id, "ai", "The usage limit has reset: sent \"continue\".");
    }
    return this.chat(slug, id, CONTINUE_TEXT);
  }

  /** "Don't auto-continue" / "Auto-continue": for the current wait and later limit hits of this ticket. */
  setAutoContinue(slug: string, id: string, auto: boolean): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const limit = t.limit ? { ...t.limit, auto, capped: undefined } : t.limit;
    const out = this.patch(slug, id, { autoContinue: auto, ...(limit ? { limit } : {}) });
    if (t.parentId) this.advancePlans(slug);
    return out;
  }

  /** Tickets waiting for a usage limit to reset whose automatic continue is due (see LimitWatcher). */
  dueContinues(slug: string, delayMs: number): string[] {
    const now = this.now().getTime();
    return this.store.listTickets(slug)
      .filter((t) => t.outcome === "limit" && t.limit?.auto && !this.isRunning(slug, t.id) && t.status !== "done"
        && new Date(t.limit.resetAt).getTime() + delayMs <= now)
      .map((t) => t.id);
  }

  // ---- Follow-ups (followup.ts): Claude comes back to this ticket later ----

  /** follow_up: when Claude (or the user) wants the ticket's conversation woken again; replaces the pending one. */
  setFollowUp(slug: string, id: string, input: { after?: string | null; at?: string | null; note?: string | null; cancelOnReply?: boolean }): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const note = input.note?.trim();
    if (!note) throw new FollowUpError("note is required: why you come back, and what to check then");
    if (note.length > FOLLOW_UP_NOTE_MAX) throw new FollowUpError(`note is too long (max ${FOLLOW_UP_NOTE_MAX} characters): keep it to why and what to check`);
    const now = this.now();
    const due = followUpTime(input, now);
    const followUp: FollowUp = { dueAt: due.toISOString(), note, cancelOnReply: input.cancelOnReply !== false, setAt: now.toISOString() };
    this.store.addComment(slug, id, "ai", `Follow-up set for ${formatAt(followUp.dueAt)}: ${note}`);
    return this.patch(slug, id, {
      followUp, followUpStopped: null,
      followUpLog: logFollowUp(t.followUpLog, { at: followUp.setAt, kind: "set", dueAt: followUp.dueAt, note }),
    });
  }

  /**
   * Stop following up. by "claude": cancel_follow_up, with the reason the card shows ("Stopped following up: …").
   * by "user": Stop following up on the card; it also clears a stopped note.
   */
  cancelFollowUp(slug: string, id: string, by: "user" | "claude", reason?: string | null): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const why = reason?.trim();
    if (by === "claude" && !why) throw new FollowUpError("reason is required: one line on why you stop following up");
    if (why && why.length > FOLLOW_UP_REASON_MAX) throw new FollowUpError(`reason is too long (max ${FOLLOW_UP_REASON_MAX} characters): one line`);
    if (by === "user" && !t.followUp) return t.followUpStopped ? this.patch(slug, id, { followUpStopped: null }) : t;
    const at = this.now().toISOString();
    this.store.addComment(slug, id, "ai", by === "user" ? "Follow-up stopped by user." : `Stopped following up: ${why}`);
    return this.patch(slug, id, {
      followUp: null, followUpStopped: by === "claude" ? { at, reason: why! } : null,
      followUpLog: logFollowUp(t.followUpLog, { at, kind: "cancelled", by, ...(why ? { note: why } : {}) }),
    });
  }

  /** The user wrote in the ticket chat: Claude hears about it on its next wake, and it cancels a cancel-on-reply follow-up. */
  userReplied(slug: string, id: string): void {
    const t = this.store.getTicket(slug, id);
    if (!t?.followUp) return;
    const at = this.now().toISOString();
    if (!t.followUp.cancelOnReply) {
      this.patch(slug, id, { followUpLog: logFollowUp(t.followUpLog, { at, kind: "replied" }) });
      return;
    }
    this.store.addComment(slug, id, "ai", "Follow-up cancelled: you replied.");
    this.patch(slug, id, { followUp: null, followUpLog: logFollowUp(logFollowUp(t.followUpLog, { at, kind: "replied" }), { at, kind: "cancelled", by: "reply" }) });
  }

  /** The user opened the ticket: the follow-up wake prompt tells Claude when (at most one write per 5 minutes). */
  markSeen(slug: string, id: string): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const now = this.now();
    if (t.seenAt && now.getTime() - new Date(t.seenAt).getTime() < 5 * 60_000) return t;
    return this.patch(slug, id, { seenAt: now.toISOString() });
  }

  /** Tickets whose follow-up is due and that are free to take it: not running, queued or waiting (FollowUpWatcher). */
  dueFollowUps(slug: string): string[] {
    const now = this.now().getTime();
    return this.store.listTickets(slug)
      .filter((t) => t.followUp && !t.followUp.missedAt && new Date(t.followUp.dueAt).getTime() <= now
        && !this.isRunning(slug, t.id) && t.status !== "in_progress" && !t.slotWait && !this.waiting(slug, t.id).length
        && !(t.outcome === "limit" && t.limit)
        && !t.error?.startsWith("corrupt"))
      .map((t) => t.id);
  }

  /**
   * Wake the ticket's conversation for its follow-up. A follow-up seen more than FOLLOW_UP_LATE_MS late waits for the
   * user instead (missedAt). manual: the user pressed Follow up now (any time, also when missed).
   */
  async wakeFollowUp(slug: string, id: string, opts: { manual?: boolean } = {}): Promise<Ticket> {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const f = t.followUp;
    if (!f) throw new FollowUpError("this ticket has no follow-up");
    if (this.isRunning(slug, id) || t.slotWait) {
      if (opts.manual) throw new ConflictError("Claude is working on this ticket; follow up once it has finished");
      return t;
    }
    const now = this.now();
    const late = now.getTime() - new Date(f.dueAt).getTime();
    if (!opts.manual && late > FOLLOW_UP_LATE_MS) {
      if (f.missedAt) return t;
      this.store.addComment(slug, id, "ai", `Missed follow-up: it was due ${formatAt(f.dueAt)}, while the computer was asleep or the board was off. Press Follow up now to let Claude check, or stop it.`);
      return this.patch(slug, id, { followUp: { ...f, missedAt: now.toISOString() }, followUpLog: logFollowUp(t.followUpLog, { at: now.toISOString(), kind: "missed", dueAt: f.dueAt }) });
    }
    const text = followUpWakePrompt(t, now, opts.manual);
    // Cleared before the run starts, so the next tick can't wake it twice; a follow_up call in the run sets the next one.
    this.patch(slug, id, { followUp: null, followUpLog: logFollowUp(t.followUpLog, { at: now.toISOString(), kind: "woke", dueAt: f.dueAt, note: f.note }) });
    try {
      return await this.chat(slug, id, text, { followUp: true });
    } catch (e) {
      const cur = this.store.getTicket(slug, id);
      if (cur && !cur.followUp) this.patch(slug, id, { followUp: f, followUpLog: t.followUpLog ?? [] });
      throw e;
    }
  }

  /** A follow-up run ended: its cost goes on its "woke" log entry (the menu and the next wake prompt show the total). */
  private followUpCost(slug: string, id: string): void {
    const t = this.store.getTicket(slug, id);
    if (!t?.followUpLog?.length) return;
    const run = ticketRuns(this.store.readActivity(slug, id)).findLast((r) => r.kind === "follow-up");
    const i = t.followUpLog.findLastIndex((e) => e.kind === "woke");
    if (!run || i < 0 || t.followUpLog[i].costUsd !== undefined) return;
    const log = t.followUpLog.map((e, j) => (j === i ? { ...e, run: run.run, costUsd: Math.round(run.costUsd * 10_000) / 10_000 } : e));
    // Claude set no next follow-up and didn't say it stopped (it forgot, the run failed or was stopped): the card says so.
    const said = t.followUp || (t.followUpStopped && t.followUpStopped.at >= t.followUpLog[i].at);
    this.patch(slug, id, { followUpLog: log, ...(said ? {} : { followUpStopped: { at: this.now().toISOString(), reason: "no next follow-up was set" } }) });
  }

  /** Planning replies carry mockups as blocks (they can't write files); save them for the Outputs tab. */
  private saveMockups(slug: string, id: string, outputDir: string, ev: any) {
    const content = ev.message?.content;
    if (!Array.isArray(content)) return;
    const text = content.map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
    try {
      const names = saveMockups(outputDir, text);
      if (names.length) this.patch(slug, id, { lastActivity: `Saved mockup${names.length > 1 ? "s" : ""} ${names.join(", ")}` });
    } catch (e) {
      this.store.addComment(slug, id, "ai", `Couldn't save mockups: ${(e as Error).message}`);
    }
  }

  private sessionLocks = new Map<string, Promise<unknown>>();

  /** Each board folder's version history as last seen, by folder path (see repoState); re-checked after REPO_TTL_MS. */
  private repos = new Map<string, { kind: RepoKind; at: number }>();
  private repoChecks = new Set<string>();

  /**
   * The board folder's version history, from the cache (undefined until first checked). A stale or missing entry is
   * re-checked in the background; a change re-runs dispatch, so tickets held back by an unknown state start then.
   */
  repoState(slug: string): RepoKind | undefined {
    const c = this.repos.get(this.store.getProfile(slug)?.path ?? "");
    if (!c || Date.now() - c.at > REPO_TTL_MS) void this.checkRepo(slug);
    return c?.kind;
  }

  /** Before the first check (just after a restart): guessed from the folder's .git (config names an origin or not). */
  private guessRepo(slug: string): RepoKind {
    const path = this.store.getProfile(slug)?.path;
    if (!path || !existsSync(join(path, ".git"))) return "plain";
    try {
      return readFileSync(join(path, ".git", "config"), "utf8").includes('[remote "origin"]') ? "remote" : "local";
    } catch {
      return "remote";
    }
  }

  /** The board folder has commits (so huddle reviewers get snapshots of committed code); true until known. */
  committed(slug: string): boolean {
    const k = this.repoState(slug);
    return k === undefined || k === "local" || k === "remote";
  }

  private async checkRepo(slug: string): Promise<void> {
    const profile = this.store.getProfile(slug);
    if (!profile || this.repoChecks.has(profile.path)) return;
    this.repoChecks.add(profile.path);
    try {
      this.noteRepo(slug, await repoKind(profile.path));
    } finally {
      this.repoChecks.delete(profile.path);
    }
  }

  /** Records what the folder is now (e.g. version history was just turned on); a change re-runs dispatch. */
  noteRepo(slug: string, kind: RepoKind): void {
    const path = this.store.getProfile(slug)?.path;
    if (!path) return;
    const prev = this.repos.get(path)?.kind;
    this.repos.set(path, { kind, at: Date.now() });
    if (prev !== kind && !this.shuttingDown) this.dispatch(slug);
  }

  /**
   * The ticket's runs edit the board's folder itself rather than a copy of their own: a plain folder or a repo with
   * no commits (no worktree can be made), or a ticket that already ran there. Null: not known yet (the folder's
   * version history is still being checked). Linked sessions (workdir) are the user's own and don't count.
   * Such tickets run one at a time per board (see folderBusy), as do new tickets on a board set to work in the folder.
   */
  runsInFolder(slug: string, t: Ticket): boolean | null {
    if (t.workdir || t.worktree || t.branch) return false;
    if (t.sessionStarted || t.runCount > 0) return true;
    if (workspaceOf(this.store.getProfile(slug)) === "folder") return true;
    const kind = this.repoState(slug);
    return kind === undefined ? null : kind === "plain" || kind === "empty";
  }

  /**
   * Another ticket on the board is editing the folder `t` would edit in place: its run (not a read-only Planning
   * chat) is going, or its auto huddle reviews the work there. An unknown side counts as in place, so nothing starts
   * on a guess; the version-history check re-runs dispatch.
   */
  folderBusy(slug: string, t: Ticket): boolean {
    if (this.runsInFolder(slug, t) === false) return false;
    for (const r of this.runs.values()) {
      if (r.slug !== slug || r.id === t.id || r.chat?.mode === "refine") continue;
      const o = this.store.getTicket(slug, r.id);
      if (o && this.runsInFolder(slug, o) !== false) return true;
    }
    // Only boards whose tickets edit the folder get here, so listing them stays rare.
    return this.store.listTickets(slug).some((o) => o.id !== t.id && !!o.autoHuddle && !this.isRunning(slug, o.id) && this.runsInFolder(slug, o) !== false);
  }

  /** For the card: it would start now (Ready, a reply waiting for a slot, a running plan's next child) but the folder is in use. */
  folderWait(slug: string, t: Ticket): boolean {
    if (this.isRunning(slug, t.id)) return false;
    const parent = t.parentId ? this.store.getTicket(slug, t.parentId) : null;
    const next = t.status === "ready" || !!t.slotWait || (t.status === "backlog" && planActive(parent?.plan));
    return next && this.folderBusy(slug, t);
  }

  /** Serialized per ticket: a run and a "copy command" click must not both create the worktree. */
  ensureSession(slug: string, id: string): Promise<Session> {
    const key = this.key(slug, id);
    const prev = this.sessionLocks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.ensureSessionNow(slug, id));
    this.sessionLocks.set(key, next);
    next.finally(() => {
      if (this.sessionLocks.get(key) === next) this.sessionLocks.delete(key);
    }).catch(() => {});
    return next;
  }

  private async ensureSessionNow(slug: string, id: string): Promise<Session> {
    const profile = this.store.getProfile(slug);
    if (!profile) throw new Error(`board ${slug} not found`);
    if (!existsSync(profile.path)) throw new Error(`board folder does not exist: ${profile.path}`);
    let t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const repo = await repoKind(profile.path);
    this.noteRepo(slug, repo);
    const isGit = repo !== "plain";
    const patch: Partial<Ticket> = {};
    if (t.workdir && !existsSync(t.workdir)) throw new Error(`linked session folder no longer exists: ${t.workdir}`);
    // A ticket that already ran in the folder itself stays there: its Claude session belongs to that folder.
    // One with a branch had a worktree (removed on Done): it gets it back at the same path, so its session resumes.
    const ranInPlace = !t.worktree && !t.branch && (!!t.sessionStarted || t.runCount > 0);
    // Board set to "Work in the project folder": new tickets run there; one that already has a worktree keeps it.
    const folderMode = workspaceOf(profile) === "folder" && !t.worktree && !t.branch;
    if (isGit && !t.workdir && !ranInPlace && !folderMode && (!t.worktree || !existsSync(t.worktree))) {
      const dir = worktreeDir(profile, id);
      let branch = t.branch ?? `ck/${id}-${slugify(t.title)}`;
      if (t.branch && !existsSync(dir) && !(await branchExists(profile.path, t.branch))) {
        // Claude may have renamed the branch in its worktree: take the ticket's newest one, else start over from base.
        const renamed = (await branchesWithPrefix(profile.path, `ck/${id}-`))[0];
        if (renamed) branch = renamed;
        else patch.notice = `Branch "${t.branch}" was not found, so this ticket's worktree starts again from the base branch.`;
      }
      const base = existsSync(dir) ? profile.baseBranch : await resolveBaseBranch(profile.path, profile.baseBranch);
      if (base === null) {
        // Fresh `git init` with no commits: nothing to branch from, so run in the folder rather than fail.
        patch.notice = "This repo has no commits yet, so Claude works directly in your folder instead of an isolated worktree. Make a first commit to give new tickets their own worktree.";
      } else {
        if (base !== profile.baseBranch) {
          console.log(`profile ${slug}: base branch "${profile.baseBranch}" not found, using "${base}"`);
          const fixed = { ...profile, baseBranch: base };
          this.store.saveProfile(fixed);
          this.bus.emit({ type: "profile.updated", slug, profile: fixed });
          if (profile.baseBranch) patch.notice = `Base branch "${profile.baseBranch}" was not found in this repo, so the board now uses "${base}".`;
        }
        const fresh = !existsSync(dir);
        if (fresh) {
          // A new branch starts from the remote's latest base (other tickets push there); an existing one keeps its history.
          // An add-on to a ticket still in Review builds on that ticket's branch, while it exists.
          const from = t.startFrom && (await branchExists(profile.path, t.startFrom)) ? t.startFrom
            : repo === "remote" && !(await branchExists(profile.path, branch)) ? await latestBase(profile.path, base) : base;
          await addWorktree(profile.path, dir, branch, from);
          // Only the cheap part now; the setup command runs when Claude asks for it (runSetup).
          this.copyWorktreeFiles(slug, id, profile, dir);
          patch.setupPending = true;
        }
        if (t.startFrom) patch.startFrom = null;
        patch.worktree = dir;
        patch.branch = branch;
      }
    }
    // In place on a repo with commits: the folder's HEAD at the first run is what the Changes tab diffs against.
    if (!t.workdir && !t.worktree && !patch.worktree && !t.baseSha && (repo === "local" || repo === "remote")) {
      const head = await runCmd(["git", "rev-parse", "HEAD"], profile.path);
      if (head.code === 0 && head.stdout.trim()) patch.baseSha = head.stdout.trim();
    }
    if (!t.sessionId) patch.sessionId = crypto.randomUUID();
    if (Object.keys(patch).length) t = this.patch(slug, id, patch);
    const sessionId = t.sessionId!;
    return {
      dir: t.workdir ?? t.worktree ?? profile.path,
      sessionId,
      // Only a saved session can be resumed (a run stopped in its first second leaves none); a linked one is the user's.
      existed: (!!t.workdir && !t.freshSession) || this.sessionExists(sessionId),
      isGit,
      repo,
      inPlace: !t.workdir && !t.worktree,
    };
  }

  /** Work runs in a worktree whose setup command hasn't run yet learn how to run it; planning chats never do. */
  private withSetupNote(slug: string, t: Ticket, profile: Profile, session: Session, refine: boolean, prompt: string): string {
    if (refine || !t.setupPending || !t.worktree || session.dir !== t.worktree || !profile.setupCommand?.trim()) return prompt;
    return withBoardText(prompt, setupNote(slug, t.id), "Setup");
  }

  /** Copies the board's git-ignored files (.env) into a new worktree. Quiet: missing ones are only logged. */
  private copyWorktreeFiles(slug: string, id: string, profile: Profile, dir: string): void {
    if (!profile.copyFiles?.length) return;
    try {
      const { missing } = copySetupFiles(profile.path, dir, profile.copyFiles);
      if (missing.length) console.log(`ticket ${slug}/${id}: files to copy not found: ${missing.join(", ")}`);
    } catch (e) {
      console.error(`ticket ${slug}/${id}: copying files into the worktree failed: ${(e as Error).message}`);
    }
  }

  /**
   * Runs the board's setup command in the ticket's worktree, when its Claude asks (`ckanban ticket setup`). Calls while
   * one runs share it; after a success it isn't run again for this worktree. Never throws for a failed command: the
   * result carries its output, and Claude decides what to do.
   */
  runSetup(slug: string, id: string): Promise<SetupOutcome> {
    const profile = this.store.getProfile(slug);
    const t = this.store.getTicket(slug, id);
    if (!profile || !t) return Promise.reject(new Error(`ticket ${id} not found`));
    const key = this.key(slug, id);
    const running = this.setups.get(key);
    if (running) return running.done;
    const command = profile.setupCommand?.trim() ?? "";
    if (!t.worktree || !existsSync(t.worktree)) return Promise.resolve({ status: "no-worktree" });
    if (!command) return Promise.resolve({ status: "no-command" });
    if (!t.setupPending) return Promise.resolve({ status: "already-done" });
    const dir = t.worktree;
    const abort = new AbortController();
    const done = (async (): Promise<SetupOutcome> => {
      this.patch(slug, id, { lastActivity: INSTALLING });
      let r: SetupResult | null = null;
      try {
        r = (await prepareWorktree(profile.path, dir, { setupCommand: command }, {
          signal: abort.signal, timeoutMs: SETUP_TIMEOUT_MS, env: { CKANBAN_TICKET: `${slug}/${id}` },
        }))!;
      } finally {
        // The worktree may have been removed or replaced meanwhile: only mark the one it ran in.
        const now = this.store.getTicket(slug, id);
        if (now) {
          this.patch(slug, id, {
            ...(r?.ok && now.worktree === dir ? { setupPending: false } : {}),
            ...(now.lastActivity === INSTALLING ? { lastActivity: null } : {}),
          });
        }
      }
      if (!r.ok) console.log(`ticket ${slug}/${id}: setup failed (${r.command}): ${r.output.split("\n").slice(-3).join(" | ")}`);
      return { status: "ran", result: r };
    })();
    this.setups.set(key, { done, abort });
    done.finally(() => {
      if (this.setups.get(key)?.done === done) this.setups.delete(key);
    }).catch(() => {});
    return done;
  }

  /** Removes a ticket's worktree, running the board's cleanup command in it first (its failure never blocks). */
  private removeTicketWorktree(profile: Profile, dir: string): ReturnType<typeof removeWorktree> {
    const cleanup = profile.cleanupCommand?.trim();
    return removeWorktree(profile.path, dir, cleanup ? async () => {
      const r = await runShell(dir, cleanup, { timeoutMs: CLEANUP_TIMEOUT_MS });
      if (!r.ok) console.error(`worktree cleanup failed in ${dir} (${cleanup}): ${r.output.split("\n").slice(-5).join(" | ")}`);
    } : undefined);
  }

  async planningCommand(slug: string, id: string): Promise<string> {
    const s = await this.ensureSession(slug, id);
    const t = this.store.getTicket(slug, id)!;
    return planningCommand(s.dir, s.sessionId, localizeAttachments(planningPrompt(t, this.store.ticketPath(slug, id)), this.store.attachmentsDir), s.existed);
  }

  async createTicket(
    slug: string,
    input: {
      title: string; body: string; status: Status; mode?: TicketMode; scheduleId?: string; jobId?: string; source?: TicketSource; parentId?: string; planKey?: string; dependsOn?: string[];
      needs?: string[]; tags?: string[]; important?: boolean;
    },
  ): Promise<Ticket> {
    const status = input.status === "in_progress" ? "ready" : input.status;
    const star = starredTitle(input.title);
    const t = this.store.createTicket(slug, {
      ...input, status, needs: normalizeNeeds(input.needs), tags: normalizeTags(input.tags),
      ...(star.important && star.title.trim() ? { title: star.title, important: true } : {}),
    });
    this.emitTicket(slug, t);
    // The planner's "Review proposal" badge depends on which of its proposed tickets exist.
    const parent = input.parentId ? this.store.getTicket(slug, input.parentId) : null;
    if (parent) this.emitTicket(slug, parent);
    if (status === "ready") this.dispatch(slug);
    if (status === "planning") this.autoRefine(slug, t.id);
    if (parent) this.advancePlans(slug);
    return this.store.getTicket(slug, t.id)!;
  }

  async updateTicket(
    slug: string,
    id: string,
    patch: Partial<Pick<Ticket, "title" | "body" | "status" | "order" | "mode" | "notice" | "dependsOn" | "needs" | "tags" | "suggestedTags" | "important" | "runCapUsd" | "model" | "effort">> & {
      expectedBody?: string;
      /** null: take the ticket out of its plan (only clearing is allowed here; adoptTickets sets it). */
      parentId?: null;
    },
  ): Promise<Ticket> {
    let current = this.store.getTicket(slug, id);
    if (!current) throw new Error(`ticket ${id} not found`);
    if (patch.body !== undefined && patch.expectedBody !== undefined && patch.expectedBody !== current.body) {
      throw new ConflictError("description changed since you started editing (Claude may have updated it); reload and retry");
    }
    const clean: Partial<Ticket> = {};
    if (patch.title !== undefined) {
      const star = starredTitle(patch.title);
      clean.title = star.important && star.title.trim() ? star.title : patch.title;
      if (clean.title !== patch.title) clean.important = true;
    }
    if (patch.body !== undefined) clean.body = patch.body;
    if (patch.order !== undefined) clean.order = patch.order;
    if (patch.mode !== undefined) clean.mode = patch.mode;
    if (patch.notice !== undefined) clean.notice = patch.notice;
    if (patch.runCapUsd !== undefined) clean.runCapUsd = patch.runCapUsd;
    if (patch.model !== undefined) clean.model = patch.model;
    if (patch.effort !== undefined) clean.effort = patch.effort;
    if (patch.needs !== undefined) clean.needs = normalizeNeeds(patch.needs);
    if (patch.tags !== undefined) clean.tags = normalizeTags(patch.tags);
    if (patch.suggestedTags !== undefined || patch.tags !== undefined) {
      // A suggestion that is now a tag is no longer a suggestion.
      const tags = clean.tags ?? current.tags ?? [];
      clean.suggestedTags = normalizeTags(patch.suggestedTags ?? current.suggestedTags).filter((s) => !tags.includes(s));
    }
    if (patch.important !== undefined) clean.important = !!patch.important;
    if (patch.parentId === null && current.parentId) {
      const plannerId = current.parentId;
      const me = current;
      const users = childrenOf(this.store.listTickets(slug), plannerId).filter((s) => s.id !== id && resolveDeps(s, [s, me]).deps.length);
      if (users.length) {
        throw new Error(`${users.map((u) => `"${u.title}"`).join(", ")} ${users.length === 1 ? "depends" : "depend"} on this ticket; change their dependsOn first`);
      }
      // Its dependencies and key named siblings of the plan it leaves.
      Object.assign(clean, { parentId: null, planKey: null, dependsOn: [] });
    }
    if (patch.dependsOn !== undefined && clean.parentId !== null) {
      clean.dependsOn = patch.dependsOn;
      if (current.parentId) {
        const siblings = childrenOf(this.store.listTickets(slug), current.parentId).map((s) => (s.id === id ? { ...s, dependsOn: patch.dependsOn } : s));
        const me = siblings.find((s) => s.id === id)!;
        const { missing } = resolveDeps(me, siblings);
        if (missing.length) throw new Error(`unknown dependency ${missing.map((m) => `"${m}"`).join(", ")}: use a sibling's ticket id or key`);
        const cycle = findCycle(siblings);
        if (cycle) throw new Error(`dependency cycle: ${cycle.join(" → ")}`);
      }
    }
    let status = patch.status;
    // A reply waiting for a slot stays put when reordered; moved elsewhere, it stops waiting.
    if (current.slotWait && status === "in_progress") status = undefined;
    if (status === "in_progress" && !this.isRunning(slug, id)) status = "ready";
    if (current.slotWait && status) current = this.cancelSlotWait(slug, id);

    const active = this.runs.get(this.key(slug, id));
    if (active && status && status !== "in_progress") {
      active.targetStatus = status;
      this.stopRun(active);
      await active.promise;
      current = this.store.getTicket(slug, id)!;
    }
    // The store places the ticket in its new column unless the patch carries a drop position.
    if (status && status !== current.status) clean.status = status;
    // Moved by hand: the user takes it from here, no automatic continue, and the card no longer waits for an auto huddle.
    if (clean.status && current.limit) clean.limit = null;
    if (clean.status && current.autoHuddle) clean.autoHuddle = null;
    if (clean.status && current.snooze) clean.snooze = null;
    // Back to Planning/Backlog from Review/Done: remember where it was, so an add-on can put it back there.
    const shaping = clean.status === "planning" || clean.status === "backlog";
    if (shaping && reopenable(current.status)) clean.reopenedFrom = { status: current.status, outcome: current.outcome };
    else if (clean.status && !shaping && current.reopenedFrom) clean.reopenedFrom = null;
    let t = this.patch(slug, id, clean);

    if (clean.status === "done") t = await this.cleanupWorktree(slug, t);
    if (clean.status === "planning") this.autoRefine(slug, id);
    if (active || clean.status === "ready" || (clean.order !== undefined && t.status === "ready")) this.dispatch(slug);
    this.advancePlans(slug);
    return this.store.getTicket(slug, id)!;
  }

  // ---- Plans: a planner ticket runs its children unattended (see plan.ts) ----

  /** Start (or resume) the planner's plan: children switch to auto mode and start in dependency order. */
  startPlan(slug: string, id: string, opts: { maxConcurrent?: number; byPlanner?: boolean } = {}): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const kids = childrenOf(this.store.listTickets(slug), id);
    const problem = planProblem(kids);
    if (problem) throw new Error(`can't start the plan: ${problem}`);
    const prev = t.plan;
    const resuming = prev && prev.state !== "done";
    const plan: Plan = resuming
      ? {
        ...prev,
        state: prev.awaiting === "final" || prev.state === "finishing" ? "finishing" : "running",
        reason: null,
        // A stuck plan starts fresh: its last wake-up is over and the planner looks at every open child again.
        ...(prev.state === "stuck" ? { wakeups: 0, awaiting: null, seen: {} } : {}),
      }
      : { state: "running", maxConcurrent: DEFAULT_MAX_CONCURRENT, wakeups: 0, startedAt: nowIso(), originalCount: kids.length, inbox: [], seen: {}, retries: {}, awaiting: null };
    if (opts.maxConcurrent !== undefined) plan.maxConcurrent = clampConcurrency(opts.maxConcurrent);
    // Unattended: children must not stop to interview the user.
    for (const k of kids) if (k.status === "backlog" && k.mode !== "auto") this.patch(slug, k.id, { mode: "auto" });
    const out = this.patch(slug, id, { plan, ...(t.outcome && t.outcome !== "done" ? { outcome: null } : {}) });
    const by = opts.byPlanner ? " by the planner" : "";
    this.store.addComment(slug, id, "ai", resuming ? `Plan resumed${by}.` : `Plan started${by}: ${kids.length} child tickets, ${plan.maxConcurrent} at a time.`);
    this.advancePlans(slug);
    return this.store.getTicket(slug, id) ?? out;
  }

  /** Pause: no new children start and the planner isn't woken; running children finish. */
  pausePlan(slug: string, id: string): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t?.plan) throw new Error("this ticket has no plan");
    if (t.plan.state === "done") return t;
    this.store.addComment(slug, id, "ai", "Plan paused.");
    return this.patch(slug, id, { plan: { ...t.plan, state: "paused" } });
  }

  /** Mark the plan done as it stands, without waking the planner (e.g. a stuck plan the user resolved by hand). */
  markPlanDone(slug: string, id: string): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t?.plan) throw new Error("this ticket has no plan");
    if (t.plan.state === "done") return t;
    return this.closePlan(slug, t, t.plan, "Plan marked done.");
  }

  setPlanConcurrency(slug: string, id: string, n: number): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t?.plan) throw new Error("this ticket has no plan");
    const out = this.patch(slug, id, { plan: { ...t.plan, maxConcurrent: clampConcurrency(n) } });
    this.advancePlans(slug);
    return out;
  }

  /**
   * The ticket's current run works unattended on its own ticket (a Ready / In Progress run, a plan child, a schedule
   * run, or its auto huddle waking it), not a Planning chat, a reply to the user's message or to another ticket.
   */
  unattendedRun(slug: string, id: string): boolean {
    const r = this.runs.get(this.key(slug, id));
    if (!r || r.stopRequested) return false;
    if (!r.chat) return true;
    return !!r.chat.hostWake;
  }

  /** start_huddle in this run: false when the run already started an auto huddle (one per run). */
  claimAutoHuddle(slug: string, id: string): boolean {
    const r = this.runs.get(this.key(slug, id));
    if (!r || r.autoHuddleStarted) return false;
    r.autoHuddleStarted = true;
    return true;
  }

  /** Set or clear the ticket's auto huddle state (Huddles drives it). */
  setAutoHuddle(slug: string, id: string, autoHuddle: Ticket["autoHuddle"], extra: Partial<Ticket> = {}): Ticket | null {
    if (!this.store.getTicket(slug, id)) return null;
    return this.patch(slug, id, { autoHuddle, ...extra });
  }

  /** A stopped ticket no longer waits for an auto-huddle slot (a live auto huddle carries on; the user closes it). */
  private dropAutoWait(slug: string, id: string): Partial<Ticket> {
    return this.store.getTicket(slug, id)?.autoHuddle?.state === "waiting" ? { autoHuddle: null } : {};
  }

  /** The ticket's current run answers a message the user typed in its chat (see ActiveRun.chat.user). */
  userChatRun(slug: string, id: string): boolean {
    return !!this.runs.get(this.key(slug, id))?.chat?.user;
  }

  /**
   * The ticket's own chat, answering the user's own words (userAskedRun), asks to move its card: the board moves it
   * once the run ends, so the reply isn't cut off. False when the run doesn't answer the user.
   */
  requestSelfMove(slug: string, id: string, status: SelfMove): boolean {
    const run = this.runs.get(this.key(slug, id));
    if (!run || !this.userAskedRun(slug, id)) return false;
    run.selfMove = status;
    return true;
  }

  /**
   * The ticket's current run acts on the user's own words: it answers a message the user typed in its chat (not a
   * slash command), or the user typed one that was handed to it while it worked. Peer messages, planner messages,
   * huddle wakes and follow-ups don't count. start_huddle with trigger "user" needs this.
   */
  userAskedRun(slug: string, id: string): boolean {
    const r = this.runs.get(this.key(slug, id));
    if (!r || r.stopRequested) return false;
    return (!!r.chat?.user && !r.chat.slash) || !!r.userSteered;
  }

  /**
   * The planner ticket a run belongs to, if that run may manage the ticket's own children: any run of a running
   * plan (wake-ups), or a reply to the user's chat message in any plan state, so the user can still tidy up a finished
   * plan's children (e.g. mark them done). Restarting a done plan stays refused (see plan_control in http.ts).
   */
  plannerRights(slug: string, runTicketId: string): Ticket | null {
    const t = this.store.getTicket(slug, runTicketId);
    if (!t) return null;
    if (planActive(t.plan)) return t;
    return this.userChatRun(slug, runTicketId) ? t : null;
  }

  /**
   * The ticket whose Planning chat (refine mode) is answering a message the user typed: that reply may manage
   * other tickets on the board for the user (see plannerFor in http.ts). Plan wake-ups and peer replies don't count.
   */
  userRequestRights(slug: string, runTicketId: string): Ticket | null {
    const chat = this.runs.get(this.key(slug, runTicketId))?.chat;
    return chat?.mode === "refine" && chat.user ? this.store.getTicket(slug, runTicketId) ?? null : null;
  }

  /**
   * The ticket whose run may change other tickets on its board on its own (see runRights in http.ts): a work run or a
   * chat reply that acts on the ticket. Planning chats keep needing the user's message (userRequestRights), and a quiet
   * reply to another session (a peer run) gets nothing, so asking a ticket a question can't hand it a chain of runs.
   */
  runnerRights(slug: string, runTicketId: string): Ticket | null {
    const r = this.runs.get(this.key(slug, runTicketId));
    if (!r || r.stopRequested || r.chat?.mode === "refine" || r.chat?.quiet) return null;
    return this.store.getTicket(slug, runTicketId) ?? null;
  }

  /**
   * A run starts another ticket's run: refused past MAX_RUN_CHAIN or MAX_RUN_STARTS, otherwise counted. Returns what
   * goes in the started ticket's startedBy.
   */
  runStart(slug: string, runTicketId: string): NonNullable<Ticket["startedBy"]> {
    const by = this.store.getTicket(slug, runTicketId)?.startedBy;
    const depth = (by?.depth ?? 0) + 1;
    if (depth > MAX_RUN_CHAIN) {
      throw new Error(`this run was started by another ticket's run (${by!.ticketId}), and a chain of runs started by runs stops at ${MAX_RUN_CHAIN}: ` +
        "it can't start more runs. Ask the user to start it on the board");
    }
    const r = this.runs.get(this.key(slug, runTicketId));
    if (r) {
      if ((r.runStarts ?? 0) >= MAX_RUN_STARTS) {
        throw new Error(`this run already started ${MAX_RUN_STARTS} other tickets' runs, the most one run may start. Ask the user to start it on the board`);
      }
      r.runStarts = (r.runStarts ?? 0) + 1;
    }
    return { ticketId: runTicketId, depth };
  }

  /** Who started the ticket's latest run: another ticket's run (runStart), or null when the user started it. */
  markStartedBy(slug: string, id: string, by: Ticket["startedBy"]): void {
    const t = this.store.getTicket(slug, id);
    if (!t || (!t.startedBy && !by)) return;
    this.patch(slug, id, { startedBy: by ?? null });
  }

  /**
   * Manager mode: make existing tickets children of this one, so its plan runs them. Tickets on another board, the
   * ticket itself or its ancestors (a cycle), tickets in another plan and finished ones are skipped with a reason.
   */
  adoptTickets(slug: string, plannerId: string, ids: string[]): { adopted: Ticket[]; skipped: { id: string; reason: string }[] } {
    const planner = this.store.getTicket(slug, plannerId);
    if (!planner) throw new Error(`ticket ${plannerId} not found`);
    const ancestors = new Set<string>();
    for (let p = planner.parentId; p && !ancestors.has(p); p = this.store.getTicket(slug, p)?.parentId) ancestors.add(p);
    const adopted: Ticket[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of [...new Set(ids.map((x) => x.trim()).filter(Boolean))]) {
      const t = this.store.getTicket(slug, id);
      const reason = !t ? `not found on board ${slug}`
        : t.id === plannerId ? "that is this ticket itself"
        : ancestors.has(t.id) ? "it is a parent of this ticket (that would make a cycle)"
        : t.parentId === plannerId ? "already in this plan"
        : t.parentId ? `belongs to plan ${t.parentId}`
        : t.status === "done" ? "already done"
        : t.error?.startsWith("corrupt") ? "its ticket file is corrupt"
        : null;
      if (reason) {
        skipped.push({ id, reason });
        continue;
      }
      adopted.push(this.patch(slug, id, { parentId: plannerId }));
      this.store.addComment(slug, id, "ai", `Adopted by plan ${plannerId} ("${planner.title}").`);
    }
    if (adopted.length) {
      this.store.addComment(slug, plannerId, "ai", `Adopted ${adopted.length} ticket${adopted.length === 1 ? "" : "s"}: ${adopted.map((t) => `${t.id} "${t.title}"`).join(", ")}.`);
      const p = this.store.getTicket(slug, plannerId)!;
      // A plan under way grows with its new children: its create cap and wake-up budget count them.
      if (p.plan && p.plan.state !== "done") this.patch(slug, plannerId, { plan: { ...p.plan, originalCount: p.plan.originalCount + adopted.length } });
      else this.emitTicket(slug, p);
      this.advancePlans(slug);
    }
    return { adopted, skipped };
  }

  /** The planner restarts a child that already ran: counted, and refused past MAX_RETRIES. */
  countRetry(slug: string, plannerId: string, childId: string, max: number): void {
    const p = this.store.getTicket(slug, plannerId);
    if (!p?.plan) return;
    const n = (p.plan.retries?.[childId] ?? 0) + 1;
    if (n > max) throw new Error(`retry limit reached: ${childId} was already restarted ${max} times; skip or split it, or end with "blocked" for the user`);
    this.patch(slug, plannerId, { plan: { ...p.plan, retries: { ...p.plan.retries, [childId]: n } } });
  }

  private advancing = new Set<string>();
  /** When a planner with waiting events gets woken, per planner: children that fail together arrive as one message. */
  private wakeDue = new Map<string, number>();
  private advanceAgain = new Set<string>();

  /** Move every running plan on the board forward. Cheap and idempotent: call it after any change. */
  advancePlans(slug: string): void {
    if (this.shuttingDown || this.restartPending) return;
    if (this.advancing.has(slug)) {
      this.advanceAgain.add(slug);
      return;
    }
    this.advancing.add(slug);
    try {
      do {
        this.advanceAgain.delete(slug);
        const all = this.store.listTickets(slug);
        let started = false;
        for (const p of all) {
          if (!p.plan || p.plan.state === "done" || p.plan.state === "paused") continue;
          try {
            started = this.advancePlan(slug, p, childrenOf(all, p.id)) || started;
          } catch (e) {
            console.error(`plan ${slug}/${p.id}:`, e);
          }
        }
        if (started) this.dispatch(slug);
      } while (this.advanceAgain.has(slug));
    } finally {
      this.advancing.delete(slug);
    }
  }

  /** One plan; true when it moved children to Ready. */
  private advancePlan(slug: string, planner: Ticket, kids: Ticket[]): boolean {
    let plan = { ...planner.plan! };
    const plannerBusy = this.isRunning(slug, planner.id);
    // The planner's last wake-up has finished: its outcome decides whether we go on.
    if (plan.awaiting && !plannerBusy) {
      const o = planner.outcome;
      // Waiting for a usage limit to reset: the planner's automatic continue picks the wake-up up again.
      if (o === "limit" && planner.limit?.auto) return false;
      if (o === "limit") {
        this.stuck(slug, planner, plan, "the planner's run hit the usage limit");
        return false;
      }
      if (o === "blocked" || o === "needs_input" || o === "failed" || o === "stopped") {
        this.stuck(slug, planner, plan, o === "needs_input" ? "the planner has questions for you" : `the planner's run ${o === "blocked" ? "is blocked" : o}`);
        return false;
      }
      if (plan.awaiting === "final") {
        this.patch(slug, planner.id, { plan: { ...plan, state: "done", awaiting: null, finishedAt: nowIso() } });
        this.store.addComment(slug, planner.id, "ai", "Plan done: all child tickets finished and the final check ran.");
        this.notify(`Plan done: ${planner.title}`, "All child tickets finished. Summary in the ticket's outputs.", slug, planner.id);
        return false;
      }
      plan.awaiting = null;
    }
    if (plan.state === "stuck") {
      // Whatever made it stuck is gone once every child is finished (e.g. its last PR got merged): close it, no run needed.
      if (kids.length && kids.every(isComplete)) this.closePlan(slug, planner, plan, "Plan done: every child ticket finished, so the stuck plan was closed without another run.");
      return false;
    }
    if (plan.state === "finishing") {
      if (!plan.awaiting && !plannerBusy) this.wake(slug, planner, plan, "final", [], kids);
      else if (!sameJson(plan, planner.plan)) this.patch(slug, planner.id, { plan });
      return false;
    }
    const step = planStep(plan, kids, (id) => this.isRunning(slug, id), {
      held: (t) => this.heldResources(slug, t, true),
      waitingOnUser: (t) => this.userWait(t),
    });
    for (const cid of step.start) this.patch(slug, cid, { status: "ready", mode: "auto", outcome: null, error: null });
    if (step.events.length) {
      plan.inbox = [...(plan.inbox ?? []), ...step.events.map((e) => e.line)];
      plan.seen = { ...plan.seen, ...Object.fromEntries(step.events.map((e) => [e.childId, e.sig])) };
    }
    const inbox = plan.inbox ?? [];
    if (!plannerBusy && !plan.awaiting) {
      if (inbox.length) {
        if (plan.wakeups >= wakeupCap(Math.max(plan.originalCount, kids.length))) {
          this.stuck(slug, planner, plan, `wake-up limit reached (${plan.wakeups}); waiting events: ${inbox.join("; ")}`);
          return step.start.length > 0;
        }
        const key = this.key(slug, planner.id);
        const due = this.wakeDue.get(key);
        if (due === undefined) {
          const delay = this.opts.planWakeDelayMs ?? 3000;
          this.wakeDue.set(key, Date.now() + delay);
          setTimeout(() => this.advancePlans(slug), delay + 5);
        } else if (Date.now() >= due) {
          this.wakeDue.delete(key);
          this.wake(slug, planner, plan, "event", inbox, kids);
          return step.start.length > 0;
        }
        if (!sameJson(plan, planner.plan)) this.patch(slug, planner.id, { plan });
        return step.start.length > 0;
      }
      if (step.allComplete) {
        this.wake(slug, planner, { ...plan, state: "finishing" }, "final", [], kids);
        return false;
      }
      if (step.deadEnd && !step.start.length) {
        this.stuck(slug, planner, plan, step.deadEnd);
        return false;
      }
    }
    if (!sameJson(plan, planner.plan)) this.patch(slug, planner.id, { plan });
    return step.start.length > 0;
  }

  /** Resume the planner's session with what happened; several events arrive as one message. */
  private wake(slug: string, planner: Ticket, plan: Plan, kind: PlanWake, events: string[], kids: Ticket[]) {
    const text = orchestratorPrompt(planner, { kind, events, table: planTable(kids), board: slug, outputDir: this.store.outputsDir(slug, planner.id), repo: this.repoState(slug) ?? this.guessRepo(slug) });
    this.patch(slug, planner.id, { plan: { ...plan, inbox: [], awaiting: kind, wakeups: plan.wakeups + 1 } });
    // Back to where it was (In progress only if a restart cut a wake-up off).
    const returnTo = planner.status === "in_progress" ? "review" : planner.status;
    this.start(slug, planner.id, { text, mode: "act", raw: true, returnTo });
  }

  private closePlan(slug: string, planner: Ticket, plan: Plan, comment: string): Ticket {
    const out = this.patch(slug, planner.id, { plan: { ...plan, state: "done", awaiting: null, reason: null, inbox: [], finishedAt: nowIso() } });
    this.store.addComment(slug, planner.id, "ai", comment);
    return out;
  }

  private stuck(slug: string, planner: Ticket, plan: Plan, reason: string) {
    this.patch(slug, planner.id, { plan: { ...plan, state: "stuck", awaiting: null, reason } });
    // The stuck planner now needs the user (attention.ts): the Notifier tells them.
    this.store.addComment(slug, planner.id, "ai", `Plan stuck: ${reason}. Fix what's needed, then press Resume plan.`);
  }

  private async cleanupWorktree(slug: string, t: Ticket): Promise<Ticket> {
    const profile = this.store.getProfile(slug);
    if (!profile || !t.worktree) return t;
    const r = await this.removeTicketWorktree(profile, t.worktree);
    if (r.removed) return this.patch(slug, t.id, { worktree: null });
    this.store.addComment(slug, t.id, "ai", `Worktree kept at ${t.worktree}: ${r.reason}`);
    return t;
  }

  /**
   * Removes worktrees left behind by Done or deleted tickets (run once at startup; never throws).
   * Only the board's own worktree folder is looked at; ones with uncommitted changes are kept and logged.
   */
  async sweepWorktrees(): Promise<void> {
    for (const profile of this.store.listProfiles()) {
      try {
        if (!(await isGitRepo(profile.path))) continue;
        const root = dirname(worktreeDir(profile, "x"));
        if (!existsSync(root)) continue;
        const realRoot = realpathSync(root);
        let swept = 0;
        const kept: string[] = [];
        for (const dir of await listWorktrees(profile.path)) {
          if (dirname(dir) !== realRoot && dirname(dir) !== root) continue;
          const id = basename(dir);
          const t = this.store.getTicket(profile.slug, id);
          const key = this.key(profile.slug, id);
          const busy = this.isRunning(profile.slug, id) || this.setups.has(key) || this.sessionLocks.has(key);
          if (t && (t.status !== "done" || busy)) continue;
          const r = await this.removeTicketWorktree(profile, dir);
          if (!r.removed) {
            kept.push(`${id} (${r.reason})`);
            continue;
          }
          swept++;
          if (t?.worktree) this.patch(profile.slug, id, { worktree: null });
        }
        if (swept || kept.length) {
          console.log(`profile ${profile.slug}: swept ${swept} orphan worktree${swept === 1 ? "" : "s"}, kept ${kept.length} with changes${kept.length ? `: ${kept.join(", ")}` : ""}`);
        }
      } catch (e) {
        console.error(`profile ${profile.slug}: worktree sweep failed: ${(e as Error).message}`);
      }
    }
  }

  async deleteTicket(slug: string, id: string): Promise<void> {
    const active = this.runs.get(this.key(slug, id));
    if (active) {
      this.stopRun(active);
      await active.promise;
    }
    const t = this.store.getTicket(slug, id);
    const profile = this.store.getProfile(slug);
    if (t?.worktree && profile) await this.removeTicketWorktree(profile, t.worktree).catch(() => {});
    if (t) deleteAttachments(this.store.attachmentsDir, this.attachmentsOf(slug, t));
    this.store.deleteTicket(slug, id);
    this.bus.emit({ type: "ticket.deleted", profile: slug, id });
  }

  /** Images pasted into the ticket: its description, comments and chat (the Claude session transcript). */
  private attachmentsOf(slug: string, t: Ticket): string[] {
    const texts = [t.body, ...this.store.listComments(slug, t.id).map((c) => c.text), ...(t.queued ?? []).map((m) => m.text)];
    const file = t.sessionId ? claudeSessionFile(t.sessionId) : null;
    if (file) {
      try {
        texts.push(readFileSync(file, "utf8"));
      } catch {}
    }
    return referencedAttachments(...texts);
  }

  /** Attach a Claude session the user already started in the profile folder (null unlinks). */
  async linkSession(slug: string, id: string, sessionId: string | null): Promise<Ticket> {
    const profile = this.store.getProfile(slug);
    const t = this.store.getTicket(slug, id);
    if (!profile || !t) throw new Error("ticket not found");
    if (this.isRunning(slug, id)) throw new Error("ticket is running; stop it before linking a session");
    if (sessionId !== null && !/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("invalid session id");
    if (t.worktree && sessionId !== null) {
      const r = await this.removeTicketWorktree(profile, t.worktree);
      if (!r.removed) throw new Error(`ticket already has a worktree with changes (${t.worktree}); cannot switch session`);
    }
    return this.patch(slug, id, sessionId === null
      ? { sessionId: null, workdir: null }
      // Linked work already exists and the next step is the user's: land in Review ("Your turn").
      : { sessionId, workdir: profile.path, worktree: null, runCount: 0, lastRunAt: new Date().toISOString(), status: "review" });
  }

  /**
   * Branch a ticket, like Claude Code's --fork-session: a new "Branch: <title>" ticket in Planning with a copy of
   * the conversation (new session id) and its own git branch off the source's branch. The source is untouched.
   * warning: something the user should know (uncommitted changes weren't copied, the source branch was gone).
   */
  async branchTicket(slug: string, id: string): Promise<{ ticket: Ticket; warning: string | null }> {
    const profile = this.store.getProfile(slug);
    const src = this.store.getTicket(slug, id);
    if (!profile || !src) throw new Error(`ticket ${id} not found`);
    if (src.error?.startsWith("corrupt")) throw new Error("ticket file is corrupt");
    if (this.isRunning(slug, id)) throw new ConflictError("Claude is working on this ticket; branch it once Claude is done");
    const srcFile = src.sessionId ? claudeSessionFile(src.sessionId) : null;
    if (!src.sessionId || !srcFile) throw new Error("this ticket has no Claude conversation to branch yet");
    if (src.workdir && !existsSync(src.workdir)) throw new Error(`linked session folder no longer exists: ${src.workdir}`);

    const title = `Branch: ${src.title}`;
    const t = this.store.createTicket(slug, { title, body: src.body, status: "planning", mode: src.mode });
    const warnings: string[] = [];
    let worktree: string | null = null;
    try {
      const patch: Partial<Ticket> = {
        sessionId: crypto.randomUUID(), sessionStarted: true, refineStarted: true, interviewed: src.interviewed,
        branchedFrom: src.id, branchPoint: { at: nowIso(), sourceTitle: src.title },
      };
      // Same folder setup as the source: its linked folder, its own worktree branch, or the project folder.
      if (src.workdir) patch.workdir = src.workdir;
      else if (src.branch && (await isGitRepo(profile.path))) {
        const dir = worktreeDir(profile, t.id);
        const branch = `ck/${t.id}-${slugify(title)}`;
        const hasBranch = (await runCmd(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${src.branch}`], profile.path)).code === 0;
        let base: string | null = src.branch;
        if (!hasBranch) {
          base = await resolveBaseBranch(profile.path, profile.baseBranch);
          if (base === null) throw new Error(`branch ${src.branch} no longer exists and the repo has nothing to branch from`);
          warnings.push(`The source branch ${src.branch} no longer exists, so the branch starts from ${base}.`);
        } else if (src.worktree && existsSync(src.worktree)) {
          const st = await runCmd(["git", "status", "--porcelain"], src.worktree);
          if (st.code === 0 && st.stdout.trim()) warnings.push("Uncommitted changes in the source were not copied.");
        }
        await addWorktree(profile.path, dir, branch, base);
        worktree = dir;
        this.copyWorktreeFiles(slug, t.id, profile, dir);
        Object.assign(patch, { worktree: dir, branch, setupPending: true });
      } else {
        // The source works in the project folder itself: so does the branch, with the same Changes base.
        if (src.baseSha) patch.baseSha = src.baseSha;
        warnings.push((await isGitRepo(profile.path))
          ? "The original works in the project folder, so the branch edits the same files; they run one at a time."
          : "This folder has no version history, so the branch edits the same files as the original; they run one at a time.");
      }
      const fromCwd = src.workdir ?? src.worktree ?? (src.branch ? worktreeDir(profile, src.id) : profile.path);
      const toCwd = patch.workdir ?? worktree ?? profile.path;
      // The branch gets its own copies of pasted images, so deleting either ticket can't break the other.
      const rename = copyAttachments(this.store.attachmentsDir, referencedAttachments(src.body, readFileSync(srcFile, "utf8")));
      for (const [from, to] of Object.entries(rename)) patch.body = (patch.body ?? src.body).split(from).join(to);
      forkSessionFile(srcFile, { fromId: src.sessionId, toId: patch.sessionId!, fromCwd, toCwd, rename });
      this.store.copyOutputs(slug, src.id, t.id);
      const out = this.patch(slug, t.id, patch);
      return { ticket: out, warning: warnings.join(" ") || null };
    } catch (e) {
      if (worktree) await removeWorktree(profile.path, worktree).catch(() => {});
      this.store.deleteTicket(slug, t.id);
      throw e;
    }
  }

  /**
   * A new requirement on a ticket that already ran becomes its own ticket, linked to the original (addOnOf), so the
   * original keeps its title and description. start: straight to Ready, else Backlog. An add-on to a ticket still in
   * Review builds on its work (startFrom; in the project folder it is there anyway). The original goes back to
   * Review/Done when a chat or the user had moved it to Planning/Backlog for this.
   */
  async addOnTicket(slug: string, id: string, input: { title: string; body: string; start?: boolean; important?: boolean }): Promise<Ticket> {
    const src = this.store.getTicket(slug, id);
    if (!src) throw new Error(`ticket ${id} not found`);
    const title = input.title.trim();
    if (!title) throw new Error("title is required");
    const shaping = src.status === "planning" || src.status === "backlog";
    const was = shaping && src.reopenedFrom ? src.reopenedFrom : src;
    const t = await this.createTicket(slug, {
      title, body: input.body, status: "backlog", mode: "auto",
      ...(src.tags?.length ? { tags: src.tags } : {}), ...(src.important || input.important ? { important: true } : {}),
    });
    const patch: Partial<Ticket> = { addOnOf: src.id };
    if (was.status === "review" && src.branch && !src.workdir) patch.startFrom = src.branch;
    this.patch(slug, t.id, patch);
    if (shaping && src.reopenedFrom && !this.isRunning(slug, id)) {
      // Like a move by hand (Done cleans up its worktree); then its old outcome badge comes back too.
      await this.updateTicket(slug, id, { status: src.reopenedFrom.status });
      this.patch(slug, id, { outcome: src.reopenedFrom.outcome });
    }
    return input.start ? this.updateTicket(slug, t.id, { status: "ready" }) : this.store.getTicket(slug, t.id)!;
  }

  // ---- One-click recovery from a lost or busy session ----

  /** The first prompt of a fresh session: ticket, last result, recent comments, and where to look for the work so far. */
  private freshPrompt(slug: string, t: Ticket, session: Pick<Session, "repo" | "inPlace">, outputDir: string): string {
    const comments = this.store.listComments(slug, t.id);
    const last = comments.findLast((c) => c.author === "ai" && !BOARD_NOTE_RE.test(c.text));
    const recent = comments.filter((c) => !BOARD_NOTE_RE.test(c.text) && c !== last).slice(-10);
    const profile = this.store.getProfile(slug);
    return freshSessionPrompt(t, {
      repo: session.repo, inPlace: session.inPlace, home: profile ? { folder: profile.path, baseBranch: profile.baseBranch } : undefined, linked: !!t.workdir, baseBranch: profile?.baseBranch || "main",
      lastResult: last?.text ?? null, comments: recent, outputDir, autoHuddles: autoHuddlesOn(profile), artifacts: !!profile?.artifacts,
      recall: this.recall(slug, t),
    });
  }

  /**
   * "What we did before on this board": related past tickets for t's first prompt (see recall.ts), the rules the board
   * learned from the user's corrections (learn.ts), and the project's saved lessons a run in a worktree can't see yet
   * (lessons.ts); "" for none.
   */
  private recall(slug: string, t: Ticket): string {
    const rows = this.store.listTickets(slug).map((o) => ({
      ticket: o,
      summary: this.store.aiComments(slug, o.id).findLast((c) => !BOARD_NOTE_RE.test(c.text))?.text ?? null,
    }));
    const profile = this.store.getProfile(slug);
    const now = this.store.getTicket(slug, t.id) ?? t;
    const lessons = profile ? lessonsBlock(profile.path, now.worktree ?? now.workdir ?? null) : "";
    return [recallBlock(t, rows), learnedRulesBlock(this.store, slug), lessons].filter(Boolean).join("\n\n");
  }

  /** Queues the ticket's work run: it starts now if a slot is free (dispatch), otherwise when one frees up. */
  private requeue(slug: string, id: string): Ticket {
    this.patch(slug, id, { status: "ready", outcome: null, error: null });
    this.dispatch(slug);
    return this.store.getTicket(slug, id)!;
  }

  private recoverable(slug: string, id: string): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    if (t.error?.startsWith("corrupt")) throw new Error("ticket file is corrupt");
    if (this.isRunning(slug, id)) throw new ConflictError("Claude is already working on this ticket");
    return t;
  }

  /**
   * Start fresh session: drops the ticket's Claude session (its conversation can't be resumed) but keeps the
   * worktree and branch, then queues a work run whose prompt tells Claude to continue from the branch's state.
   */
  startFresh(slug: string, id: string): Ticket {
    this.recoverable(slug, id);
    this.patch(slug, id, { sessionId: crypto.randomUUID(), sessionStarted: false, freshSession: true });
    this.store.addComment(slug, id, "ai", "Started a fresh session: the previous conversation is gone, so Claude continues from the ticket, its last result and the branch as it is now.");
    return this.requeue(slug, id);
  }

  /**
   * Take over here: the ticket's session is open in a terminal. If that's the board's own (dock) terminal, it is
   * closed and the run resumes here; one in an external terminal can't be closed (external: the UI offers
   * Start fresh session instead).
   */
  async takeOver(slug: string, id: string): Promise<{ ticket: Ticket; external: boolean }> {
    const t = this.recoverable(slug, id);
    if (t.sessionId) {
      const owned = await this.opts.findOwnedSession?.(t.sessionId) ?? null;
      if (owned) {
        if (!(await owned.close())) throw new Error("Couldn't close the session in the board's terminal. Exit it there (Ctrl+D or /exit), then try again.");
        this.store.addComment(slug, id, "ai", "Took over the session: closed it in the board's terminal and resumed the run here.");
        return { ticket: this.requeue(slug, id), external: false };
      }
      const title = t.workdir ? sessionTitle(t.workdir, t.sessionId) : null;
      if (await this.isSessionLive(t.sessionId, title)) return { ticket: t, external: true };
    }
    this.store.addComment(slug, id, "ai", "Took over the session: it was no longer open in a terminal, so the run resumed here.");
    return { ticket: this.requeue(slug, id), external: false };
  }

  /** A comment: the user's (or a planner's), or with from, a note another ticket's run left (shown as Claude's). */
  addComment(slug: string, id: string, text: string, from?: string) {
    const c = this.store.addComment(slug, id, from ? "ai" : "user", text, from);
    this.emitTicket(slug, this.store.getTicket(slug, id)!);
    return c;
  }

  private stopRun(run: ActiveRun) {
    // Show the stop at once: setup (worktree, session checks) or SIGTERM can take a while to finish.
    if (!run.stopRequested && this.store.getTicket(run.slug, run.id)) this.patch(run.slug, run.id, { lastActivity: "Stopping…" });
    run.stopRequested = true;
    run.handle?.stop();
    this.setups.get(this.key(run.slug, run.id))?.abort.abort();
  }

  stop(slug: string, id: string): boolean {
    const r = this.runs.get(this.key(slug, id));
    if (r) {
      this.stopRun(r);
      return true;
    }
    const t = this.store.getTicket(slug, id);
    if (t?.slotWait) {
      this.cancelSlotWait(slug, id);
      return true;
    }
    // In Progress with no run behind it (e.g. the daemon lost it, or it waits for its auto huddle): clear the card.
    if (t?.status !== "in_progress") return false;
    this.store.addComment(slug, id, "ai", t.autoHuddle ? "Stopped by user while waiting for its auto huddle." : "Run stopped by user.");
    this.patch(slug, id, { status: "review", outcome: "stopped", error: null, lastActivity: null, ...(t.autoHuddle ? { autoHuddle: null } : {}) });
    return true;
  }

  stopAll(): void {
    for (const r of this.runs.values()) this.stopRun(r);
  }

  /** Kill all runs without recording an outcome; tickets stay in_progress for recover(). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const r of this.runs.values()) this.markInterrupted(r);
    for (const r of this.runs.values()) {
      r.stopRequested = true;
      r.handle?.stop();
    }
    for (const s of this.setups.values()) s.abort.abort();
    await Promise.race([this.whenIdle(), Bun.sleep(6000)]);
  }

  /** A chat reply is being cut off by shutdown: remember it so recover() resumes it (work runs stay in_progress). */
  private markInterrupted(r: ActiveRun): void {
    const t = this.store.getTicket(r.slug, r.id);
    if (!t || !r.chat || r.stopRequested || t.status === "in_progress") return;
    // Not spawned yet with a queued message: it is still in the queue, and recover() answers it.
    if (!r.handle && r.promptMsgId) return;
    const i: Interrupted = { at: nowIso(), mode: r.chat.mode };
    if (r.chat.quiet) i.quiet = true;
    if (r.chat.user) i.user = true;
    if (r.draft?.text) i.partial = r.draft.text;
    // Claude never got the prompt: send it again rather than asking it to continue.
    if (!r.handle) i.prompt = r.chat.raw ? { text: r.chat.text, raw: true } : { text: r.chat.text };
    this.patch(r.slug, r.id, { interrupted: i, lastActivity: null, runStartedAt: null });
  }

  /** Huddles tells the board about its host tickets' huddles, which change whether those tickets need the user. */
  onHostHuddles(f: (slug: string) => Map<string, HostHuddle>): void {
    this.hostHuddleStates = f;
  }

  /** Open huddles by host ticket on a board. */
  hostHuddles(slug: string): Map<string, HostHuddle> {
    return this.hostHuddleStates(slug);
  }

  /** Count more active work a restart waits for: busy() lists the board of each piece of work active now. */
  onRestartBusy(busy: () => string[]): void {
    this.restartBusy.push(busy);
  }

  /** Board runs plus other active work a restart waits for. */
  private activeWork(): number {
    return this.busyBoards().length;
  }

  /** The board of each piece of active work (runs, chat replies, huddle agents mid-turn, job commands), repeats included. */
  busyBoards(): string[] {
    return [...[...this.runs.values()].map((r) => r.slug), ...this.restartBusy.flatMap((f) => f())];
  }

  /**
   * Restart once no run is active. Until then nothing new starts: Ready tickets wait, chat messages queue and
   * Planning interviews are held; recover() starts them after the restart. After maxWaitMs it restarts anyway.
   */
  requestRestart(onIdle: () => void, maxWaitMs = RESTART_MAX_WAIT_MS): { running: number; alreadyPending: boolean } {
    const running = this.activeWork();
    if (this.restartPending) return { running, alreadyPending: true };
    this.restartPending = true;
    this.emitRestart();
    void (async () => {
      const deadline = Date.now() + maxWaitMs;
      // Always yield first, so the caller's HTTP response goes out before the daemon exits.
      do await Bun.sleep(200);
      while (this.activeWork() && Date.now() < deadline);
      const left = this.activeWork();
      if (left) console.log(`restart: ${left} run(s) still active after ${Math.round(maxWaitMs / 1000)}s; restarting anyway`);
      onIdle();
    })();
    return { running, alreadyPending: false };
  }

  isRestartPending(): boolean {
    return this.restartPending;
  }

  /** pending: a restart holds new runs; waiting: active runs it waits for. */
  restartState(): { pending: boolean; waiting: number } {
    return { pending: this.restartPending, waiting: this.activeWork() };
  }

  /** Other active work (see onRestartBusy) changed: update the pending restart's count. */
  restartWorkChanged(): void {
    if (this.restartPending) this.emitRestart();
  }

  private emitRestart(): void {
    this.bus.emit({ type: "restart.updated", ...this.restartState() });
  }

  recover(): void {
    for (const p of this.store.listProfiles()) {
      for (const t of this.store.listTickets(p.slug)) {
        // Replies waiting for a slot keep waiting: dispatch() below starts them first.
        // Tickets waiting for their auto huddle stay put: the huddle (or a freed slot) wakes them.
        if (t.status !== "in_progress" || t.slotWait || t.autoHuddle || this.isRunning(p.slug, t.id)) continue;
        if (t.followUpRun) {
          // A follow-up wake was cut off: continue it as a follow-up, and the card goes back where it was.
          this.store.addComment(p.slug, t.id, "ai", "Follow-up interrupted by daemon restart; resuming.");
          const returnTo = t.followUpRun.returnTo;
          this.patch(p.slug, t.id, { status: returnTo, lastActivity: null });
          this.start(p.slug, t.id, { text: interruptedPrompt(), mode: "act", raw: true, returnTo, followUp: true });
          continue;
        }
        if (t.plan?.awaiting && planActive(t.plan)) {
          // A planner wake-up was cut off: wake it again with the children's current state.
          this.store.addComment(p.slug, t.id, "ai", "Planner interrupted by daemon restart; waking it again.");
          this.patch(p.slug, t.id, {
            status: "review", outcome: null, lastActivity: null,
            plan: { ...t.plan, state: t.plan.awaiting === "final" ? "finishing" : t.plan.state, awaiting: null, seen: {} },
          });
          continue;
        }
        this.store.addComment(p.slug, t.id, "ai", "Interrupted by daemon restart; resuming.");
        this.patch(p.slug, t.id, { status: "ready" });
      }
      this.dispatch(p.slug);
      this.advancePlans(p.slug);
      // Chat replies a restart cut off (or held back): continue them in the same session and mode.
      for (const t of this.store.listTickets(p.slug)) {
        const i = t.interrupted;
        if (!i || this.isRunning(p.slug, t.id) || t.status === "in_progress" || t.error?.startsWith("corrupt")) continue;
        if (!i.held) this.store.addComment(p.slug, t.id, "ai", "Reply interrupted by daemon restart; resuming.");
        const user = i.user ? { user: true } : {};
        if (i.prompt) this.start(p.slug, t.id, { text: i.prompt.text, mode: i.mode, raw: i.prompt.raw, quiet: i.quiet, ...user });
        // With a queued message waiting, the pass below answers it instead (one reply, not two).
        else if (!this.waiting(p.slug, t.id).length) this.start(p.slug, t.id, { text: interruptedPrompt(), mode: i.mode, raw: true, quiet: i.quiet, ...user });
      }
      // Messages a restarted chat run never got to: answer them in a chat reply now.
      for (const t of this.store.listTickets(p.slug)) {
        const next = this.waiting(p.slug, t.id)[0];
        if (!next || this.isRunning(p.slug, t.id) || t.status === "ready" || t.slotWait || t.error?.startsWith("corrupt")) continue;
        const chat = chatFor(t, next);
        if (takesSlot(chat) && this.full(p.slug)) this.waitForSlot(p.slug, t.id);
        else this.start(p.slug, t.id, chat, next.id);
      }
    }
  }

  async whenIdle(): Promise<void> {
    while (this.runs.size) {
      await Promise.all([...this.runs.values()].map((r) => r.promise));
    }
  }
}

function clampConcurrency(n: number): number {
  return Math.max(1, Math.min(10, Math.round(Number(n) || DEFAULT_MAX_CONCURRENT)));
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
