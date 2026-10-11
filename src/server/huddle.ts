// Huddles: a shared message room where several headless Claude sessions work on one ticket together.
// The host ticket's own session is @main (the coordinator); agents (reviewer, QA, ...) are sessions the huddle runs
// itself, outside the board's run slots (only maxParticipants limits them). Other tickets' sessions can be invited.
// The daemon stamps every message's sender, keeps the log append-only, caps the roster, and one Stop stops every
// huddle agent. Stop and Close never touch the tickets' own work: only the reply runs the huddle woke them for.
//
// Routing: an @mentioned participant is woken (steered if it is running, else its session resumes with what it
// hasn't read). Monitor-mode participants get every new message at their next turn boundary; tagged ones sleep until
// mentioned. Nobody gets their own messages. System messages are context only and wake nobody, except the ones that
// tag someone (the brakes' warnings, the notes below). Only leads, @main and the user can wake everyone with @all.
// Leads (monitor mode unless their roster or preset says otherwise) always watch: a done lead still wakes on any
// direct tag and, in monitor mode, on a non-lead's report. A done non-lead sleeps until a lead, @main or the user tags
// it (so workers can't loop); a blocked one until someone tags it. A tag that wakes nobody because its target is done,
// blocked or stopped is never dropped silently: a system note tags @main, once per target and sender until the
// target wakes. Wakes owed while the huddle was stopped or the daemon was down are delivered on Resume and after a
// restart (see wakeIfOwed).
//
// Idle watchdog: a live huddle where nobody (@main included) has worked and no wake was queued or owed for
// HUDDLE_IDLE_MS, and @main or the user didn't have the last word, wakes @main once with a system note; again only
// after a new message. It is a sweep from the huddle's times, so it carries over a daemon restart, and it pauses while
// the daemon shuts down or a restart is pending.
//
// Lifecycle: @main or a lead writes outputs/huddles/<id>/summary.md and asks the user to close (huddle_close); only
// the user closes, or the host ticket moving to Done does. Closing removes the agents' clean own worktrees and the
// read-only agents' snapshots. A huddle closed without a summary gets one: @main is asked to write it, or, when the
// host ticket can't run (Done, no session), the board writes one from the huddle's data (fallbackSummary).
//
// Workspaces: the shared worktree is the coordinator's. A read-only agent (shared, can't edit) works in a detached
// snapshot worktree at the host branch's committed HEAD, reset at every wake, so its shell can't touch the
// coordinator's files. The board remembers its own last save of the huddle file; an edit from outside can't raise
// lead, canEdit or the limits (see guard).
//
// Brakes, so a huddle can't loop or overspend: it stops at maxCostUsd (agents' runs and @main's huddle replies; the
// leads are warned at 80%) and at maxMessages; routing pauses after AGENT_ONLY_MAX messages without the user; two
// participants answering each other PING_PONG times in a row stop waking each other and their lead is tagged.
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { summarizeEvent } from "./activity";
import { mcpConfig } from "./agents";
import { claudeSessionExists, type Board } from "./board";
import type { Bus } from "./events";
import { addWorktree, branchExists, hasCommits, removeWorktree, run as git, worktreeDir } from "./git";
import {
  DEFAULT_MAX_PARTICIPANTS, handleBase, HUDDLE_AGENT_ENV, LEGACY_SUMMARY_FILE, MAIN_HANDLE, NO_EDIT_TOOLS, parseMentions, RESERVED_HANDLES,
  rosterEntryError, rosterError, summaryFile, USER_HANDLE, type RosterEntry,
} from "./huddle-roster";
import {
  BUILTIN_PRESETS, deletePreset, type HuddlePreset, type HuddlePresetView, MAIN_PRESET, mergePresets, presetName, savePreset,
} from "./huddle-presets";
import {
  ALL_ROLES, cleanLessons, cleanNotes, type HuddleNote, lessonsSection, type LessonInput, NOTE_MAX, noteRole, noteText, type NoteScope, type RoleNotes,
} from "./huddle-notes";
import {
  AUTO_REVIEW, AUTO_REVIEW_IMPORTANT, BUILTIN_TEMPLATES, deleteTemplate, type HuddleTemplate, type HuddleTemplateView, mergeTemplates, saveTemplate, templateBrief,
} from "./huddle-templates";
import type { HostHuddle } from "./attention";
import { huddleUsage, type Usage } from "./huddle-usage";
import { isLevel, type Level, lowerLevels } from "./layers";
import { autoHuddleSlotPrompt, autoHuddleStoppedPrompt, huddleAgentPrompt, huddleAgentSystemPrompt, huddleDigest, huddleMainPrompt } from "./prompts";
import { buildArgs, MONITOR_IDLE_MS, startRun, type RunHandle } from "./runner";
import { addHuddleSpend } from "./spend";
import type { Store } from "./store";
import { contextTokens, messageCost } from "./ticket-usage";
import { proposalPreset, teammateProposal, type TeammateProposal } from "./teammate-proposal";
import { autoHuddlesOn } from "./types";
import type {
  Huddle, HuddleFinding, HuddleLearning, HuddleMessage, HuddleMessageKind, HuddleMode, HuddleParticipant, HuddleSource, HuddleStopReason, Profile, Ticket,
} from "./types";
import { newId, nowIso } from "./util";

export class HuddleError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Unread messages handed to a session at once; older ones are left to huddle_read. */
const DIGEST_MAX = 40;
/** Longest message anyone can post: longer reports go in a file. */
export const POST_MAX = 2000;
/** Longest pinned brief. */
export const BRIEF_MAX = 2000;
/** A finding's title as system lines show it (the findings list has the whole text). */
const FINDING_TITLE = 100;
const ACTIVITY_THROTTLE_MS = 1000;
export const DEFAULT_MAX_COST_USD = 20;
/** Most an auto huddle (start_huddle) may ask for; a run asking for more gets this. */
export const AUTO_MAX_COST_USD = 100;
export const DEFAULT_MAX_MESSAGES = 150;
/** Messages (not system ones) since the user last posted or resumed before routing pauses. */
export const AGENT_ONLY_MAX = 30;
/** Messages in a row going back and forth between the same two participants. */
export const PING_PONG = 6;
const BUDGET_WARN = 0.8;
/** Lessons one participant can have waiting for the user's review. */
const MAX_PENDING = 3;
/** Teammates one agent may have waiting for the user's review at once. */
const MAX_PENDING_TEAMMATES = 2;
/** A live huddle with nobody working and nothing owed for this long wakes @main (see idleSweep). */
export const HUDDLE_IDLE_MS = 5 * 60_000;
/** How often the idle watchdog looks at the open huddles. */
const IDLE_SWEEP_MS = 30_000;

/** What the huddle spent so far: every participant's runs (agents) and huddle replies (@main and invited tickets). */
export const huddleCost = (h: Huddle) => h.participants.reduce((s, p) => s + (p.costUsd ?? 0), 0);

/** What one huddle's teammates (its agents) spent, for the host ticket's cost. */
export interface HuddleTeammateSpend {
  id: string;
  status: Huddle["status"];
  createdAt: string;
  costUsd: number;
  teammates: { handle: string; role: string; costUsd: number }[];
}

/**
 * What the agents of a ticket's huddles spent: it counts on the host ticket's card and Usage tab. Ticket sessions
 * (@main, invited tickets) are left out, their huddle replies are runs of their own ticket and counted there.
 */
export function teammateSpend(huddles: Huddle[], ticketId: string): { costUsd: number; huddles: HuddleTeammateSpend[] } {
  const out: HuddleTeammateSpend[] = [];
  for (const h of huddles) {
    if (h.hostTicket !== ticketId) continue;
    const teammates = h.participants
      .filter((p) => p.kind === "agent" && (p.costUsd ?? 0) > 0)
      .map((p) => ({ handle: p.handle, role: p.role, costUsd: p.costUsd ?? 0 }));
    if (teammates.length) out.push({ id: h.id, status: h.status, createdAt: h.createdAt, costUsd: teammates.reduce((a, t) => a + t.costUsd, 0), teammates });
  }
  return { costUsd: out.reduce((a, h) => a + h.costUsd, 0), huddles: out };
}

/** A participant's cost after a result line reporting its session's running total. */
function costAfter(p: HuddleParticipant | undefined, total: number): Pick<HuddleParticipant, "costUsd" | "sessionCostUsd"> {
  const prev = p?.sessionCostUsd ?? 0;
  return { costUsd: (p?.costUsd ?? 0) + (total >= prev ? total - prev : total), sessionCostUsd: total };
}

const money = (n: number) => `$${n.toFixed(2)}`;

export type ParticipantView = Omit<HuddleParticipant, "token"> & {
  running: boolean;
  /** Estimated cost of the turn it is in now, not yet in costUsd (≈, priced from the turn's messages). */
  liveCostUsd?: number;
};
/**
 * quiet: live, nobody working, no unanswered tags and no open findings (a sign it can be wrapped up);
 * idleSince: when the last message or turn was. forYou: messages tagging @you since the user last posted or acted
 * (forYouSince: that seq), plus the learnings waiting for the user's review (learningsPending).
 */
export type HuddleView = Omit<Huddle, "participants"> & {
  participants: ParticipantView[]; hostTitle: string | null; quiet: boolean; idleSince: string | null; forYou: number; forYouSince: number;
  learningsPending: number;
  /** The huddle's summary, relative to the host ticket's outputs folder; null while there is none. */
  summary: string | null;
};

/** Lessons waiting for the user to save or discard them. */
export const pendingLearnings = (h: Huddle) => (h.learnings ?? []).filter((l) => l.status === "pending");

/** The seq the user has seen up to: their last post or action (Stop, Resume, restart…). */
export function userSeenSeq(h: Huddle, msgs: HuddleMessage[]): number {
  const me = h.participants.find((p) => p.handle === USER_HANDLE);
  const posted = msgs.findLast((m) => m.from === USER_HANDLE)?.seq ?? 0;
  return Math.max(me?.cursor ?? 0, posted);
}

/** A message that needs the user: it tags @you (brake and close-request system lines included) after `since`. */
export const isForYou = (m: HuddleMessage, since: number) => m.seq > since && m.from !== USER_HANDLE && m.mentions.includes(USER_HANDLE);

export { LEGACY_SUMMARY_FILE, summaryFile };

/**
 * The summary the board writes itself when a huddle closed without one and @main can't write it: the brief, the
 * roster with costs, the findings, each lead's last message and the output files the messages mention.
 */
export function fallbackSummary(h: Huddle, msgs: HuddleMessage[], outputs: string[]): string {
  const span = `${h.createdAt.slice(0, 16).replace("T", " ")}${h.closedAt ? ` to ${h.closedAt.slice(0, 16).replace("T", " ")}` : ""} UTC`;
  const agents = h.participants.filter((p) => p.kind !== "human");
  const leads = agents.filter((p) => p.lead || p.handle === MAIN_HANDLE);
  const last = leads.map((p) => ({ p, m: msgs.findLast((m) => m.from === p.handle && m.kind !== "system") })).filter((x) => x.m);
  const said = msgs.map((m) => m.text).join("\n");
  const mine = summaryFile(h.id);
  const mentioned = new Set(outputs.filter((f) => f !== mine && said.includes(f)));
  for (const m of said.matchAll(/outputs\/([\w.\/-]+\.\w+)/g)) if (m[1] !== mine) mentioned.add(m[1]);
  const finding = (f: HuddleFinding) =>
    `- [${f.status === "resolved" ? "x" : " "}] ${f.text.replace(/\s*\n\s*/g, " ")} (pinned by @${f.by}${f.resolvedBy ? `, resolved by @${f.resolvedBy}` : ""})`;
  return [
    "# Huddle summary",
    "",
    `_Written by the board: huddle ${h.id} closed without a summary. ${span}, ${h.seq} messages, ${money(huddleCost(h))} spent._`,
    "",
    "## Brief",
    "",
    h.brief?.text.trim() || "No brief was pinned.",
    "",
    "## Participants",
    "",
    ...(agents.length ? agents.map((p) => `- @${p.handle}: ${p.role}${p.lead ? " (lead)" : ""} · ${p.status} · ${money(p.costUsd ?? 0)}`) : ["None."]),
    "",
    "## Findings",
    "",
    ...(h.findings.length ? h.findings.map(finding) : ["None pinned."]),
    "",
    "## Last word from the leads",
    "",
    ...(last.length ? last.flatMap(({ p, m }) => [`### @${p.handle} (#${m!.seq})`, "", m!.text.trim(), ""]) : ["No lead posted.", ""]),
    "## Output files mentioned",
    "",
    ...(mentioned.size ? [...mentioned].sort().map((f) => `- ${f}`) : ["None."]),
    "",
  ].join("\n");
}

/** Who is calling, from the request: a board run's ticket (RUN_HEADER) and a huddle agent (HUDDLE_HEADER). Neither: the user. */
export interface Caller {
  run?: string | null;
  agent?: string | null;
}

export interface HuddleOptions {
  claudeBin: string;
  /** How long a monitor-mode session stays open between turns (default 30 min). */
  idleMs?: number;
  sessionExists?: (sessionId: string) => boolean;
}

interface AgentRun {
  handle: RunHandle | null;
  promise: Promise<void>;
  /** Between Claude's result and its next turn. */
  idle: boolean;
  /** Monitor: messages came in mid-turn; they go in at the next turn boundary. */
  pending: boolean;
  /** Messages came in after input closed: deliver them in a new run once this one ends. */
  again: boolean;
  stopRequested: boolean;
  /** Snapshot agent between turns: its worktree is being reset (refreshing), or was reset for the next wake (fresh). */
  refreshing?: Promise<void> | null;
  fresh?: boolean;
  /** Estimated cost of the turn in progress by assistant message id (its result line gives the exact total). */
  turn?: Map<string, number>;
  /** Its conversation's size at the latest assistant message (saved as contextTokens with the next activity write). */
  ctx?: number;
}

const isCoordinator = (h: Huddle, p: HuddleParticipant) => p.kind === "ticket-main" && p.ticketId === h.hostTicket;
const canManage = (h: Huddle, p: HuddleParticipant) => p.kind === "human" || isCoordinator(h, p) || p.lead;
/** A read-only agent in the shared workspace: it works in a detached snapshot of the host's HEAD. */
/** closeForTicket's default reason: the host ticket is gone, so nobody writes a summary. */
const DELETED = "the host ticket was deleted";

/** The queued message asking @main for a closed huddle's summary. */
const summaryAsk = (h: Huddle, file: string) =>
  `Huddle ${h.id} was closed without a summary. Write it to ${file}: what was decided, the findings and their state, what is left to do. ` +
  "The huddle is closed, so don't post there; just write the file and end your turn.";

const isSnapshot = (p: HuddleParticipant) => p.kind === "agent" && p.workspace === "shared" && !p.canEdit;
/** done / blocked: set by the participant itself; its runs' turns ending don't change it. */
const settled = (p: HuddleParticipant | undefined) => p?.status === "done" || p?.status === "blocked";

export class Huddles {
  private runs = new Map<string, AgentRun>();
  /** Ticket sessions (monitor mode) with messages waiting until their current run ends, "<slug>/<huddle>/<handle>". */
  private mainPending = new Set<string>();
  /** Closed huddles ("slug/hid") whose summary @main was asked to write; see ensureSummary. */
  private summaryOwed = new Set<string>();
  /** Ticket sessions by "<slug>/<ticket>": the huddle participant that last woke them (its peer runs' cost is that huddle's). */
  private mainWoken = new Map<string, { hid: string; handle: string }>();
  /** A ticket session's latest conversation size ("slug/id" -> tokens), and when it was last written to its huddles. */
  private ticketCtx = new Map<string, { tokens: number; savedAt: number; saved: number }>();
  private shuttingDown = false;
  private sessionExists: (id: string) => boolean;
  /** Background work whenIdle() waits for (worktree cleanup after a close). */
  private chores = new Set<Promise<void>>();
  /** Each huddle as this board last saved it, with its file's stamp, by "<slug>/<huddle>" (see guard). */
  private saved = new Map<string, { stamp: string | null; h: Huddle }>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  /** Per board: the ticket the board last woke because the auto-huddle slot freed; the next waiter waits until its run is over. */
  private slotWoken = new Map<string, string>();

  constructor(private store: Store, private board: Board, private bus: Bus, private opts: HuddleOptions) {
    this.sessionExists = opts.sessionExists ?? claudeSessionExists;
    // A pending restart waits for huddle agents mid-turn too.
    board.onRestartBusy(() => this.busy());
    // "Needs you" on a host ticket depends on its huddle (attention.ts).
    board.onHostHuddles((slug) => this.hostStates(slug));
    // A monitor-mode ticket session gets what came in while it worked once its run is over.
    bus.on((e) => {
      if (e.type === "activity") {
        this.ticketContext(e.profile, e.id, e.event);
        return this.mainResult(e.profile, e.id, e.event);
      }
      if (e.type !== "ticket.updated" || this.shuttingDown) return;
      // The host ticket is done: so is its huddle.
      if (e.ticket.status === "done") {
        const { profile, ticket } = e;
        if (this.store.listHuddles(profile).some((h) => h.hostTicket === ticket.id && h.status !== "closed")) {
          queueMicrotask(() => this.closeForTicket(profile, ticket.id, "the host ticket moved to Done"));
        }
      }
      // A ticket woken for a free auto-huddle slot finished its run without taking it: the next waiter gets it.
      if (this.slotWoken.get(e.profile) === e.ticket.id && !this.board.isRunning(e.profile, e.ticket.id)) {
        const { profile } = e;
        queueMicrotask(() => this.freeSlot(profile));
      }
      // @main was asked for a closed huddle's summary: once its run is over, the board writes it if it didn't.
      for (const key of [...this.summaryOwed]) {
        const [slug, hid] = key.split("/");
        if (slug !== e.profile) continue;
        const h = this.load(slug, hid);
        if (h && (h.hostTicket !== e.ticket.id || this.board.isRunning(slug, e.ticket.id) || e.ticket.queued?.some((m) => m.state === "queued"))) continue;
        this.summaryOwed.delete(key);
        if (h) queueMicrotask(() => this.writeFallbackSummary(slug, hid));
      }
      if (!this.mainPending.size) return;
      for (const key of [...this.mainPending]) {
        const [slug, hid, handle] = key.split("/");
        if (slug !== e.profile) continue;
        const h = this.load(slug, hid);
        const p = h?.participants.find((x) => x.handle === handle);
        if (!h || !p || p.ticketId !== e.ticket.id || this.board.isRunning(slug, e.ticket.id)) continue;
        this.mainPending.delete(key);
        queueMicrotask(() => this.deliverNow(slug, hid, handle));
      }
    });
  }

  private key(slug: string, hid: string, handle: string) {
    return `${slug}/${hid}/${handle}`;
  }

  /** A ticket session's result line: a huddle reply run's cost counts toward the huddle that woke it. */
  private mainResult(slug: string, ticketId: string, ev: any) {
    if (ev?.type !== "result" || this.shuttingDown) return;
    const woken = this.mainWoken.get(`${slug}/${ticketId}`);
    if (!woken || !this.board.isPeerRun(slug, ticketId)) return;
    const h = this.load(slug, woken.hid);
    const p = h?.participants.find((x) => x.handle === woken.handle && x.ticketId === ticketId);
    if (!h || !p || h.status === "closed") return;
    this.updateP(slug, h.id, p.handle, { ...costAfter(p, Number(ev.total_cost_usd) || 0), idleAt: nowIso() });
    this.checkBudget(slug, h.id);
  }

  /**
   * A ticket session's conversation size, for the huddles it is a ticket-main in (@main or invited): from each
   * assistant message's usage, written at most once a second while it works and at once on its result line.
   */
  private ticketContext(slug: string, ticketId: string, ev: any) {
    if (this.shuttingDown) return;
    const key = `${slug}/${ticketId}`;
    const st = this.ticketCtx.get(key);
    // A subagent's (Task) messages carry its own small context, not the session's.
    if (ev?.type === "assistant") {
      if (ev.parent_tool_use_id) return;
      const tokens = contextTokens(ev.message?.usage);
      if (!tokens) return;
      if (st) st.tokens = tokens;
      else this.ticketCtx.set(key, { tokens, savedAt: 0, saved: 0 });
    } else if (ev?.type !== "result" || !st) return;
    const cur = this.ticketCtx.get(key)!;
    const now = Date.now();
    if (cur.tokens === cur.saved || (ev.type !== "result" && now - cur.savedAt < ACTIVITY_THROTTLE_MS)) return;
    cur.saved = cur.tokens;
    cur.savedAt = now;
    for (const h of this.store.listHuddles(slug)) {
      if (h.status === "closed") continue;
      for (const p of h.participants) {
        if (p.kind === "ticket-main" && p.ticketId === ticketId && p.contextTokens !== cur.tokens) this.updateP(slug, h.id, p.handle, { contextTokens: cur.tokens });
      }
    }
  }

  // ---- Reading ----

  get(slug: string, hid: string): Huddle {
    const h = this.load(slug, hid);
    if (!h) throw new HuddleError(404, `huddle ${hid} not found`);
    return h;
  }

  /** The huddle from disk, checked against edits made outside the board (see guard). */
  private load(slug: string, hid: string): Huddle | null {
    const h = this.store.getHuddle(slug, hid);
    if (!h) {
      this.saved.delete(`${slug}/${hid}`);
      return null;
    }
    return this.guard(slug, h);
  }

  private save(slug: string, h: Huddle) {
    this.store.saveHuddle(slug, h);
    this.saved.set(`${slug}/${h.id}`, { stamp: this.store.huddleStamp(slug, h.id), h: structuredClone(h) });
  }

  /**
   * The huddle file changed since the board last saved it (an agent's shell can write it): whatever it raised (lead,
   * canEdit, the limits) goes back to what the board had, as do the status, any lowered cost or message count, and
   * participants the board didn't add; a system message says so.
   * The first read after a daemon start is taken as is.
   */
  private guard(slug: string, h: Huddle): Huddle {
    const key = `${slug}/${h.id}`;
    const last = this.saved.get(key);
    const stamp = this.store.huddleStamp(slug, h.id);
    if (!last) {
      this.saved.set(key, { stamp, h: structuredClone(h) });
      return h;
    }
    if (stamp === last.stamp) return h;
    const was = last.h;
    // Only the board adds participants; one the board doesn't know is dropped.
    h.participants = h.participants.filter((p) => was.participants.some((x) => x.handle === p.handle));
    for (const p of h.participants) {
      const before = was.participants.find((x) => x.handle === p.handle)!;
      if (!before.lead) p.lead = false;
      if (!before.canEdit) p.canEdit = false;
      p.kind = before.kind;
      // Spend only goes up, so a lowered cost can't get under the budget brake.
      if ((before.costUsd ?? 0) > (p.costUsd ?? 0)) p.costUsd = before.costUsd;
    }
    // Paused, stopped or closed only changes through the board (Resume, close), not by editing the file.
    h.status = was.status;
    h.stopReason = was.stopReason;
    // Proposed lessons only change through the board: an agent can't reword or save one by editing the file.
    h.learnings = was.learnings;
    for (const k of ["posts", "sinceUser", "idleNudged"] as const) {
      if ((was[k] ?? 0) > (h[k] ?? 0)) h[k] = was[k];
    }
    for (const k of ["maxParticipants", "maxCostUsd", "maxMessages"] as const) {
      const limit = was[k];
      if (limit !== undefined && (h[k] === undefined || h[k]! > limit)) h[k] = limit;
    }
    this.save(slug, h);
    // Not from inside this read: it may be part of an update that saves after it.
    queueMicrotask(() => {
      if (this.store.getHuddle(slug, h.id)) {
        this.system(slug, h.id, "Huddle file edited outside the board. Changes there to lead, canEdit, the limits, the status, the costs, the participants or the learnings were ignored; only the board changes them.");
      }
    });
    return h;
  }

  isRunning(slug: string, h: Huddle, p: HuddleParticipant): boolean {
    if (p.kind === "agent") return this.runs.has(this.key(slug, h.id, p.handle));
    if (p.kind === "ticket-main" && p.ticketId) return this.board.isRunning(slug, p.ticketId);
    return false;
  }

  /** Huddle agents mid-turn (or starting): a pending restart waits for them. */
  busy(): number {
    return [...this.runs.values()].filter((r) => !r.idle && !r.stopRequested).length;
  }

  /** Doing something now: an agent mid-turn, or a ticket session with a run (its own work or a huddle reply). */
  private working(slug: string, h: Huddle, p: HuddleParticipant): boolean {
    if (p.kind === "agent") {
      const run = this.runs.get(this.key(slug, h.id, p.handle));
      return !!run && !run.idle;
    }
    return this.isRunning(slug, h, p);
  }

  view(slug: string, h: Huddle): HuddleView {
    const msgs = h.status === "closed" ? [] : this.store.readHuddleMessages(slug, h.id);
    const since = userSeenSeq(h, msgs);
    const learningsPending = pendingLearnings(h).length;
    return {
      ...h,
      hostTitle: this.store.getTicket(slug, h.hostTicket)?.title ?? null,
      participants: h.participants.map(({ token: _t, ...p }) => {
        const running = this.isRunning(slug, h, p);
        // A ticket session's status is its ticket's run (unless it said it is done or blocked, or was stopped).
        const status = p.kind === "ticket-main" && (p.status === "idle" || p.status === "working") ? (running ? "working" : "idle") : p.status;
        const liveCostUsd = running ? this.turnCost(slug, h.id, p.handle) : 0;
        return { ...p, status, running, ...(liveCostUsd > 0 ? { liveCostUsd } : {}) };
      }),
      ...this.quiet(slug, h, msgs),
      forYou: msgs.filter((m) => isForYou(m, since)).length + learningsPending,
      forYouSince: since,
      learningsPending,
      summary: this.summaryOf(slug, h),
    };
  }

  /**
   * Each open huddle by host ticket, as "needs you" sees it (attention.ts): who is working, whether a wake is on its
   * way, and what waits for the user (tags since they last looked, pending learnings, a close request) since when.
   */
  hostStates(slug: string): Map<string, HostHuddle> {
    const out = new Map<string, HostHuddle>();
    for (const h of this.store.listHuddles(slug)) {
      if (h.status === "closed") continue;
      const msgs = this.store.readHuddleMessages(slug, h.id);
      const seen = userSeenSeq(h, msgs);
      const tagged = msgs.filter((m) => isForYou(m, seen));
      const learnings = pendingLearnings(h);
      const live = h.status === "live";
      const agents = h.participants.filter((p) => p.kind !== "human");
      const queued = live && agents.some((p) => {
        if (this.mainPending.has(this.key(slug, h.id, p.handle))) return true;
        const run = this.runs.get(this.key(slug, h.id, p.handle));
        return !!run && !run.stopRequested && (!run.handle || run.pending || run.again);
      });
      const times = [...tagged.map((m) => m.ts), ...learnings.map((l) => l.at), h.closeRequest?.at].filter((t): t is string => !!t);
      out.set(h.hostTicket, {
        working: live ? agents.filter((p) => this.working(slug, h, p)).length : 0,
        queued,
        tagged: tagged.length,
        learnings: learnings.length,
        closeRequest: !!h.closeRequest,
        since: times.length ? times.reduce((a, b) => (a < b ? a : b)) : null,
        latest: times.length ? times.reduce((a, b) => (a > b ? a : b)) : null,
      });
    }
    return out;
  }

  /** The huddle's summary file in the host's outputs: its own, or for a closed one the single file older huddles wrote. */
  private summaryOf(slug: string, h: Huddle): string | null {
    const dir = this.store.outputsPath(slug, h.hostTicket);
    if (existsSync(join(dir, summaryFile(h.id)))) return summaryFile(h.id);
    return h.status === "closed" && existsSync(join(dir, LEGACY_SUMMARY_FILE)) ? LEGACY_SUMMARY_FILE : null;
  }

  /** Live, nobody working, nobody with an unanswered tag and no open findings; idleSince: the last message or turn. */
  private quiet(slug: string, h: Huddle, msgs: HuddleMessage[]): { quiet: boolean; idleSince: string | null } {
    const no = { quiet: false, idleSince: null };
    const ps = h.participants.filter((p) => p.kind !== "human");
    if (h.status !== "live" || h.findings.some((f) => f.status === "open") || ps.some((p) => this.working(slug, h, p))) return no;
    if (ps.some((p) => msgs.some((m) => m.seq > p.cursor && this.wakes(h, p, m) === "mention"))) return no;
    const times = [msgs.at(-1)?.ts, ...ps.map((p) => p.idleAt)].filter((t): t is string => !!t);
    return { quiet: true, idleSince: times.length ? times.reduce((a, b) => (a > b ? a : b)) : h.createdAt };
  }

  /** What the agents of a ticket's huddles spent (see teammateSpend). */
  ticketSpend(slug: string, ticketId: string): { costUsd: number; huddles: HuddleTeammateSpend[] } {
    return teammateSpend(this.store.listHuddles(slug), ticketId);
  }

  list(slug: string, ticketId?: string): HuddleView[] {
    return this.store.listHuddles(slug)
      .filter((h) => !ticketId || h.hostTicket === ticketId || h.participants.some((p) => p.ticketId === ticketId))
      .map((h) => this.view(slug, h));
  }

  /** Messages, newest page first: `before` pages back, `since` reads forward from a seq. */
  messages(slug: string, hid: string, q: { before?: number; since?: number; limit?: number } = {}): { messages: HuddleMessage[]; hasMore: boolean } {
    this.get(slug, hid);
    const limit = Math.max(1, Math.min(500, q.limit ?? 100));
    let all = this.store.readHuddleMessages(slug, hid);
    if (q.since !== undefined) {
      all = all.filter((m) => m.seq > q.since!);
      return { messages: all.slice(0, limit), hasMore: all.length > limit };
    }
    if (q.before !== undefined) all = all.filter((m) => m.seq < q.before!);
    return { messages: all.slice(-limit), hasMore: all.length > limit };
  }

  /**
   * The participant a request comes from. The sender of everything is decided here, from the run's identity:
   * an agent proves who it is with its token, a ticket run is that ticket's session, no run header is the user.
   * hid "current": the caller's own huddle.
   */
  identify(slug: string, hid: string, who: Caller): { h: Huddle; me: HuddleParticipant } {
    if (who.agent) {
      const [aHid, handle, token] = who.agent.split("/");
      if (hid !== "current" && hid !== aHid) throw new HuddleError(403, `you are in huddle ${aHid}, not ${hid}`);
      const h = this.get(slug, aHid);
      const me = h.participants.find((p) => p.handle === handle && p.kind === "agent");
      if (!me || !token || me.token !== token) throw new HuddleError(403, "unknown huddle agent");
      if (who.run && who.run !== `${slug}/${h.hostTicket}`) throw new HuddleError(403, "huddle agents can only reach their own huddle");
      return { h, me };
    }
    if (who.run) {
      const [runSlug, ticketId] = who.run.split("/");
      if (runSlug !== slug || !ticketId) throw new HuddleError(403, `a run can only reach huddles on its own board (${runSlug})`);
      const mine = (h: Huddle) => h.participants.find((p) => p.kind === "ticket-main" && p.ticketId === ticketId);
      let h: Huddle | undefined;
      if (hid === "current") {
        // Its newest open huddle, preferring one it hosts.
        const open = this.store.listHuddles(slug).filter((x) => x.status !== "closed" && mine(x)).reverse();
        h = open.find((x) => x.hostTicket === ticketId) ?? open[0];
        if (!h) throw new HuddleError(404, `ticket ${ticketId} is in no open huddle`);
      } else h = this.get(slug, hid);
      const me = mine(h);
      if (!me) throw new HuddleError(403, `ticket ${ticketId} is not in huddle ${h.id}`);
      return { h, me };
    }
    if (hid === "current") throw new HuddleError(400, "pass a huddle id");
    const h = this.get(slug, hid);
    return { h, me: h.participants.find((p) => p.kind === "human")! };
  }

  // ---- Role presets ("teammates"): built-ins, the global huddle-presets.json and the board's (see layers.ts) ----

  presets(slug: string): HuddlePresetView[] {
    return mergePresets(this.store.listHuddlePresets(null), this.store.listHuddlePresets(slug));
  }

  private presetMap(slug: string): Map<string, HuddlePreset> {
    return new Map(this.presets(slug).map((p) => [p.name, p]));
  }

  /**
   * Add or change a preset at one level: "board" (default) or "global" (every board). A lower level's name overrides it.
   * Saving for every board drops this board's own version of it, so the saved one is what this board uses.
   * Only the user saves (the HTTP route refuses runs and huddle agents; they propose with propose_teammate).
   */
  savePreset(slug: string, input: unknown, level: unknown = "board"): HuddlePresetView {
    if (!this.store.getProfile(slug)) throw new HuddleError(404, `board ${slug} not found`);
    if (!isLevel(level)) throw new HuddleError(400, "scope must be board or global");
    const global = this.store.listHuddlePresets(null);
    const board = this.store.listHuddlePresets(slug);
    let r: ReturnType<typeof savePreset>;
    try {
      r = savePreset(level === "global" ? global : board, input, lowerLevels(BUILTIN_PRESETS, global, level));
    } catch (e) {
      throw new HuddleError(400, (e as Error).message);
    }
    this.store.saveHuddlePresets(level === "global" ? null : slug, r.list);
    if (level === "global" && board.some((p) => p.name === r.preset.name)) this.store.saveHuddlePresets(slug, board.filter((p) => p.name !== r.preset.name));
    return this.presets(slug).find((p) => p.name === r.preset.name)!;
  }

  /**
   * Delete a preset at one level (default: the level whose version is in effect); it falls back to the level below,
   * or goes away. Built-ins themselves can't be deleted.
   */
  deletePreset(slug: string, name: string, level?: unknown): { reset: boolean; presets: HuddlePresetView[] } {
    const lvl = this.levelOf(level, this.presets(slug).find((p) => p.name === presetName(name))?.source);
    const global = this.store.listHuddlePresets(null);
    let r: ReturnType<typeof deletePreset>;
    try {
      r = deletePreset(this.store.listHuddlePresets(lvl === "global" ? null : slug), name, lowerLevels(BUILTIN_PRESETS, global, lvl));
    } catch (e) {
      throw new HuddleError(/built-in/.test((e as Error).message) ? 409 : 404, (e as Error).message);
    }
    this.store.saveHuddlePresets(lvl === "global" ? null : slug, r.list);
    return { reset: r.reset, presets: this.presets(slug) };
  }

  /** The level a delete goes to: the one asked for, else the one in effect (a built-in: the board, which then says no). */
  private levelOf(level: unknown, source: string | undefined): Level {
    if (level !== undefined && level !== null && level !== "") {
      if (!isLevel(level)) throw new HuddleError(400, "scope must be board or global");
      return level;
    }
    return source === "global" ? "global" : "board";
  }

  // ---- Whole-huddle templates: built-ins, the global huddle-templates.json and the board's ----

  templates(slug: string): HuddleTemplateView[] {
    return mergeTemplates(this.store.listHuddleTemplates(null), this.store.listHuddleTemplates(slug));
  }

  /** Add or change a template at one level, like savePreset (a lower level's name overrides it). */
  saveTemplate(slug: string, input: unknown, level: unknown = "board"): HuddleTemplateView {
    if (!this.store.getProfile(slug)) throw new HuddleError(404, `board ${slug} not found`);
    if (!isLevel(level)) throw new HuddleError(400, "scope must be board or global");
    const global = this.store.listHuddleTemplates(null);
    const board = this.store.listHuddleTemplates(slug);
    let r: ReturnType<typeof saveTemplate>;
    try {
      r = saveTemplate(level === "global" ? global : board, input, this.presets(slug).map((p) => p.name), lowerLevels(BUILTIN_TEMPLATES, global, level));
    } catch (e) {
      throw new HuddleError(400, (e as Error).message);
    }
    this.store.saveHuddleTemplates(level === "global" ? null : slug, r.list);
    if (level === "global" && board.some((t) => t.name === r.template.name)) this.store.saveHuddleTemplates(slug, board.filter((t) => t.name !== r.template.name));
    return this.templates(slug).find((t) => t.name === r.template.name)!;
  }

  /** Delete a template at one level (default: the one in effect); it falls back to the level below. */
  deleteTemplate(slug: string, name: string, level?: unknown): { reset: boolean; templates: HuddleTemplateView[] } {
    const lvl = this.levelOf(level, this.templates(slug).find((t) => t.name === presetName(name))?.source);
    const global = this.store.listHuddleTemplates(null);
    let r: ReturnType<typeof deleteTemplate>;
    try {
      r = deleteTemplate(this.store.listHuddleTemplates(lvl === "global" ? null : slug), name, lowerLevels(BUILTIN_TEMPLATES, global, lvl));
    } catch (e) {
      throw new HuddleError(/built-in/.test((e as Error).message) ? 409 : 404, (e as Error).message);
    }
    this.store.saveHuddleTemplates(lvl === "global" ? null : slug, r.list);
    return { reset: r.reset, templates: this.templates(slug) };
  }

  /** How every teammate and template has been used, from the huddles on every board (closed ones included). */
  usage(): { teammates: Record<string, Usage>; templates: Record<string, Usage> } {
    return huddleUsage(this.store.listProfiles().flatMap((p) =>
      this.store.listHuddles(p.slug).map((h) => ({ board: p.slug, huddle: h, title: this.store.getTicket(p.slug, h.hostTicket)?.title ?? null }))));
  }

  // ---- Role notes (huddle-notes.ts): only the user writes them ----

  /** Every role's notes that exist on disk, general and this board's repo notes. */
  notes(slug: string): Record<string, RoleNotes> {
    if (!this.store.getProfile(slug)) throw new HuddleError(404, `board ${slug} not found`);
    const out: Record<string, RoleNotes> = {};
    for (const role of this.store.huddleNoteRoles(slug)) {
      if (noteRole(role) !== role) continue;
      out[role] = { general: this.store.readHuddleNotes(slug, role, "general"), repo: this.store.readHuddleNotes(slug, role, "repo") };
    }
    return out;
  }

  /** Replace a role's notes in one scope (the user added, edited or deleted lines in the Team tab). */
  setNotes(slug: string, role: string, scope: string, notes: unknown): HuddleNote[] {
    if (!this.store.getProfile(slug)) throw new HuddleError(404, `board ${slug} not found`);
    const r = noteRole(role);
    if (!r) throw new HuddleError(400, `"${role}" is not a role name`);
    if (scope !== "general" && scope !== "repo") throw new HuddleError(400, "scope must be general or repo");
    let ns: HuddleNote[];
    try {
      ns = cleanNotes(notes);
    } catch (e) {
      throw new HuddleError(400, (e as Error).message);
    }
    this.store.writeHuddleNotes(slug, r, scope, ns);
    return this.store.readHuddleNotes(slug, r, scope);
  }

  /** The "Lessons from past huddles" section for a new agent of `preset` (or an ad-hoc one: All-roles notes only). */
  lessonsFor(slug: string, preset: string | null): string {
    const read = (role: string): RoleNotes => ({ general: this.store.readHuddleNotes(slug, role, "general"), repo: this.store.readHuddleNotes(slug, role, "repo") });
    const role = preset && noteRole(preset) && preset !== ALL_ROLES ? preset : null;
    return lessonsSection(read(ALL_ROLES), role ? read(role) : null, role);
  }

  private addLearnings(slug: string, hid: string, p: HuddleParticipant, lessons: LessonInput[]) {
    const presets = this.presetMap(slug);
    // Default target: the agent's own role when it has one, else every role.
    const target = p.preset && p.preset !== MAIN_PRESET && presets.has(p.preset) ? p.preset : ALL_ROLES;
    const at = nowIso();
    this.update(slug, hid, (x) => {
      x.learnings ??= [];
      for (const l of lessons) {
        x.learnings.push({ id: `l${x.learnings.length + 1}`, from: p.handle, role: p.role, preset: p.preset ?? null, ...l, status: "pending", target, at });
      }
    });
  }

  private learning(h: Huddle, id: string): HuddleLearning {
    const l = (h.learnings ?? []).find((x) => x.id === id);
    if (!l) throw new HuddleError(404, `no learning ${id} in huddle ${h.id}`);
    if (l.status !== "pending") throw new HuddleError(409, `learning ${id} was already ${l.status}`);
    return l;
  }

  /** A pending learning with the user's changes (text, scope, target) applied and checked. */
  private patched(slug: string, l: HuddleLearning, patch: { text?: unknown; scope?: unknown; target?: unknown }): HuddleLearning {
    const out = { ...l };
    if (patch.text !== undefined) {
      const t = noteText(String(patch.text ?? ""));
      if (!t) throw new HuddleError(400, "the lesson's text is empty");
      if (t.length > NOTE_MAX) throw new HuddleError(400, `the lesson is ${t.length} characters, over the limit of ${NOTE_MAX}`);
      out.text = t;
    }
    if (patch.scope !== undefined) {
      if (patch.scope !== "general" && patch.scope !== "repo") throw new HuddleError(400, "scope must be general or repo");
      out.scope = patch.scope;
    }
    if (patch.target !== undefined && l.teammate) throw new HuddleError(400, "a proposed teammate is saved as itself; pick all boards or this board with scope");
    if (patch.target !== undefined) {
      const t = String(patch.target);
      if (t !== ALL_ROLES && t !== "new" && (t === MAIN_PRESET || !this.presetMap(slug).has(t))) {
        throw new HuddleError(400, `save to must be ${ALL_ROLES} (all roles), a role preset of this board, or new`);
      }
      if (t === "new" && l.preset) throw new HuddleError(400, `@${l.from} already has a role preset (${l.preset}); save to it instead`);
      out.target = t;
    }
    return out;
  }

  /** The user changes a pending learning before saving it: its text, scope or where it goes. */
  editLearning(slug: string, hid: string, id: string, patch: { text?: unknown; scope?: unknown; target?: unknown }): HuddleLearning {
    const next = this.patched(slug, this.learning(this.get(slug, hid), id), patch);
    this.update(slug, hid, (x) => void Object.assign(this.learning(x, id), next));
    return next;
  }

  /**
   * The user saves a learning as a role note: at the top of the target's notes file (general: every repo; repo: this
   * board), with where it came from. Target "new" first makes a board preset from the agent's ad-hoc role (its label
   * and prompt). Only the user gets here (the HTTP route refuses runs and huddle agents).
   */
  saveLearning(slug: string, hid: string, id: string, patch: { text?: unknown; scope?: unknown; target?: unknown } = {}): HuddleLearning {
    const h = this.get(slug, hid);
    const l = this.patched(slug, this.learning(h, id), patch);
    if (l.teammate) {
      // A proposed teammate: saved (or an existing one changed) for all boards (scope general) or this board (repo).
      const p = this.savePreset(slug, proposalPreset(l.teammate), l.scope === "general" ? "global" : "board");
      const saved: HuddleLearning = { ...l, status: "saved", target: p.name };
      this.update(slug, hid, (x) => void Object.assign(this.learning(x, id), saved));
      return saved;
    }
    let role = l.target;
    if (role === "new") {
      const p = h.participants.find((x) => x.handle === l.from);
      const name = presetName(l.role);
      if (!p || !name) throw new HuddleError(400, `can't make a role from "${l.role}"`);
      if (this.presetMap(slug).has(name)) throw new HuddleError(409, `a role "${name}" already exists; save the lesson to it instead`);
      this.savePreset(slug, { name, role: l.role, prompt: p.prompt, model: p.model, mode: p.mode, workspace: p.workspace, lead: false, canEdit: p.canEdit });
      role = name;
    }
    const scope: NoteScope = l.scope;
    const note: HuddleNote = { text: l.text, by: l.from, date: nowIso().slice(0, 10), huddle: h.id };
    this.store.writeHuddleNotes(slug, role, scope, [note, ...this.store.readHuddleNotes(slug, role, scope)]);
    const saved: HuddleLearning = { ...l, status: "saved", target: role, ...(l.target === "new" ? { newRole: true } : {}) };
    this.update(slug, hid, (x) => void Object.assign(this.learning(x, id), saved));
    return saved;
  }

  /**
   * A huddle agent proposes a teammate (propose_teammate): it waits under Learnings (scope general: all boards) until
   * the user saves or discards it. Nothing is saved here.
   */
  proposeTeammate(slug: string, hid: string, by: HuddleParticipant, input: unknown): HuddleLearning {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    if (by.kind !== "agent") throw new HuddleError(400, "only huddle agents propose teammates to the huddle; a ticket chat's propose_teammate shows a card in its chat");
    let t: TeammateProposal;
    try {
      t = teammateProposal(input);
    } catch (e) {
      throw new HuddleError(400, `${(e as Error).message}. Nothing was changed.`);
    }
    const waiting = pendingLearnings(h).filter((l) => l.from === by.handle && l.teammate).length;
    if (waiting >= MAX_PENDING_TEAMMATES) {
      throw new HuddleError(400, `you already have ${waiting} proposed teammates waiting for the user; at most ${MAX_PENDING_TEAMMATES} can wait at once. Nothing was changed.`);
    }
    let out!: HuddleLearning;
    this.update(slug, hid, (x) => {
      x.learnings ??= [];
      out = {
        id: `l${x.learnings.length + 1}`, from: by.handle, role: by.role, preset: by.preset ?? null, text: t.why, evidence: "", scope: "general",
        status: "pending", target: "new", at: nowIso(), teammate: t,
      };
      x.learnings.push(out);
    });
    const known = this.presets(slug).some((p) => p.name === t.name);
    this.system(slug, hid, `@${by.handle} proposed ${known ? `a change to teammate @${t.name}` : `a new teammate @${t.name}`}; the user reviews it under Learnings.`);
    return out;
  }

  /** The user discards a learning: it is never saved. */
  discardLearning(slug: string, hid: string, id: string): HuddleLearning {
    this.learning(this.get(slug, hid), id);
    let out!: HuddleLearning;
    this.update(slug, hid, (x) => {
      out = Object.assign(this.learning(x, id), { status: "discarded" as const });
    });
    return out;
  }

  // ---- Changing ----

  /** Read, change and save a huddle in one step (nothing else runs in between), then tell the UI. */
  private update(slug: string, hid: string, fn: (h: Huddle) => void): Huddle {
    const h = this.get(slug, hid);
    fn(h);
    h.updatedAt = nowIso();
    this.save(slug, h);
    this.bus.emit({ type: "huddle.updated", profile: slug, huddle: this.view(slug, h) });
    return h;
  }

  /** What an agent's turn in progress cost so far (≈); 0 between turns. */
  private turnCost(slug: string, hid: string, handle: string): number {
    const turn = this.runs.get(this.key(slug, hid, handle))?.turn;
    return turn ? [...turn.values()].reduce((a, b) => a + b, 0) : 0;
  }

  private updateP(slug: string, hid: string, handle: string, patch: Partial<HuddleParticipant>): void {
    if (!this.load(slug, hid)) return;
    // Only what it is doing now and its conversation size (many times a minute): saved, and sent as a small event
    // instead of the whole view.
    if (Object.keys(patch).every((k) => k === "lastActivity" || k === "contextTokens")) {
      const h = this.get(slug, hid);
      const p = h.participants.find((x) => x.handle === handle);
      const liveCostUsd = this.turnCost(slug, hid, handle);
      if (!p) return;
      const changed = (Object.keys(patch) as ("lastActivity" | "contextTokens")[]).some((k) => p[k] !== patch[k]);
      if (!changed && !liveCostUsd) return;
      if (changed) {
        Object.assign(p, patch);
        this.save(slug, h);
      }
      this.bus.emit({
        type: "huddle.activity", profile: slug, huddleId: hid, handle, lastActivity: p.lastActivity ?? null,
        ...(liveCostUsd ? { liveCostUsd } : {}), ...(p.contextTokens ? { contextTokens: p.contextTokens } : {}),
      });
      return;
    }
    this.update(slug, hid, (h) => {
      const p = h.participants.find((x) => x.handle === handle);
      if (p) Object.assign(p, patch);
    });
  }

  /** known: handles that can be mentioned (plus "all" when allowAll). System messages mention only `known`, given as is. */
  private append(slug: string, hid: string, from: string, text: string, kind: HuddleMessageKind, known: string[], allowAll = false, source?: HuddleSource): HuddleMessage {
    let seq = 0;
    this.update(slug, hid, (h) => {
      seq = h.seq = h.seq + 1;
      // The sender has seen everything up to its own message.
      const p = h.participants.find((x) => x.handle === from);
      if (p && p.cursor === seq - 1) p.cursor = seq;
    });
    const mentions = kind === "system" ? known : parseMentions(text).filter((m) => (m === "all" ? allowAll : known.includes(m)));
    const m: HuddleMessage = { id: `m_${newId()}`, seq, ts: nowIso(), from, text, mentions, kind, ...(source ? { source } : {}) };
    this.store.appendHuddleMessage(slug, hid, m);
    this.bus.emit({ type: "huddle.message", profile: slug, huddleId: hid, message: m });
    return m;
  }

  /** A system message: context only, except that `wake` (the brakes' warnings) are woken by it. */
  private system(slug: string, hid: string, text: string, wake: string[] = []): HuddleMessage {
    const m = this.append(slug, hid, "system", text, "system", wake);
    const h = this.get(slug, hid);
    if (h.status === "live") for (const p of h.participants) if (this.wakes(h, p, m)) this.wake(slug, h, p, true);
    return m;
  }

  /**
   * Start a huddle on a ticket from a roster (the user pressed Start on a proposed roster, or made one). template: a
   * template's name; its roster is used when `roster` is empty, its budget unless one is given, and its rules become
   * the pinned brief.
   */
  create(
    slug: string, hostId: string, roster: RosterEntry[],
    opts: { maxParticipants?: number; maxCostUsd?: number; template?: string; auto?: { reason: string; askedCostUsd?: number } } = {},
  ): Huddle {
    const host = this.store.getTicket(slug, hostId);
    if (!host) throw new HuddleError(404, `ticket ${hostId} not found`);
    if (host.error?.startsWith("corrupt")) throw new HuddleError(409, `ticket ${hostId} file is corrupt`);
    let tpl: HuddleTemplate | undefined;
    if (opts.template) {
      tpl = this.templates(slug).find((t) => t.name === opts.template!.trim());
      if (!tpl) throw new HuddleError(404, `no huddle template "${opts.template}" (templates: ${this.templates(slug).map((t) => t.name).join(", ")})`);
      if (!roster.length) roster = tpl.roster;
    }
    const max = Math.max(2, Math.min(32, Math.round(opts.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS)));
    if (opts.maxCostUsd !== undefined && !(Number.isFinite(opts.maxCostUsd) && opts.maxCostUsd > 0)) throw new HuddleError(400, "maxCostUsd must be a positive amount");
    const maxCostUsd = opts.maxCostUsd ?? tpl?.maxCostUsd ?? DEFAULT_MAX_COST_USD;
    const asked = opts.auto?.askedCostUsd;
    const budgetNote = opts.maxCostUsd === undefined ? (tpl?.maxCostUsd !== undefined ? " (template default)" : " (default)")
      : asked !== undefined && asked > maxCostUsd ? ` (asked ${money(asked)}, capped at ${money(maxCostUsd)})`
      : opts.auto ? " (asked by the ticket's run)" : "";
    const open = this.store.listHuddles(slug).find((h) => h.hostTicket === hostId && h.status !== "closed");
    if (open) throw new HuddleError(409, `ticket ${hostId} already has an open huddle (${open.id}); close it first`);
    const presets = this.presetMap(slug);
    const err = rosterError(roster, max, [...presets.keys()]);
    if (err) throw new HuddleError(400, err);
    const at = nowIso();
    const main = presets.get(MAIN_PRESET)!;
    const base = { prompt: "", focus: undefined, sessionId: null, status: "idle" as const, cursor: 0, joinedAt: at, workspace: "shared" as const, preset: null };
    const h: Huddle = {
      id: `h_${newId()}`, hostTicket: hostId, status: "live", maxParticipants: max, findings: [], invited: [], seq: 0,
      maxCostUsd, maxMessages: DEFAULT_MAX_MESSAGES, posts: 0, sinceUser: 0, stopReason: null, createdAt: at, updatedAt: at,
      template: tpl?.name ?? null, brief: tpl ? { text: templateBrief(tpl, maxCostUsd), by: USER_HANDLE, at } : null,
      ...(opts.auto ? { auto: { reason: opts.auto.reason } } : {}),
      participants: [
        { ...base, handle: USER_HANDLE, role: "User", model: null, mode: "monitor", lead: true, canEdit: false, kind: "human" },
        {
          ...base, handle: MAIN_HANDLE, role: main.role, preset: MAIN_PRESET, prompt: main.prompt, model: null, mode: main.mode, lead: true, canEdit: true,
          kind: "ticket-main", ticketId: hostId,
        },
      ],
    };
    const agents: HuddleParticipant[] = [];
    for (const e of roster) {
      const ps = this.expand(e, h.participants.map((p) => p.handle), presets);
      h.participants.push(...ps);
      agents.push(...ps);
    }
    this.save(slug, h);
    this.bus.emit({ type: "huddle.updated", profile: slug, huddle: this.view(slug, h) });
    this.system(slug, h.id, `${opts.auto ? "Auto huddle" : "Huddle"} started on ticket ${hostId} "${host.title}"${opts.auto ? ` by its own run (${opts.auto.reason})` : ""}${tpl ? ` from template ${tpl.label}` : ""} with ${agents.map((p) => `@${p.handle} (${p.role})`).join(", ")}. @main coordinates. Budget ${money(maxCostUsd)}${budgetNote}.`);
    for (const p of agents) this.kickoff(slug, h.id, p.handle);
    return this.get(slug, h.id);
  }

  // ---- Auto huddles: an unattended run reviews its own work before landing it (start_huddle) ----

  /**
   * An unattended run of the host ticket starts its own review huddle (the HTTP route checks the caller is that run).
   * Refused (403) when the board has auto huddles off, the run isn't unattended, it already started one, or the
   * ticket has an open huddle. While another auto huddle is live on the board, the ticket waits for the slot instead:
   * the card stays In Progress and freeSlot() wakes it when that one ends.
   */
  startAuto(
    slug: string, hostId: string, input: { reason: string; template?: string; roster?: RosterEntry[]; maxCostUsd?: number },
  ): { huddle: Huddle | null; waiting: boolean; template: string } {
    const profile = this.store.getProfile(slug);
    const host = this.store.getTicket(slug, hostId);
    if (!profile || !host) throw new HuddleError(404, `ticket ${hostId} not found`);
    const reason = input.reason.trim().replace(/\s+/g, " ").slice(0, 200);
    if (!reason) throw new HuddleError(400, "reason is required: one line on why this work needs a review huddle");
    const propose = "; use propose_huddle to propose one to the user instead";
    const asked = input.maxCostUsd;
    if (asked !== undefined && !(Number.isFinite(asked) && asked > 0)) throw new HuddleError(400, "maxCostUsd must be a positive amount");
    const maxCostUsd = asked === undefined ? undefined : Math.min(asked, AUTO_MAX_COST_USD);
    if (!autoHuddlesOn(profile)) throw new HuddleError(403, `auto huddles are off on board ${slug}${propose}`);
    if (!this.board.unattendedRun(slug, hostId)) {
      throw new HuddleError(403, `start_huddle only works in an unattended run of the ticket (Ready / In Progress work, a plan child, a schedule run), not in a chat${propose}`);
    }
    const open = this.store.listHuddles(slug).find((h) => h.hostTicket === hostId && h.status !== "closed");
    if (open) throw new HuddleError(409, `ticket ${hostId} already has an open huddle (${open.id})${propose}, or post in that one`);
    const template = input.template?.trim() || (input.roster?.length ? "" : host.important ? AUTO_REVIEW_IMPORTANT : AUTO_REVIEW);
    if (template && !this.templates(slug).some((t) => t.name === template)) {
      throw new HuddleError(404, `no huddle template "${template}" (templates: ${this.templates(slug).map((t) => t.name).join(", ")})`);
    }
    const busy = this.liveAuto(slug).find((h) => h.hostTicket !== hostId);
    if (busy) {
      const at = host.autoHuddle?.state === "waiting" ? host.autoHuddle.at : nowIso();
      this.board.setAutoHuddle(slug, hostId, { state: "waiting", reason, template: template || "custom", at, huddleId: null, ...(maxCostUsd !== undefined ? { maxCostUsd } : {}) });
      if (host.autoHuddle?.state !== "waiting") this.store.addComment(slug, hostId, "ai", `Auto huddle wanted (${reason}); waiting for huddle slot: ticket ${busy.hostTicket} has the board's auto huddle.`);
      return { huddle: null, waiting: true, template: template || "custom" };
    }
    if (!this.board.claimAutoHuddle(slug, hostId)) {
      throw new HuddleError(409, "this run already started an auto huddle (one per run); finish with the findings you have");
    }
    const h = this.create(slug, hostId, input.roster ?? [], { template: template || undefined, maxCostUsd, auto: { reason, askedCostUsd: asked } });
    if (this.slotWoken.get(slug) === hostId) this.slotWoken.delete(slug);
    this.board.setAutoHuddle(slug, hostId, { state: "live", reason, template: template || "custom", at: h.createdAt, huddleId: h.id });
    this.store.addComment(slug, hostId, "ai", `Auto huddle started (${template || "custom roster"}): ${reason}`);
    return { huddle: h, waiting: false, template: template || "custom" };
  }

  /** The board's live auto huddles (at most one, unless the user resumed a stopped one). */
  private liveAuto(slug: string): Huddle[] {
    return this.store.listHuddles(slug).filter((h) => h.auto && h.status === "live");
  }

  /**
   * An auto huddle ended. closed: by @main after landing, or because the host is done or deleted. halt: a brake
   * stopped it, so the host is woken to decide whether it may land. user: the user stopped or closed it; a host that
   * only waited for it goes to Review. Then the next ticket waiting for the slot gets it.
   */
  private autoEnded(slug: string, hid: string, how: "closed" | "halt" | "user", why: string) {
    const h = this.load(slug, hid);
    const t = h && this.store.getTicket(slug, h.hostTicket);
    if (h && t?.autoHuddle?.huddleId === hid) {
      const idle = t.status === "in_progress" && !this.board.isRunning(slug, t.id);
      if (how === "user" && idle) {
        this.store.addComment(slug, t.id, "ai", `Auto huddle ended: ${why}. The work was not landed.`);
        this.board.setAutoHuddle(slug, t.id, null, { status: "review", outcome: "stopped", lastActivity: null });
      } else this.board.setAutoHuddle(slug, t.id, null);
      if (how === "halt" && t.status !== "done") {
        const open = h.findings.filter((f) => f.status === "open").length;
        this.board.chat(slug, t.id, autoHuddleStoppedPrompt(h, why, open), { hostWake: true }).catch((e) => {
          this.store.addComment(slug, t.id, "ai", `Auto huddle stopped (${why}) and the ticket couldn't be woken: ${(e as Error).message}`);
        });
      }
    }
    queueMicrotask(() => this.freeSlot(slug));
  }

  /**
   * No auto huddle is live on the board: wake the ticket that has waited longest for the slot (one at a time; the
   * next one once that ticket's run is over). Also run after a restart.
   */
  freeSlot(slug: string): void {
    if (this.shuttingDown || this.board.isRestartPending() || this.liveAuto(slug).length) return;
    const woken = this.slotWoken.get(slug);
    if (woken) {
      const t = this.store.getTicket(slug, woken);
      if (t && (this.board.isRunning(slug, woken) || t.queued?.some((m) => m.state === "queued" && m.hostWake))) return;
      this.slotWoken.delete(slug);
    }
    const next = this.store.listTickets(slug)
      .filter((t) => t.autoHuddle?.state === "waiting" && t.status === "in_progress")
      .sort((a, b) => a.autoHuddle!.at.localeCompare(b.autoHuddle!.at))[0];
    if (!next) return;
    const a = next.autoHuddle!;
    this.slotWoken.set(slug, next.id);
    // It no longer waits: its run takes the slot with start_huddle, or lands without one.
    this.board.setAutoHuddle(slug, next.id, null, { lastActivity: "Huddle slot free: resuming" });
    this.board.chat(slug, next.id, autoHuddleSlotPrompt(a.reason, a.template, a.maxCostUsd), { hostWake: true }).catch((e) => {
      this.slotWoken.delete(slug);
      this.board.setAutoHuddle(slug, next.id, a);
      console.error(`couldn't wake ${slug}/${next.id} for the auto-huddle slot`, e);
    });
  }

  /** Participants made from one roster entry, with handles not in `taken`. */
  /** grant: the user is adding them, so the entry's lead and canEdit apply (see addParticipants). */
  private expand(e: RosterEntry, taken: string[], presets: Map<string, HuddlePreset>, grant = true): HuddleParticipant[] {
    const preset = e.preset ? presets.get(e.preset.trim()) : undefined;
    const count = e.count ?? 1;
    const base = handleBase(e.handle?.trim() || e.preset?.trim() || e.role!);
    const used = new Set([...taken, ...RESERVED_HANDLES]);
    const out: HuddleParticipant[] = [];
    for (let i = 0, n = 1; i < count; i++) {
      let handle = base;
      if (count > 1 || used.has(handle)) {
        while (used.has(`${base}-${n}`)) n++;
        handle = `${base}-${n}`;
      }
      used.add(handle);
      const workspace = e.workspace ?? preset?.workspace ?? "shared";
      const lead = grant && (e.lead ?? preset?.lead ?? false);
      // Leads watch every message: an entry made a lead without a mode is monitor; an explicit mode wins.
      const mode = e.mode ?? (lead && e.lead ? "monitor" : preset?.mode ?? (lead ? "monitor" : "tagged"));
      out.push({
        handle, role: e.role?.trim() || preset?.role || base, preset: e.preset?.trim() ?? null,
        prompt: [preset?.prompt, e.prompt?.trim()].filter(Boolean).join("\n\n") || `Help with the ticket as ${e.role}.`,
        ...(e.focus?.trim() ? { focus: e.focus.trim() } : {}),
        model: e.model?.trim() || preset?.model || null, mode, lead,
        // Only an agent in its own worktree may edit: the shared worktree is the coordinator's.
        canEdit: grant && workspace === "own" && (e.canEdit ?? preset?.canEdit ?? true), workspace, sessionId: null, status: "idle", kind: "agent", cursor: 0, joinedAt: nowIso(), token: newId() + newId(),
      });
    }
    return out;
  }

  private nonHuman(h: Huddle): number {
    return h.participants.filter((p) => p.kind !== "human").length;
  }

  private assertOpen(h: Huddle) {
    if (h.status === "closed") throw new HuddleError(409, `huddle ${h.id} is closed (read-only)`);
  }

  /** Add participants (the user, the coordinator or a lead); refused once maxParticipants is reached. */
  addParticipants(slug: string, hid: string, by: HuddleParticipant, e: RosterEntry): HuddleParticipant[] {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    if (!canManage(h, by)) throw new HuddleError(403, `only a lead or @main can add participants; ask them (or the user) in the huddle`);
    const presets = this.presetMap(slug);
    const err = rosterEntryError(e, "", [...presets.keys()]);
    if (err) throw new HuddleError(400, err);
    const want = e.count ?? 1;
    const room = h.maxParticipants - this.nonHuman(h);
    if (want > room) {
      throw new HuddleError(409, `the huddle is full: ${this.nonHuman(h)} of ${h.maxParticipants} participants${room > 0 ? `, room for ${room} more` : ""}. ` +
        "Don't work around the limit: ask the user (tag @you) to raise it or stop someone.");
    }
    // Only the user hands out rights: participants an agent or @main adds can't manage the huddle or edit files.
    const added = this.expand(e, h.participants.map((p) => p.handle), presets, by.kind === "human");
    this.update(slug, hid, (x) => {
      x.participants.push(...added);
    });
    this.system(slug, hid, `@${by.handle} added ${added.map((p) => `@${p.handle} (${p.role}${p.focus ? `: ${p.focus}` : ""})`).join(", ")}.`);
    if (h.status === "live") for (const p of added) this.kickoff(slug, hid, p.handle);
    return added;
  }

  /** Invite another ticket's own session (same board), e.g. as @api-main. */
  invite(slug: string, hid: string, by: HuddleParticipant, ticketId: string, handle?: string): HuddleParticipant {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    if (by.kind !== "human" && !isCoordinator(h, by)) throw new HuddleError(403, "only the user or @main can invite tickets");
    const t = this.store.getTicket(slug, ticketId);
    if (!t) throw new HuddleError(404, `ticket ${ticketId} not found`);
    if (h.participants.some((p) => p.ticketId === ticketId)) throw new HuddleError(409, `ticket ${ticketId} is already in this huddle`);
    if (this.nonHuman(h) >= h.maxParticipants) throw new HuddleError(409, `the huddle is full (${h.maxParticipants} participants)`);
    const base = handleBase(handle?.trim() || `${t.planKey || t.title.split(/\s+/)[0] || "ticket"}-main`);
    const taken = new Set([...h.participants.map((p) => p.handle), ...RESERVED_HANDLES]);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    const p: HuddleParticipant = {
      handle: name, role: `Ticket ${t.id} "${t.title}"`, preset: null, prompt: "", model: null, mode: "tagged", lead: false, canEdit: false,
      workspace: "shared", sessionId: null, status: "idle", kind: "ticket-main", ticketId, cursor: h.seq, joinedAt: nowIso(),
    };
    this.update(slug, hid, (x) => {
      x.participants.push(p);
      x.invited.push(ticketId);
    });
    this.system(slug, hid, `@${by.handle} invited ticket ${t.id} "${t.title}" as @${name}.`);
    return p;
  }

  setMode(slug: string, hid: string, by: HuddleParticipant, handle: string, mode: HuddleMode): HuddleParticipant {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    if (by.kind !== "human" && by.handle !== handle) throw new HuddleError(403, "you can only change your own mode");
    const p = h.participants.find((x) => x.handle === handle && x.kind !== "human");
    if (!p) throw new HuddleError(404, `no participant @${handle}`);
    if (mode !== "tagged" && mode !== "monitor") throw new HuddleError(400, "mode must be tagged or monitor");
    if (p.mode === mode) return p;
    this.updateP(slug, hid, handle, { mode });
    // A monitor session no longer needs to stay open between turns.
    if (mode === "tagged") this.runs.get(this.key(slug, hid, handle))?.handle?.endWhenIdle();
    this.system(slug, hid, `@${handle} switched to ${mode} mode${by.handle !== handle ? ` (by @${by.handle})` : ""}.`);
    return { ...p, mode };
  }

  /** The pinned findings list: leads and the coordinator add and resolve; everyone can list. */
  findings(slug: string, hid: string, by: HuddleParticipant, action: "add" | "resolve" | "list", arg: { text?: string; id?: string } = {}): HuddleFinding[] {
    const h = this.get(slug, hid);
    if (action === "list") return h.findings;
    this.assertOpen(h);
    if (!canManage(h, by)) throw new HuddleError(403, "only a lead or @main can change the findings list; post your finding to your lead instead");
    if (action === "add") {
      const text = arg.text?.trim();
      if (!text) throw new HuddleError(400, "text is required");
      const f: HuddleFinding = { id: `f${h.findings.length + 1}`, text, by: by.handle, status: "open", resolvedBy: null, at: nowIso() };
      this.update(slug, hid, (x) => void x.findings.push(f));
      this.system(slug, hid, `@${by.handle} pinned finding ${f.id}: ${findingTitle(text)}`);
    } else if (action === "resolve") {
      const f = h.findings.find((x) => x.id === arg.id);
      if (!f) throw new HuddleError(404, `no finding ${arg.id}`);
      if (f.status === "resolved") return h.findings;
      this.update(slug, hid, (x) => {
        const g = x.findings.find((y) => y.id === arg.id)!;
        Object.assign(g, { status: "resolved", resolvedBy: by.handle });
      });
      this.system(slug, hid, `@${by.handle} resolved finding ${f.id}.`);
    } else throw new HuddleError(400, "action must be add, resolve or list");
    return this.get(slug, hid).findings;
  }

  /**
   * Post a message as `by` (the daemon decided who that is) and route it. status: the sender is done or blocked
   * (reason) with this message, as with setStatus.
   */
  post(
    slug: string, hid: string, by: HuddleParticipant, text: string, kind: HuddleMessageKind = "message",
    status?: { status: StatusChange; reason?: string; lessons?: unknown }, source?: HuddleSource,
  ): HuddleMessage {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    if (!text.trim()) throw new HuddleError(400, "text is required");
    const len = text.trim().length;
    if (len > POST_MAX) {
      throw new HuddleError(400, `your message is ${len} characters, over the huddle's limit of ${POST_MAX}. Nothing was posted. ` +
        "Shorten it, split it into a few messages, or put the details in a file in your outputs folder and post its path.");
    }
    if (kind !== "message" && kind !== "finding") throw new HuddleError(400, "kind must be message or finding");
    if (by.status === "stopped" && by.kind !== "human") throw new HuddleError(409, `@${by.handle} was stopped by the user`);
    if (status) this.checkLessons(h, by, status.status, status.lessons);
    if (status) this.checkStatus(by, status.status, status.reason);
    const m = this.append(slug, hid, by.handle, text.trim(), kind, h.participants.map((p) => p.handle), canManage(h, by), source);
    // Stopped: the log keeps it; Resume wakes whoever it tags (wakeIfOwed).
    if (h.status === "live" && this.brakes(slug, hid, by, m)) this.route(slug, hid, m);
    if (status) this.setStatus(slug, hid, by, status.status, status.reason, status.lessons);
    return m;
  }

  /** Set (or clear, with "") the pinned brief: the goal and decisions so far, at the head of every digest. Leads, @main and the user. */
  setBrief(slug: string, hid: string, by: HuddleParticipant, text: string): Huddle {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    if (!canManage(h, by)) throw new HuddleError(403, "only a lead, @main or the user can change the brief; suggest the change to your lead");
    const t = text.trim();
    if (t.length > BRIEF_MAX) throw new HuddleError(400, `the brief is ${t.length} characters, over the limit of ${BRIEF_MAX}; keep only the goal and the decisions`);
    if ((h.brief?.text ?? "") === t) return h;
    this.update(slug, hid, (x) => void (x.brief = t ? { text: t, by: by.handle, at: nowIso() } : null));
    this.system(slug, hid, t ? `@${by.handle} updated the pinned brief.` : `@${by.handle} cleared the pinned brief.`);
    return this.get(slug, hid);
  }

  private checkStatus(by: HuddleParticipant, status: StatusChange, reason?: string) {
    if (by.kind === "human") throw new HuddleError(400, "the user has no huddle status");
    if (status !== "done" && status !== "blocked" && status !== "active") throw new HuddleError(400, "status must be done, blocked or active");
    if (status === "blocked" && !reason?.trim()) throw new HuddleError(400, "say what blocks you (reason)");
  }

  /** Lessons proposed with a status change, checked: only an agent turning done, at most MAX_LESSONS, each a short rule. */
  private checkLessons(h: Huddle, by: HuddleParticipant, status: StatusChange, lessons: unknown): LessonInput[] {
    let out: LessonInput[];
    try {
      out = cleanLessons(lessons);
    } catch (e) {
      throw new HuddleError(400, `${(e as Error).message}. Nothing was changed.`);
    }
    if (!out.length) return out;
    if (status !== "done") throw new HuddleError(400, "lessons go with status done, when your job is finished");
    if (by.kind !== "agent") throw new HuddleError(400, "only huddle agents propose lessons");
    const waiting = pendingLearnings(h).filter((l) => l.from === by.handle && !l.teammate).length;
    if (waiting + out.length > MAX_PENDING) {
      throw new HuddleError(400, `you already have ${waiting} lesson${waiting === 1 ? "" : "s"} waiting for the user; at most ${MAX_PENDING} can wait at once. Nothing was changed.`);
    }
    return out;
  }

  /**
   * A participant says it is done (only a lead, @main or the user wakes it again; a lead wakes on any tag), blocked on something (@main is
   * tagged; @you when @main itself is blocked), or active again. lessons (agents turning done): proposed for the
   * user to review; they become role notes only when the user saves them.
   */
  setStatus(slug: string, hid: string, by: HuddleParticipant, status: StatusChange, reason?: string, lessons?: unknown): HuddleParticipant {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    const proposed = this.checkLessons(h, by, status, lessons);
    this.checkStatus(by, status, reason);
    const p = h.participants.find((x) => x.handle === by.handle)!;
    if (p.status === "stopped") throw new HuddleError(409, `@${p.handle} was stopped by the user`);
    const why = reason?.trim() || null;
    if (status === "active") {
      if (!settled(p)) return p;
      this.updateP(slug, hid, p.handle, { status: this.working(slug, h, p) ? "working" : "idle", statusReason: null });
      this.system(slug, hid, `@${p.handle} is active again.`);
    } else {
      this.updateP(slug, hid, p.handle, { status, statusReason: why });
      if (proposed.length) this.addLearnings(slug, hid, p, proposed);
      const n = proposed.length;
      const learned = n ? `${why ? "." : ""} It proposed ${n} lesson${n === 1 ? "" : "s"} for future huddles; the user reviews ${n === 1 ? "it" : "them"} under Learnings.` : "";
      if (status === "done") this.system(slug, hid, `@${p.handle} is done${why ? `: ${why}` : "."}${learned}`);
      else this.system(slug, hid, `@${p.handle} is blocked: ${why}`, [isCoordinator(h, p) ? USER_HANDLE : MAIN_HANDLE]);
    }
    return this.get(slug, hid).participants.find((x) => x.handle === p.handle)!;
  }

  /**
   * @main or a lead asks the user to close the huddle, once it has written the summary into the host ticket's
   * outputs. Only the user closes it.
   */
  requestClose(slug: string, hid: string, by: HuddleParticipant, reason: string): Huddle {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    if (!canManage(h, by)) throw new HuddleError(403, "only @main or a lead can ask to close the huddle; tell your lead you are done (huddle_status done)");
    const summary = join(this.store.outputsDir(slug, h.hostTicket), summaryFile(hid));
    if (!existsSync(summary)) {
      throw new HuddleError(409, `write the huddle summary first: ${summary} (what was decided, the findings and their state, what is left to do), then call huddle_close again`);
    }
    const why = reason.trim() || "the work is done";
    // An auto huddle runs while the user is away: its coordinator closes it itself.
    if (h.auto && isCoordinator(h, by)) return this.close(slug, hid, `closed by @main (${why})`);
    this.update(slug, hid, (x) => void (x.closeRequest = { by: by.handle, at: nowIso(), reason: why }));
    this.system(slug, hid, `@${by.handle} asks to close the huddle: ${why}. The summary is in the host ticket's outputs (${summaryFile(hid)}). @you: press Close huddle to end it; only you can close it.`, [USER_HANDLE]);
    return this.get(slug, hid);
  }

  /** Counts a new message against the huddle's limits; false when routing just stopped or paused. */
  private brakes(slug: string, hid: string, by: HuddleParticipant, m: HuddleMessage): boolean {
    const h = this.update(slug, hid, (x) => {
      x.posts = (x.posts ?? 0) + 1;
      x.sinceUser = by.kind === "human" ? 0 : (x.sinceUser ?? 0) + 1;
      // A lead, @main or the user tagging a held pair settles it.
      if (x.held?.length && !x.held.includes(by.handle) && canManage(x, by) && x.held.some((p) => m.mentions.includes(p) || m.mentions.includes("all"))) x.held = null;
    });
    const max = h.maxMessages ?? DEFAULT_MAX_MESSAGES;
    if ((h.posts ?? 0) >= max) {
      this.halt(slug, hid, "messages", `The huddle reached its limit of ${max} messages and stopped; every run was stopped. @you: read what came out and resume if more is needed.`);
      return false;
    }
    if ((h.sinceUser ?? 0) >= AGENT_ONLY_MAX) {
      this.halt(slug, hid, "loop", `${AGENT_ONLY_MAX} messages went by without you, so routing is paused (runs finish what they are doing). @you: check the huddle is on track and resume it.`);
      return false;
    }
    this.pingPong(slug, hid);
    return true;
  }

  /** The last PING_PONG messages went back and forth between the same two participants: they stop waking each other. */
  private pingPong(slug: string, hid: string) {
    const h = this.get(slug, hid);
    const last = this.store.readHuddleMessages(slug, hid).filter((m) => m.kind !== "system").slice(-PING_PONG);
    if (last.length < PING_PONG) return;
    const pair = [...new Set(last.map((m) => m.from))];
    if (pair.length !== 2 || pair.includes(USER_HANDLE) || last.some((m, i) => i && m.from === last[i - 1].from)) return;
    if (h.held && pair.every((x) => h.held!.includes(x))) return;
    const leads = h.participants.filter((p) => p.lead && p.kind !== "human" && p.status !== "stopped" && !pair.includes(p.handle)).map((p) => p.handle);
    const tag = leads.length ? leads : [USER_HANDLE];
    this.update(slug, hid, (x) => void (x.held = pair));
    this.system(slug, hid,
      `@${pair[0]} and @${pair[1]} answered each other ${PING_PONG} times in a row, so they no longer wake each other. ` +
      `${tag.map((x) => `@${x}`).join(" ")}: settle it, or tag them with what to do next.`, tag);
  }

  /** The huddle stops by itself (see HuddleStopReason). budget and messages stop every huddle run too; loop only pauses routing. */
  private halt(slug: string, hid: string, reason: HuddleStopReason, text: string) {
    const h = this.get(slug, hid);
    // The budget also stops a huddle whose routing was only paused.
    if (h.status === "closed" || (h.status !== "live" && reason !== "budget") || h.stopReason === reason) return;
    const hard = reason !== "loop";
    if (hard) for (const p of h.participants) if (p.kind !== "human") this.stopParticipantRun(slug, h, p);
    this.update(slug, hid, (x) => {
      x.status = "stopped";
      x.stopReason = reason;
      if (hard) for (const p of x.participants) if (p.kind === "agent") p.status = "stopped";
    });
    this.system(slug, hid, text, [USER_HANDLE]);
    if (h.auto) this.autoEnded(slug, hid, "halt", reason === "budget" ? "it hit its budget cap" : reason === "messages" ? "it hit its message limit" : "its agents kept answering each other, so routing paused");
  }

  /** After a cost update: warn the leads at 80% of the budget, stop at 100%. */
  private checkBudget(slug: string, hid: string) {
    const h = this.load(slug, hid);
    if (!h || h.status === "closed") return;
    const max = h.maxCostUsd ?? DEFAULT_MAX_COST_USD;
    const spent = huddleCost(h);
    if (spent >= max) {
      this.halt(slug, hid, "budget", `The huddle spent ${money(spent)} of its ${money(max)} budget and stopped; every run was stopped. @you: resume it with more budget if it should go on.`);
      return;
    }
    if (spent >= max * BUDGET_WARN && !h.budgetWarned) {
      this.update(slug, hid, (x) => void (x.budgetWarned = true));
      const leads = h.participants.filter((p) => p.lead && p.kind !== "human" && p.status !== "stopped").map((p) => p.handle);
      this.system(slug, hid,
        `${leads.map((x) => `@${x}`).join(" ")}${leads.length ? ": t" : "T"}he huddle has spent ${money(spent)} of its ${money(max)} budget (${Math.round((spent / max) * 100)}%). ` +
        "Wrap up: send the consolidated findings now and only start what is needed; at 100% every run stops.", leads);
    }
  }

  private route(slug: string, hid: string, m: HuddleMessage) {
    const h = this.get(slug, hid);
    const unwoken: HuddleParticipant[] = [];
    for (const p of h.participants) {
      const w = this.wakes(h, p, m);
      if (w) this.wake(slug, h, p, w === "mention");
      else if (m.mentions.includes(p.handle) && p.kind !== "human" && p.handle !== m.from) unwoken.push(p);
    }
    for (const p of unwoken) this.noteUnwoken(slug, hid, p, m.from);
  }

  /**
   * A tag didn't wake its target because it is done, blocked or stopped: say so in a system note that tags @main (the
   * user, when the target is @main), once per target and sender until the target wakes. A held pair already has a note.
   */
  private noteUnwoken(slug: string, hid: string, p: HuddleParticipant, from: string) {
    const h = this.get(slug, hid);
    const cur = h.participants.find((x) => x.handle === p.handle);
    if (!cur || (!settled(cur) && cur.status !== "stopped") || from === USER_HANDLE) return;
    if (h.held?.includes(p.handle) && h.held.includes(from)) return;
    if (h.unwoken?.[p.handle]?.includes(from)) return;
    this.update(slug, hid, (x) => {
      x.unwoken ??= {};
      x.unwoken[p.handle] = [...(x.unwoken[p.handle] ?? []), from];
    });
    const to = p.handle === MAIN_HANDLE ? USER_HANDLE : MAIN_HANDLE;
    const who = cur.status === "stopped" ? "only the user can restart it" : `@${to} or a lead can wake it`;
    this.system(slug, hid, `@${p.handle} is ${cur.status} and wasn't woken by @${from}'s tag; ${who}.`, [to]);
  }

  /**
   * Whether a message wakes a participant: "mention" (tagged, or a system message naming it), "monitor" (it sees
   * every message) or null. Done: a lead wakes on a direct tag from anyone and, in monitor mode, on a non-lead's
   * message; anyone else only on a tag from a lead, @main or the user (or the brakes). Blocked: only a tag.
   */
  private wakes(h: Huddle, p: HuddleParticipant, m: HuddleMessage): "mention" | "monitor" | null {
    if (p.kind === "human" || m.from === p.handle || p.status === "stopped") return null;
    // A held pair doesn't wake each other.
    const held = h.held ?? [];
    if (held.includes(p.handle) && held.includes(m.from)) return null;
    const mentioned = m.mentions.includes(p.handle) || m.mentions.includes("all");
    if (m.kind === "system") return mentioned ? "mention" : null;
    if (p.status === "done") {
      const from = h.participants.find((x) => x.handle === m.from);
      // @all only reaches mentions when a lead, @main or the user sent it.
      if (mentioned && from && canManage(h, from)) return "mention";
      if (!p.lead) return null;
      if (m.mentions.includes(p.handle)) return "mention";
      return p.mode === "monitor" && from && !canManage(h, from) ? "monitor" : null;
    }
    if (mentioned) return "mention";
    return p.mode === "monitor" && p.status !== "blocked" ? "monitor" : null;
  }

  /** Wake a participant; being woken ends done or blocked, and its unwoken-tag notes start over. */
  private wake(slug: string, h: Huddle, p: HuddleParticipant, mentioned: boolean) {
    if (settled(p)) this.updateP(slug, h.id, p.handle, { status: "idle", statusReason: null });
    if (this.get(slug, h.id).unwoken?.[p.handle]) this.update(slug, h.id, (x) => void delete x.unwoken![p.handle]);
    this.deliver(slug, h, p, mentioned);
  }

  /**
   * The idle watchdog (see the header): wakes @main in each live huddle that has sat idle for HUDDLE_IDLE_MS since
   * someone other than @main or the user spoke last. now: for tests.
   */
  idleSweep(now = Date.now()): void {
    if (this.shuttingDown || this.board.isRestartPending()) return;
    for (const profile of this.store.listProfiles()) {
      for (const h of this.store.listHuddles(profile.slug)) {
        if (h.status === "live") this.idleCheck(profile.slug, h.id, now);
      }
    }
  }

  private idleCheck(slug: string, hid: string, now: number) {
    const h = this.load(slug, hid);
    if (!h || h.status !== "live") return;
    const msgs = this.store.readHuddleMessages(slug, hid);
    const last = msgs.findLast((m) => m.kind !== "system");
    if (!last || last.from === MAIN_HANDLE || last.from === USER_HANDLE || last.seq <= (h.idleNudged ?? 0)) return;
    const times = [h.updatedAt, msgs.at(-1)?.ts, ...h.participants.map((p) => p.idleAt)].filter((t): t is string => !!t).map((t) => Date.parse(t));
    if (now - Math.max(...times) < HUDDLE_IDLE_MS) return;
    const ps = h.participants.filter((p) => p.kind !== "human");
    if (ps.some((p) => this.working(slug, h, p) || this.mainPending.has(this.key(slug, hid, p.handle)))) return;
    for (const p of ps) {
      const run = this.runs.get(this.key(slug, hid, p.handle));
      if (run && (run.pending || run.again || run.refreshing)) return;
      if (msgs.some((m) => m.seq > p.cursor && this.wakes(h, p, m))) return;
    }
    this.update(slug, hid, (x) => void (x.idleNudged = last.seq));
    const mins = Math.round(HUDDLE_IDLE_MS / 60_000);
    this.system(slug, hid, `Huddle idle for ${mins} min since #${last.seq} (last: @${last.from}). Check who should act, or ask the user to close it.`, [MAIN_HANDLE]);
  }

  /** Start the idle watchdog's sweep (the daemon, after recover()). */
  startWatchdog(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      try {
        this.idleSweep();
      } catch (e) {
        console.error("huddle idle sweep failed", e);
      }
    }, IDLE_SWEEP_MS);
    this.sweeper.unref?.();
  }

  /**
   * Deliver a wake that was owed but never happened: messages that tag the participant (or, in monitor mode, any
   * new ones) after its cursor. Run on Resume and after a restart, so nothing posted while the huddle was stopped
   * or the daemon was going down is lost. A monitor ticket session's pending messages come back this way too.
   */
  private wakeIfOwed(slug: string, hid: string, handle: string) {
    const h = this.load(slug, hid);
    const p = h?.participants.find((x) => x.handle === handle);
    if (!h || !p || h.status !== "live") return;
    let owed: "mention" | "monitor" | null = null;
    for (const m of this.store.readHuddleMessages(slug, hid)) {
      if (m.seq <= p.cursor) continue;
      const w = this.wakes(h, p, m);
      if (w === "mention") {
        owed = w;
        break;
      }
      owed ??= w;
    }
    if (owed) this.wake(slug, h, p, owed === "mention");
  }

  /**
   * Unread messages for a participant as one digest, and moves its cursor past them. Null when there is nothing
   * to act on (only system messages, unless withSystem). undo: put the cursor back (the digest never arrived).
   */
  private takeUnread(slug: string, hid: string, handle: string, withSystem = false): { digest: string; tagged: boolean; undo: () => void } | null {
    const h = this.get(slug, hid);
    const p = h.participants.find((x) => x.handle === handle);
    if (!p) return null;
    const unread = this.store.readHuddleMessages(slug, hid).filter((m) => m.seq > p.cursor && m.from !== handle);
    const prev = p.cursor;
    if (p.cursor !== h.seq) this.updateP(slug, hid, handle, { cursor: h.seq });
    // A system message only counts when it tags this participant (the brakes' warnings).
    const tags = (m: HuddleMessage) => m.mentions.includes(handle) || m.mentions.includes("all");
    if (!unread.length || (!withSystem && !unread.some((m) => m.kind !== "system" || tags(m)))) return null;
    const shown = unread.slice(-DIGEST_MAX);
    return { digest: huddleDigest(shown, unread.length - shown.length, h.brief), tagged: unread.some(tags), undo: () => this.updateP(slug, hid, handle, { cursor: prev }) };
  }

  private deliver(slug: string, h: Huddle, p: HuddleParticipant, mentioned: boolean) {
    if (p.kind === "ticket-main") {
      // Monitor: one message with everything once its current run is over, not a steer per message.
      if (!mentioned && p.ticketId && this.board.isRunning(slug, p.ticketId)) {
        this.mainPending.add(this.key(slug, h.id, p.handle));
        return;
      }
      return this.deliverNow(slug, h.id, p.handle);
    }
    const run = this.runs.get(this.key(slug, h.id, p.handle));
    if (run) {
      // Mid-turn: a mention steers it now; for a monitor the rest waits for the turn boundary.
      if (!mentioned && !run.idle) {
        run.pending = true;
        return;
      }
      return this.deliverNow(slug, h.id, p.handle);
    }
    this.deliverNow(slug, h.id, p.handle);
  }

  /** Hand the participant everything it hasn't read: into its live run, a ticket chat message, or a new run. */
  private deliverNow(slug: string, hid: string, handle: string) {
    const h = this.load(slug, hid);
    const p = h?.participants.find((x) => x.handle === handle);
    if (!h || !p || h.status !== "live" || p.status === "stopped" || p.status === "done" || this.shuttingDown) return;
    if (p.kind === "ticket-main") {
      const u = p.ticketId ? this.takeUnread(slug, hid, handle) : null;
      if (!u) return;
      this.mainWoken.set(`${slug}/${p.ticketId}`, { hid, handle });
      // Its own auto huddle wakes the host as unattended work on the ticket (it ends with a result line and lands).
      const own = this.store.getTicket(slug, p.ticketId!)?.autoHuddle;
      const hostWake = !!h.auto && isCoordinator(h, p) && own?.state === "live" && own.huddleId === h.id;
      this.board.chat(slug, p.ticketId!, huddleMainPrompt(h, p, u.digest, this.board.committed(slug)), hostWake ? { hostWake } : { peer: true }).catch((e) => {
        u.undo();
        this.system(slug, hid, `Couldn't reach @${handle}: ${(e as Error).message}`);
      });
      return;
    }
    const run = this.runs.get(this.key(slug, hid, handle));
    if (run) {
      if (run.stopRequested) return;
      // Still starting (worktree, setup): it gets them at its first turn boundary.
      if (!run.handle) {
        run.pending = true;
        return;
      }
      // Between turns, a snapshot agent sees the host's latest commit first. Mid-turn its files stay put.
      if (run.idle && isSnapshot(p) && !run.fresh) {
        if (run.refreshing) return;
        run.refreshing = this.workspace(slug, h, p)
          .then(() => {}, (e) => {
            if (!run.stopRequested) this.system(slug, hid, `Couldn't refresh @${handle}'s snapshot: ${(e as Error).message}`);
          })
          .finally(() => {
            run.refreshing = null;
            run.fresh = true;
            this.deliverNow(slug, hid, handle);
          });
        this.chore(run.refreshing);
        return;
      }
      if (run.refreshing) return;
      run.fresh = false;
      run.pending = false;
      const u = this.takeUnread(slug, hid, handle);
      if (!u) return;
      const cur = this.get(slug, hid).participants.find((x) => x.handle === handle)!;
      if (run.handle?.send(huddleAgentPrompt("wake", cur, u.digest, u.tagged, isSnapshot(cur) ? cur.snapshot : null))) {
        if (run.idle && !settled(p)) this.updateP(slug, hid, handle, { status: "working" });
        run.idle = false;
      } else {
        // Input is closing (the run is finishing): a new run picks them up.
        u.undo();
        run.again = true;
      }
      return;
    }
    // Before taking the unread messages: recover() hands them over after the restart.
    if (this.holdForRestart(slug, hid, handle)) return;
    const u = this.takeUnread(slug, hid, handle);
    if (u) this.runAgent(slug, hid, handle, huddleAgentPrompt("wake", p, u.digest, u.tagged));
  }

  /** A restart is pending: no new agent run starts; the agent is marked so recover() starts it after the restart. */
  private holdForRestart(slug: string, hid: string, handle: string): boolean {
    if (!this.board.isRestartPending()) return false;
    this.updateP(slug, hid, handle, { interrupted: true, lastActivity: "Waiting for the board to restart" });
    return true;
  }

  /** An agent's first run: start on its job with what was said so far. */
  private kickoff(slug: string, hid: string, handle: string) {
    if (this.holdForRestart(slug, hid, handle)) return;
    const p = this.get(slug, hid).participants.find((x) => x.handle === handle)!;
    this.runAgent(slug, hid, handle, huddleAgentPrompt("start", p, this.takeUnread(slug, hid, handle, true)?.digest ?? ""));
  }

  private runAgent(slug: string, hid: string, handle: string, input: string) {
    const key = this.key(slug, hid, handle);
    if (this.runs.has(key) || this.shuttingDown || this.holdForRestart(slug, hid, handle)) return;
    const run: AgentRun = { handle: null, promise: Promise.resolve(), idle: false, pending: false, again: false, stopRequested: false };
    this.runs.set(key, run);
    const cur = this.get(slug, hid).participants.find((x) => x.handle === handle);
    this.updateP(slug, hid, handle, { status: settled(cur) ? cur!.status : "working", error: null, interrupted: false });
    run.promise = this.executeAgent(slug, hid, handle, run, input)
      .catch((e) => {
        console.error(`huddle ${slug}/${hid} @${handle} crashed`, e);
        const error = String((e as Error)?.message ?? e);
        this.updateP(slug, hid, handle, { status: "failed", error });
        if (this.load(slug, hid)) this.system(slug, hid, `@${handle} failed: ${error}`);
      })
      .finally(() => {
        this.runs.delete(key);
        if (this.shuttingDown) return;
        this.board.restartWorkChanged();
        // Emit with running: false now that the run is gone.
        if (this.load(slug, hid)) this.update(slug, hid, () => {});
        if ((run.again || run.pending) && !run.stopRequested) this.deliverNow(slug, hid, handle);
      });
  }

  /**
   * Where an agent works: (workspace own) a worktree of its own off the host's branch; a read-only agent, a detached
   * snapshot of the host's HEAD (see snapshot); anyone else the host ticket's worktree. In a repo with no commits yet
   * there is nothing to branch or snapshot, so everyone works in the host's folder (as the host ticket does).
   */
  private async workspace(slug: string, h: Huddle, p: HuddleParticipant): Promise<string> {
    const host = await this.board.ensureSession(slug, h.hostTicket);
    const committed = host.isGit && (await hasCommits(host.dir));
    if (p.workspace === "shared") return isSnapshot(p) && committed ? this.snapshot(slug, h, p, host.dir) : host.dir;
    const profile = this.store.getProfile(slug)!;
    if (p.worktree && existsSync(p.worktree)) return p.worktree;
    if (!committed) {
      // A plain folder or a repo with no commits: nothing to branch from, so share the host's folder (as the host does).
      const why = host.isGit ? "this repo has no commits yet. Make a first commit" : "this folder has no version history. Turn it on in the board's settings";
      if (!p.sessionId) this.system(slug, h.id, `@${p.handle} works in the host's folder ${host.dir}, shared with @main, instead of a copy of its own: ${why} to give new agents their own copy.`);
      return host.dir;
    }
    const t = this.store.getTicket(slug, h.hostTicket)!;
    const dir = agentDir(profile, h, p);
    const branch = p.branch ?? `ck/${h.hostTicket}-${p.handle}`;
    // A host working in the project folder itself has no branch of its own: start from what it has checked out.
    const head = t.branch || t.workdir ? null : (await git(["git", "rev-parse", "HEAD"], host.dir)).stdout.trim();
    await addWorktree(profile.path, dir, branch, t.branch ?? (head || profile.baseBranch));
    this.updateP(slug, h.id, p.handle, { worktree: dir, branch });
    return dir;
  }

  /**
   * A read-only agent's folder: a detached worktree at the host worktree's committed HEAD, made on its first run and
   * reset at every wake (local changes and untracked files there are discarded). Nothing it does there reaches the
   * coordinator's worktree.
   */
  private async snapshot(slug: string, h: Huddle, p: HuddleParticipant, hostDir: string): Promise<string> {
    const profile = this.store.getProfile(slug)!;
    const head = await git(["git", "rev-parse", "HEAD"], hostDir);
    if (head.code !== 0) throw new Error(`couldn't read the host worktree's HEAD: ${head.stderr.trim()}`);
    const sha = head.stdout.trim();
    const branch = (await git(["git", "branch", "--show-current"], hostDir)).stdout.trim() || null;
    const dir = p.worktree ?? agentDir(profile, h, p);
    if (existsSync(dir)) {
      for (const cmd of [["git", "checkout", "--quiet", "--force", "--detach", sha], ["git", "clean", "-fdq"]]) {
        const r = await git(cmd, dir);
        if (r.code !== 0) throw new Error(`couldn't reset the snapshot worktree ${dir}: ${r.stderr.trim()}`);
      }
    } else {
      await git(["git", "worktree", "prune"], profile.path);
      mkdirSync(dirname(dir), { recursive: true });
      const r = await git(["git", "worktree", "add", "--detach", dir, sha], profile.path);
      if (r.code !== 0) throw new Error(`couldn't make the snapshot worktree ${dir}: ${r.stderr.trim()}`);
    }
    this.updateP(slug, h.id, p.handle, { worktree: dir, branch: null, snapshot: { branch, sha } });
    return dir;
  }

  private async executeAgent(slug: string, hid: string, handle: string, run: AgentRun, input: string): Promise<void> {
    let h = this.get(slug, hid);
    let p = h.participants.find((x) => x.handle === handle)!;
    const host = this.store.getTicket(slug, h.hostTicket);
    if (!host) throw new Error(`host ticket ${h.hostTicket} not found`);
    const dir = await this.workspace(slug, h, p);
    if (run.stopRequested || this.shuttingDown) return;
    h = this.get(slug, hid);
    p = h.participants.find((x) => x.handle === handle)!;
    const profile = this.store.getProfile(slug)!;
    const sessionId = p.sessionId ?? crypto.randomUUID();
    const resume = !!p.sessionStarted && this.sessionExists(sessionId);
    if (!p.sessionId) this.updateP(slug, hid, handle, { sessionId });
    const outputDir = this.store.huddleOutputsDir(slug, h.hostTicket, handle);
    const system = huddleAgentSystemPrompt(h, p, host as Ticket, outputDir, dir, profile.baseBranch, this.lessonsFor(slug, p.preset));
    const args = [
      ...buildArgs(sessionId, resume, p.model ?? profile.model, "bypassPermissions", mcpConfig(), system),
      ...(p.canEdit ? [] : ["--disallowedTools", NO_EDIT_TOOLS]),
    ];
    let lastWrite = 0;
    let started = resume;
    run.handle = startRun({
      bin: this.opts.claudeBin, cwd: dir, args, input,
      // Huddle agents have no board slot: CKANBAN_TICKET is the host (its board and outputs), CKANBAN_HUDDLE_AGENT who they are.
      env: { CKANBAN_OUTPUT_DIR: outputDir, CKANBAN_TICKET: `${slug}/${h.hostTicket}`, [HUDDLE_AGENT_ENV]: `${hid}/${handle}/${p.token}` },
      idleMs: p.mode === "monitor" ? this.opts.idleMs ?? MONITOR_IDLE_MS : undefined,
      onEvent: (ev) => {
        if (ev?.type === "stream_event" || this.shuttingDown) return;
        if (ev?.type === "result") {
          run.idle = true;
          run.turn = undefined;
          const cur = this.get(slug, hid).participants.find((x) => x.handle === handle);
          const cost = costAfter(cur, Number(ev.total_cost_usd) || 0);
          this.updateP(slug, hid, handle, { status: settled(cur) ? cur!.status : "idle", idleAt: nowIso(), ...cost, ...(run.ctx ? { contextTokens: run.ctx } : {}) });
          try {
            addHuddleSpend(this.store.root, slug, (cost.costUsd ?? 0) - (cur?.costUsd ?? 0));
          } catch {}
          this.board.restartWorkChanged();
          this.checkBudget(slug, hid);
          // Turn boundary: a monitor gets what came in while it worked.
          if (run.pending) queueMicrotask(() => this.deliverNow(slug, hid, handle));
          return;
        }
        // Saved at once: a restart may cut the run off before it ends, and the next run must resume this session.
        if (ev?.type === "system" && ev.subtype === "init" && !started) {
          started = true;
          this.updateP(slug, hid, handle, { sessionStarted: true });
        }
        if (run.idle && (ev?.type === "assistant" || (ev?.type === "system" && ev.subtype === "init"))) {
          run.idle = false;
          if (!settled(this.get(slug, hid).participants.find((x) => x.handle === handle))) this.updateP(slug, hid, handle, { status: "working" });
        }
        // Live cost on the roster: the turn's messages priced from their usage until the result line.
        if (ev?.type === "assistant" && ev.message?.id && ev.message.usage) {
          (run.turn ??= new Map()).set(ev.message.id, messageCost(String(ev.message.model ?? p.model ?? profile.model ?? ""), ev.message.usage));
          if (!ev.parent_tool_use_id) run.ctx = contextTokens(ev.message.usage) || run.ctx;
        }
        const s = summarizeEvent(ev);
        const now = Date.now();
        if ((s || run.ctx) && now - lastWrite >= ACTIVITY_THROTTLE_MS) {
          lastWrite = now;
          this.updateP(slug, hid, handle, { ...(s ? { lastActivity: s } : {}), ...(run.ctx ? { contextTokens: run.ctx } : {}) });
        }
      },
    });
    const out = await run.handle.done;
    if (this.shuttingDown) return;
    started ||= this.sessionExists(sessionId);
    if (!this.load(slug, hid)) return;
    if (run.stopRequested || run.handle.stopped) return this.updateP(slug, hid, handle, { sessionStarted: started, status: "stopped" });
    if (out.code !== 0) {
      const error = out.stderr.trim().split("\n").slice(-3).join("\n") || `claude exited with code ${out.code}`;
      this.updateP(slug, hid, handle, { sessionStarted: started, status: "failed", error });
      this.system(slug, hid, `@${handle}'s run failed: ${error}`);
      return;
    }
    const cur = this.get(slug, hid).participants.find((x) => x.handle === handle);
    this.updateP(slug, hid, handle, { sessionStarted: started, status: settled(cur) ? cur!.status : "idle", idleAt: nowIso() });
  }

  /**
   * Stop what the huddle runs for a participant: an agent's run, or the reply run the huddle woke a ticket's session
   * for. A ticket's own work (its runs, slot waits, card status) is never touched.
   */
  private stopParticipantRun(slug: string, h: Huddle, p: HuddleParticipant) {
    const run = this.runs.get(this.key(slug, h.id, p.handle));
    if (run) {
      run.stopRequested = true;
      run.handle?.stop();
    }
    this.mainPending.delete(this.key(slug, h.id, p.handle));
    if (p.kind === "ticket-main" && p.ticketId && this.board.isPeerRun(slug, p.ticketId) && this.mainWoken.get(`${slug}/${p.ticketId}`)?.hid === h.id) {
      this.board.stop(slug, p.ticketId);
    }
  }

  /** The user stops one participant: its huddle run ends and nothing wakes it until the huddle is resumed. */
  stopParticipant(slug: string, hid: string, handle: string): void {
    const h = this.get(slug, hid);
    const p = h.participants.find((x) => x.handle === handle && x.kind !== "human");
    if (!p) throw new HuddleError(404, `no participant @${handle}`);
    this.stopParticipantRun(slug, h, p);
    this.updateP(slug, hid, handle, { status: "stopped" });
    if (h.status !== "closed") this.system(slug, hid, `@${handle} was stopped by @you.`);
    this.userActed(slug, hid);
  }

  /**
   * The user restarts a failed or stopped participant: it is idle again and, while the huddle is live, wakes now
   * with what it has not read yet. On a stopped huddle it wakes when the huddle resumes.
   */
  restartParticipant(slug: string, hid: string, handle: string): void {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    const p = h.participants.find((x) => x.handle === handle && x.kind !== "human");
    if (!p) throw new HuddleError(404, `no participant @${handle}`);
    if (p.status !== "failed" && p.status !== "stopped") throw new HuddleError(409, `@${handle} is ${p.status}, not failed or stopped`);
    this.updateP(slug, hid, handle, { status: "idle", error: null });
    const live = h.status === "live";
    this.system(slug, hid, `@${handle} was restarted by @you${live ? "" : "; it wakes when the huddle resumes"}.`, live ? [handle] : []);
    this.userActed(slug, hid);
  }

  /** The user viewed the huddle up to message `seq` (the Huddle tab, scrolled to the latest): the "for you" count clears up to there. */
  markSeen(slug: string, hid: string, seq: number): Huddle {
    const h = this.get(slug, hid);
    const me = h.participants.find((p) => p.handle === USER_HANDLE);
    if (!Number.isFinite(seq)) throw new HuddleError(400, "seq must be a number");
    const to = Math.min(Math.floor(seq), h.seq);
    if (!me || me.cursor >= to) return h;
    return this.update(slug, hid, (x) => {
      const m = x.participants.find((p) => p.handle === USER_HANDLE)!;
      m.cursor = Math.max(m.cursor, to);
    });
  }

  /** The user acted on the huddle: what tagged them so far counts as seen (the "for you" count starts over). */
  private userActed(slug: string, hid: string) {
    if (!this.store.getHuddle(slug, hid)) return;
    this.update(slug, hid, (x) => {
      const me = x.participants.find((p) => p.handle === USER_HANDLE);
      if (me) me.cursor = x.seq;
    });
  }

  /**
   * Stop agents: every huddle agent's run and the huddle's reply runs end, and the huddle stops routing until resumed.
   * The tickets' own sessions keep working (only their huddle replies stop).
   */
  stopAll(slug: string, hid: string): Huddle {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    for (const p of h.participants) if (p.kind !== "human") this.stopParticipantRun(slug, h, p);
    this.update(slug, hid, (x) => {
      x.status = "stopped";
      x.stopReason = null;
      for (const p of x.participants) if (p.kind === "agent") p.status = "stopped";
    });
    this.system(slug, hid, "Huddle agents stopped by @you. The tickets' own runs keep going.");
    this.userActed(slug, hid);
    if (h.auto) this.autoEnded(slug, hid, "user", "the user stopped it");
    return this.get(slug, hid);
  }

  /**
   * Resume routing; stopped participants wake again when tagged (or, in monitor mode, on new messages), and whoever
   * was tagged while the huddle was stopped wakes now. addBudgetUsd raises the budget (needed when it was spent);
   * the message limit and the agent-only count start over.
   */
  resume(slug: string, hid: string, addBudgetUsd = 0): Huddle {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    if (!Number.isFinite(addBudgetUsd) || addBudgetUsd < 0) throw new HuddleError(400, "addBudgetUsd must be a positive amount");
    const max = (h.maxCostUsd ?? DEFAULT_MAX_COST_USD) + addBudgetUsd;
    const spent = huddleCost(h);
    if (spent >= max) throw new HuddleError(409, `the huddle spent ${money(spent)} of its ${money(max)} budget: add budget to resume it`);
    this.update(slug, hid, (x) => {
      x.status = "live";
      x.stopReason = null;
      x.maxCostUsd = max;
      x.sinceUser = 0;
      x.held = null;
      if (spent < max * BUDGET_WARN) x.budgetWarned = false;
      // Another round of messages before the limit stops it again.
      if (h.stopReason === "messages") x.maxMessages = (x.posts ?? 0) + DEFAULT_MAX_MESSAGES;
      for (const p of x.participants) if (p.status === "stopped") p.status = "idle";
    });
    if (h.status !== "live" || addBudgetUsd) this.system(slug, hid, `Huddle resumed by @you${addBudgetUsd ? ` with ${money(addBudgetUsd)} more budget (now ${money(max)})` : ""}.`);
    this.userActed(slug, hid);
    for (const p of this.get(slug, hid).participants) if (p.kind !== "human") this.wakeIfOwed(slug, hid, p.handle);
    return this.get(slug, hid);
  }

  /**
   * The user closes a huddle (or the host ticket is done or deleted: `why`): the huddle's runs stop, the history
   * stays read-only, and the agents' own worktrees are removed when clean. The tickets' own work is untouched.
   */
  close(slug: string, hid: string, why?: string, summarize = true): Huddle {
    const h = this.get(slug, hid);
    if (h.status === "closed") return h;
    for (const p of h.participants) if (p.kind !== "human") this.stopParticipantRun(slug, h, p);
    this.system(slug, hid, why ? `Huddle closed: ${why}. The history stays, read-only.` : "Huddle closed by @you. The history stays, read-only.");
    const out = this.update(slug, hid, (x) => {
      x.status = "closed";
      x.closedAt = nowIso();
      for (const p of x.participants) if (p.kind === "agent" && p.status === "working") p.status = "stopped";
    });
    if (h.participants.some((p) => p.kind === "agent" && p.worktree)) this.chore(this.removeWorktrees(slug, hid));
    if (h.auto) this.autoEnded(slug, hid, why ? "closed" : "user", why ?? "the user closed it");
    if (summarize) this.ensureSummary(slug, hid);
    return out;
  }

  /** The host ticket was deleted or moved to Done: its huddles close (a deleted one's without a summary). */
  closeForTicket(slug: string, ticketId: string, why = DELETED): void {
    for (const h of this.store.listHuddles(slug)) if (h.hostTicket === ticketId && h.status !== "closed") this.close(slug, h.id, why, why !== DELETED);
  }

  /**
   * A huddle just closed: make sure it has a summary. @main writes it when the host ticket can run (a queued chat
   * message); otherwise, or when that run ends without it, the board writes fallbackSummary. An older huddle's summary
   * in the single legacy file, written during this huddle, becomes this huddle's.
   */
  private ensureSummary(slug: string, hid: string): void {
    const h = this.load(slug, hid);
    const t = h && this.store.getTicket(slug, h.hostTicket);
    if (!h || !t) return;
    const dir = this.store.outputsDir(slug, t.id);
    const file = join(dir, summaryFile(hid));
    if (existsSync(file)) return;
    const legacy = join(dir, LEGACY_SUMMARY_FILE);
    if (existsSync(legacy) && statSync(legacy).mtime.toISOString() >= h.createdAt) {
      mkdirSync(dirname(file), { recursive: true });
      copyFileSync(legacy, file);
      return this.touch(slug, hid);
    }
    const canRun = t.status !== "done" && !!t.sessionId && !!t.sessionStarted && this.sessionExists(t.sessionId);
    if (!canRun) return this.writeFallbackSummary(slug, hid);
    this.summaryOwed.add(`${slug}/${hid}`);
    this.board.chat(slug, t.id, summaryAsk(h, file), { peer: true }).catch(() => {
      this.summaryOwed.delete(`${slug}/${hid}`);
      this.writeFallbackSummary(slug, hid);
    });
  }

  /** The board's own summary (fallbackSummary), unless one exists by now. */
  writeFallbackSummary(slug: string, hid: string): void {
    const h = this.load(slug, hid);
    if (!h || !this.store.getTicket(slug, h.hostTicket)) return;
    const file = join(this.store.outputsDir(slug, h.hostTicket), summaryFile(hid));
    if (existsSync(file)) return;
    mkdirSync(dirname(file), { recursive: true });
    const outputs = this.store.listOutputs(slug, h.hostTicket).map((o) => o.name);
    writeFileSync(file, fallbackSummary(h, this.store.readHuddleMessages(slug, hid), outputs));
    this.touch(slug, hid);
  }

  /** Tell the UI the huddle changed (its summary appeared) without changing it. */
  private touch(slug: string, hid: string) {
    const h = this.load(slug, hid);
    if (h) this.bus.emit({ type: "huddle.updated", profile: slug, huddle: this.view(slug, h) });
  }

  private chore(p: Promise<void>) {
    const tracked = p.catch((e) => console.error("huddle cleanup failed", e)).finally(() => this.chores.delete(tracked));
    this.chores.add(tracked);
  }

  /**
   * After a close: remove each agent's own worktree and branch when nothing would be lost (no uncommitted changes,
   * no commits the host's branch lacks); a system note lists the ones kept.
   */
  private async removeWorktrees(slug: string, hid: string): Promise<void> {
    // The agents' runs were just stopped: let them end first.
    await Promise.all([...this.runs.entries()].filter(([k]) => k.startsWith(`${slug}/${hid}/`)).flatMap(([, r]) => [r.promise, r.refreshing ?? undefined]));
    const h = this.load(slug, hid);
    const profile = this.store.getProfile(slug);
    if (!h || !profile) return;
    const base = this.store.getTicket(slug, h.hostTicket)?.branch ?? profile.baseBranch;
    const removed: string[] = [];
    const kept: string[] = [];
    for (const p of h.participants) {
      if (p.kind !== "agent" || !p.worktree) continue;
      if (!p.branch) {
        // A read-only snapshot: nothing in it is anyone's work, so it goes without a note.
        const r = existsSync(p.worktree) ? await git(["git", "worktree", "remove", "--force", p.worktree], profile.path) : null;
        if (r && r.code !== 0) kept.push(`@${p.handle}: ${p.worktree}: ${r.stderr.trim() || "couldn't remove it"}`);
        else this.updateP(slug, hid, p.handle, { worktree: null });
        continue;
      }
      const why = await removeOwnWorktree(profile.path, p.worktree, p.branch ?? null, base);
      if (why) kept.push(`@${p.handle}: ${p.worktree}${p.branch ? ` (branch ${p.branch})` : ""}: ${why}`);
      else {
        removed.push(`@${p.handle}`);
        this.updateP(slug, hid, p.handle, { worktree: null, branch: null });
      }
    }
    const lines = [
      ...(removed.length ? [`Removed the own worktrees of ${removed.join(", ")} (nothing uncommitted or unmerged).`] : []),
      ...(kept.length ? ["Kept these own worktrees, so nothing is lost; merge or remove them yourself:", ...kept.map((k) => `- ${k}`)] : []),
    ];
    if (lines.length) this.system(slug, hid, lines.join("\n"));
  }

  /** Daemon exiting: agents mid-turn are marked so recover() resumes them; every agent run is killed. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    const runs = [...this.runs.entries()];
    for (const [key, run] of runs) {
      const [slug, hid, handle] = key.split("/");
      if (!run.idle && !run.stopRequested) this.updateP(slug, hid, handle, { interrupted: true });
      run.stopRequested = true;
      run.handle?.stop();
    }
    await Promise.race([Promise.all(runs.map(([, r]) => r.promise)), Bun.sleep(6000)]);
  }

  /**
   * After a daemon restart: huddles whose host is done close; agents cut off mid-turn carry on, ones held back by a
   * pending restart start; then everyone (ticket sessions included) gets the wakes it was owed.
   */
  recover(): void {
    for (const profile of this.store.listProfiles()) {
      const slug = profile.slug;
      for (const h of this.store.listHuddles(slug)) {
        if (h.status === "closed") continue;
        if (this.store.getTicket(slug, h.hostTicket)?.status === "done") {
          this.close(slug, h.id, "the host ticket moved to Done");
          continue;
        }
        for (const p of h.participants) {
          if (p.kind !== "agent") continue;
          // working: cut off mid-turn. interrupted while idle: a wake held back by the pending restart.
          const cut = p.status === "working" || (p.interrupted && !p.sessionStarted);
          if (h.status === "live" && p.status !== "stopped" && (cut || p.interrupted)) {
            if (cut) {
              const digest = this.takeUnread(slug, h.id, p.handle, true)?.digest ?? "";
              this.runAgent(slug, h.id, p.handle, huddleAgentPrompt(p.sessionStarted ? "interrupted" : "start", p, digest));
              continue;
            }
            this.updateP(slug, h.id, p.handle, { interrupted: false });
          } else if (p.status === "working" || p.interrupted) this.updateP(slug, h.id, p.handle, { status: "idle", interrupted: false });
        }
        for (const p of h.participants) if (p.kind !== "human") this.wakeIfOwed(slug, h.id, p.handle);
      }
      // A ticket that waits for an auto huddle that is gone (closed while the daemon was down): back to Review.
      for (const t of this.store.listTickets(slug)) {
        const a = t.autoHuddle;
        if (a?.state !== "live") continue;
        const h = a.huddleId ? this.store.getHuddle(slug, a.huddleId) : null;
        if (h && h.status === "live") continue;
        if (h && h.status === "stopped") continue;
        this.store.addComment(slug, t.id, "ai", "Its auto huddle is no longer open; the work was not landed.");
        this.board.setAutoHuddle(slug, t.id, null, this.board.isRunning(slug, t.id) ? {} : { status: "review", outcome: "stopped", lastActivity: null });
      }
      this.freeSlot(slug);
    }
  }

  async whenIdle(): Promise<void> {
    while (this.runs.size || this.chores.size) await Promise.all([...this.runs.values()].map((r) => r.promise).concat([...this.chores]));
  }
}

export type StatusChange = "done" | "blocked" | "active";

/** A finding's first line, cut to FINDING_TITLE characters. */
export function findingTitle(text: string): string {
  const line = text.trim().split("\n")[0].trim();
  return line.length > FINDING_TITLE ? `${line.slice(0, FINDING_TITLE - 1).trimEnd()}…` : line;
}

/** An agent's own or snapshot worktree: next to the board's worktree folder, so its startup sweep (one folder per ticket id) leaves it alone. */
function agentDir(profile: Profile, h: Huddle, p: HuddleParticipant): string {
  return join(dirname(worktreeDir(profile, h.hostTicket)), `${h.hostTicket}.huddle`, p.handle);
}

/** Remove an agent's own worktree and branch; the reason it was kept instead, or null once removed. */
async function removeOwnWorktree(repo: string, dir: string, branch: string | null, base: string): Promise<string | null> {
  const hasBranch = !!branch && (await branchExists(repo, branch));
  if (hasBranch) {
    const ahead = await git(["git", "rev-list", "--count", `${base}..${branch}`], repo);
    if (ahead.code !== 0) return `couldn't compare it with ${base}: ${ahead.stderr.trim()}`;
    const n = Number(ahead.stdout.trim());
    if (n > 0) return `${n} commit${n === 1 ? "" : "s"} not on ${base}`;
  }
  const r = await removeWorktree(repo, dir);
  if (!r.removed) return r.reason ?? "couldn't remove it";
  if (hasBranch) await git(["git", "branch", "-D", branch!], repo);
  return null;
}
