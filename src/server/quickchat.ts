import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { summarizeEvent } from "./activity";
import { mcpConfig } from "./agents";
import { localizeAttachments } from "./attachments";
import { claudeSessionExists, sessionMissing, type Board } from "./board";
import { DraftTracker } from "./draft";
import type { Bus } from "./events";
import { WRITING_RULE } from "./prompts";
import { buildArgs, startRun, type RunHandle } from "./runner";
import { atomicWrite, type Store } from "./store";
import type { ActivityEntry, Profile, Ticket } from "./types";
import { newId, nowIso } from "./util";

// Quick chats: conversations with Claude in a board's folder that aren't tickets (the phone's Ask tab, the computer's
// Claude panel). Each is a headless `claude -p` session, resumed for every message like a ticket's chat, kept in
// profiles/<slug>/chats/<id>.json. Their runs don't take ticket run slots; a restart waits for them like other runs.

export interface QuickChat {
  id: string;
  sessionId: string;
  /** Set by Rename; null: the title comes from the first message. */
  title: string | null;
  /** The first message the user sent (its first line titles the chat until it is renamed). */
  firstMessage: string | null;
  createdAt: string;
  /** When the last message was sent or the last reply ended. */
  updatedAt: string;
  /** Claude saved the conversation (Make ticket needs it). */
  started: boolean;
  /** Make ticket turned this chat into this ticket: the chat continues there, not here. */
  ticketId: string | null;
  /** Why the last reply failed (cleared by the next message). */
  error: string | null;
  /** Messages held while a restart was pending: the next start sends them. */
  pending?: string[];
  /** A reply a restart cut off: recover() continues it. prompt: Claude never got the message, so it goes again. */
  interrupted?: { prompt?: string } | null;
}

/** What the UI gets: the chat plus its live state. */
export interface QuickChatView extends Omit<QuickChat, "pending" | "interrupted" | "title"> {
  /** Display title: the user's, else the first message's first line. */
  title: string;
  /** Rename set it (otherwise it is the automatic one). */
  renamed: boolean;
  running: boolean;
  /** What Claude is doing now (a tool, the start of its reply); null when idle. */
  activity: string | null;
  /** Messages waiting for a restart to finish. */
  waiting: number;
}

export class QuickChatError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const TITLE_MAX = 80;
const MESSAGE_MAX = 100_000;
const DRAFT_THROTTLE_MS = 120;
const ACTIVITY_THROTTLE_MS = 1000;
/** What a reply a restart cut off gets on the other side. */
export const CONTINUE_TEXT = "The board restarted while you were replying. Continue where you left off.";

/** A title from the first message: its first line without images, links or markdown marks, cut to fit. */
export function autoTitle(text: string | null): string {
  const plain = (text ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split("\n").map((l) => l.replace(/^[#>*\-\s`]+/, "").trim()).find((l) => l) ?? "";
  if (!plain) return "New chat";
  return plain.length > TITLE_MAX ? `${plain.slice(0, TITLE_MAX - 1).trimEnd()}…` : plain;
}

/** The note every quick chat run gets (--append-system-prompt): where it runs and how to reach the board. */
export function quickChatNote(profile: Pick<Profile, "name" | "slug" | "path">): string {
  return [
    `You are running in a quick chat of ckanban, a local kanban board that runs tickets through Claude. This chat is not a ticket.`,
    `It belongs to the board (profile) "${profile.name}" (slug: ${profile.slug}), whose folder is ${profile.path}, your working folder.`,
    `You can read, edit and run commands there when the user asks.`,
    `For board work (making, finding, updating or moving tickets) use the ckanban MCP tools: create_ticket, list_tickets, get_ticket, update_ticket, move_ticket, comment_ticket.`,
    `Use profile "${profile.slug}" unless the user names another board. New tickets land in Backlog. The user can also turn this whole chat into a ticket with the Make ticket button.`,
    `If you use Claude in Chrome, open your own new tab and don't take over the user's tabs.`,
    `The user may not be technical and may read this on a phone: answer in plain words, short and to the point. ${WRITING_RULE}`,
  ].join(" ");
}

interface ActiveChat {
  slug: string;
  id: string;
  handle: RunHandle | null;
  /** The message this run started with, until Claude has it (a restart before then sends it again). */
  prompt: string;
  started: boolean;
  /** Sent after the run stopped taking input: the next run starts with them. */
  later: string[];
  activity: string | null;
  draft: DraftTracker;
  stopRequested: boolean;
  done: Promise<void>;
}

export interface QuickChatOptions {
  claudeBin: string;
  sessionExists?: (sessionId: string) => boolean;
  /** MCP config for the runs (default: this ckanban's MCP server). */
  mcp?: () => string;
}

export class QuickChats {
  private runs = new Map<string, ActiveChat>();
  /** Chats Make ticket is turning into tickets right now: no second ticket, no new reply on that conversation. */
  private making = new Set<string>();
  private shuttingDown = false;
  private sessionExists: (id: string) => boolean;

  constructor(private store: Store, private bus: Bus, private board: Board, private opts: QuickChatOptions) {
    this.sessionExists = opts.sessionExists ?? claudeSessionExists;
    board.onRestartBusy(() => [...this.runs.values()].map((r) => r.slug));
  }

  private key = (slug: string, id: string) => `${slug}/${id}`;

  private dir(slug: string): string {
    return join(this.store.root, "profiles", slug, "chats");
  }

  private file(slug: string, id: string): string {
    return join(this.dir(slug), `${id}.json`);
  }

  /** Result lines of the chat's runs, for today's spend (same shape as a ticket's activity log). */
  activityPath(slug: string, id: string): string {
    return join(this.dir(slug), `${id}.activity.jsonl`);
  }

  private profile(slug: string): Profile {
    const p = this.store.getProfile(slug);
    if (!p) throw new QuickChatError(404, `board ${slug} not found`);
    return p;
  }

  get(slug: string, id: string): QuickChat | null {
    if (!/^[a-z0-9]+$/.test(id)) return null;
    try {
      const c = JSON.parse(readFileSync(this.file(slug, id), "utf8"));
      return c && typeof c === "object" && c.id === id ? c : null;
    } catch {
      return null;
    }
  }

  private getOr404(slug: string, id: string): QuickChat {
    const c = this.get(slug, id);
    if (!c) throw new QuickChatError(404, "chat not found");
    return c;
  }

  /** The board's chats, latest first. */
  list(slug: string): QuickChat[] {
    const dir = this.dir(slug);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^[a-z0-9]+\.json$/.test(f))
      .map((f) => this.get(slug, f.slice(0, -5)))
      .filter((c): c is QuickChat => c !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
  }

  view(slug: string, c: QuickChat): QuickChatView {
    const { pending, interrupted: _i, title, ...rest } = c;
    const run = this.runs.get(this.key(slug, c.id));
    return {
      ...rest, title: title ?? autoTitle(c.firstMessage), renamed: !!title,
      running: !!run, activity: run?.activity ?? null, waiting: (pending?.length ?? 0) + (run?.later.length ?? 0),
    };
  }

  isRunning(slug: string, id: string): boolean {
    return this.runs.has(this.key(slug, id));
  }

  private save(slug: string, c: QuickChat): void {
    atomicWrite(this.file(slug, c.id), JSON.stringify(c, null, 2) + "\n");
  }

  /** Saves a change to a chat that still exists (a run ending after Delete must not bring it back). */
  private patch(slug: string, id: string, patch: Partial<QuickChat>): QuickChat | null {
    const c = this.get(slug, id);
    if (!c) return null;
    const next = { ...c, ...patch };
    this.save(slug, next);
    this.emit(slug, next);
    return next;
  }

  private emit(slug: string, c: QuickChat): void {
    this.bus.emit({ type: "chat.updated", profile: slug, id: c.id, chat: this.view(slug, c) });
  }

  /** Send a message: in a new chat (id null), to a reply in progress, or as a new reply in the same conversation. */
  send(slug: string, id: string | null, text: string): QuickChatView {
    const profile = this.profile(slug);
    const msg = String(text ?? "").trim();
    if (!msg) throw new QuickChatError(400, "message is empty");
    if (msg.length > MESSAGE_MAX) throw new QuickChatError(413, "message is too long");
    const now = nowIso();
    let c: QuickChat;
    if (id === null) {
      c = { id: newId(), sessionId: crypto.randomUUID(), title: null, firstMessage: msg, createdAt: now, updatedAt: now, started: false, ticketId: null, error: null };
    } else {
      c = this.getOr404(slug, id);
      if (c.ticketId) throw new QuickChatError(409, "This chat became a ticket. Continue it in the ticket's chat.");
      if (this.making.has(this.key(slug, c.id))) throw new QuickChatError(409, "This chat is being made into a ticket. Continue it in the ticket's chat.");
      c = { ...c, firstMessage: c.firstMessage ?? msg, updatedAt: now, error: null };
    }
    const run = this.runs.get(this.key(slug, c.id));
    if (run) {
      // Claude is replying: it reads the message at its next step. Once its input has closed, the next run takes it.
      if (run.stopRequested || !run.handle?.send(localizeAttachments(msg, this.store.attachmentsDir))) run.later.push(msg);
      this.save(slug, c);
    } else if (this.shuttingDown || this.board.isRestartPending()) {
      // Held until after the restart (recover() sends it).
      c.pending = [...(c.pending ?? []), msg];
      this.save(slug, c);
    } else {
      this.save(slug, c);
      this.start(slug, profile, c, msg);
    }
    const saved = this.get(slug, c.id)!;
    this.emit(slug, saved);
    return this.view(slug, saved);
  }

  private start(slug: string, profile: Profile, c: QuickChat, prompt: string): void {
    const run: ActiveChat = {
      slug, id: c.id, handle: null, prompt, started: false, later: [], activity: "Starting…", draft: new DraftTracker(), stopRequested: false,
      done: Promise.resolve(),
    };
    this.runs.set(this.key(slug, c.id), run);
    run.done = this.execute(run, profile, c).catch((e) => {
      console.error(`quick chat ${slug}/${c.id}`, e);
      this.patch(slug, c.id, { error: (e as Error).message });
    }).finally(() => this.finished(run));
  }

  private async execute(run: ActiveChat, profile: Profile, c: QuickChat, healed = false): Promise<void> {
    const { slug, id } = run;
    const resume = c.started || this.sessionExists(c.sessionId);
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    let lastActivity = 0;
    const emitDraft = (text: string, final?: string) => this.bus.emit({ type: "chat.draft", profile: slug, id, text, ...(final ? { final } : {}) });
    run.handle = startRun({
      bin: this.opts.claudeBin,
      cwd: profile.path,
      args: buildArgs(c.sessionId, resume, profile.model, [], (this.opts.mcp ?? (() => mcpConfig()))(), quickChatNote(profile), null, profile.effort),
      input: localizeAttachments(run.prompt, this.store.attachmentsDir),
      onEvent: (ev) => {
        const changed = run.draft.feed(ev);
        if (changed === "") {
          if (draftTimer) clearTimeout(draftTimer);
          draftTimer = null;
          emitDraft("", run.draft.finished || undefined);
        } else if (changed !== null && !draftTimer) {
          draftTimer = setTimeout(() => {
            draftTimer = null;
            emitDraft(run.draft.text);
          }, DRAFT_THROTTLE_MS);
        }
        if (ev?.type === "stream_event") return;
        if ((ev?.type === "system" && ev.subtype === "init") || ev?.type === "assistant") run.started = true;
        // Only result lines: they carry the cost today's spend adds up.
        if (ev?.type === "result") this.appendActivity(slug, id, ev);
        const s = summarizeEvent(ev);
        if (s && !run.stopRequested) run.activity = s;
        const now = Date.now();
        if (now - lastActivity >= ACTIVITY_THROTTLE_MS || ev?.type === "result" || ev?.type === "user") {
          lastActivity = now;
          this.bus.emit({ type: "chat.activity", profile: slug, id, activity: run.activity });
        }
      },
    });
    const out = await run.handle.done;
    if (draftTimer) clearTimeout(draftTimer);
    if (run.draft.text) emitDraft("", run.draft.text);
    if (this.shuttingDown) return;
    const started = resume || run.started || this.sessionExists(c.sessionId);
    const patch: Partial<QuickChat> = { started, updatedAt: nowIso() };
    if (out.code !== 0 && !run.handle.stopped) {
      const result = out.events.findLast((e) => e?.type === "result");
      const error = out.stderr.trim() || (typeof result?.result === "string" ? result.result.trim() : "") || `claude exited with code ${out.code}`;
      // Claude lost the conversation (stopped before it was saved): carry on in a new one rather than failing every time.
      if (!healed && sessionMissing(error, out.events)) {
        const fresh = this.patch(slug, id, { sessionId: crypto.randomUUID(), started: false });
        if (fresh) {
          run.started = false;
          return this.execute(run, profile, fresh, true);
        }
      }
      patch.error = error.split("\n").findLast((l: string) => l.trim())?.trim().slice(0, 500) ?? error.slice(0, 500);
    }
    this.patch(slug, id, patch);
  }

  private finished(run: ActiveChat): void {
    const k = this.key(run.slug, run.id);
    if (this.runs.get(k) !== run) return;
    this.runs.delete(k);
    this.board.restartWorkChanged();
    if (this.shuttingDown) return;
    const c = this.get(run.slug, run.id);
    if (!c) return;
    // Messages that came in as the run was ending get their own reply now (or after a pending restart).
    if (run.later.length && !run.stopRequested) {
      if (this.board.isRestartPending()) this.patch(run.slug, run.id, { pending: [...(c.pending ?? []), ...run.later] });
      else {
        const profile = this.store.getProfile(run.slug);
        if (profile) return this.start(run.slug, profile, c, run.later.join("\n\n"));
      }
    }
    this.emit(run.slug, this.get(run.slug, run.id) ?? c);
  }

  private appendActivity(slug: string, id: string, event: unknown): void {
    const e: ActivityEntry = { run: 1, at: nowIso(), event };
    try {
      appendFileSync(this.activityPath(slug, id), JSON.stringify(e) + "\n");
    } catch {}
  }

  stop(slug: string, id: string): void {
    const run = this.runs.get(this.key(slug, id));
    if (!run) return;
    run.stopRequested = true;
    run.later = [];
    run.activity = "Stopping…";
    run.handle?.stop();
    this.bus.emit({ type: "chat.activity", profile: slug, id, activity: run.activity });
  }

  rename(slug: string, id: string, title: string | null): QuickChatView {
    this.getOr404(slug, id);
    const t = typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) : "";
    return this.view(slug, this.patch(slug, id, { title: t || null })!);
  }

  /** Deletes the chat from the board's list (Claude Code keeps its own copy of the conversation). */
  async remove(slug: string, id: string): Promise<void> {
    this.getOr404(slug, id);
    const run = this.runs.get(this.key(slug, id));
    if (run) {
      this.stop(slug, id);
      await Promise.race([run.done, Bun.sleep(6000)]);
    }
    rmSync(this.file(slug, id), { force: true });
    rmSync(this.activityPath(slug, id), { force: true });
    this.bus.emit({ type: "chat.updated", profile: slug, id, chat: null });
  }

  /**
   * Make ticket: a Backlog ticket that continues this conversation. The chat is marked with the ticket and takes no
   * more messages, so two runs never share one conversation.
   */
  async makeTicket(slug: string, id: string): Promise<{ ticket: Ticket; chat: QuickChatView }> {
    const k = this.key(slug, id);
    if (this.making.has(k)) throw new QuickChatError(409, "This chat is already being made into a ticket.");
    this.making.add(k);
    try {
      return await this.makeTicketNow(slug, id);
    } finally {
      this.making.delete(k);
    }
  }

  private async makeTicketNow(slug: string, id: string): Promise<{ ticket: Ticket; chat: QuickChatView }> {
    const c = this.getOr404(slug, id);
    if (c.ticketId && this.store.getTicket(slug, c.ticketId)) throw new QuickChatError(409, "This chat is already a ticket.");
    if (this.isRunning(slug, id)) throw new QuickChatError(409, "Claude is still replying. Wait for it to finish, or stop it, then try again.");
    if (!c.started && !this.sessionExists(c.sessionId)) throw new QuickChatError(409, "Send Claude a message first.");
    const title = c.title ?? autoTitle(c.firstMessage);
    const first = (c.firstMessage ?? "").trim();
    const body = `Started from a quick chat with Claude on the board.${first ? `\n\nFirst message:\n\n${first.split("\n").map((l) => `> ${l}`).join("\n")}` : ""}`;
    let t = await this.board.createTicket(slug, { title, body, status: "backlog" });
    try {
      await this.board.linkSession(slug, t.id, c.sessionId);
      t = await this.board.updateTicket(slug, t.id, { status: "backlog" });
    } catch (e) {
      await this.board.deleteTicket(slug, t.id).catch(() => {});
      throw new QuickChatError(400, (e as Error).message);
    }
    this.store.addComment(slug, t.id, "ai", "Made from a quick chat: its conversation with Claude continues in this ticket's chat.");
    // Deleted meanwhile: the ticket stays, the chat is gone.
    const chat = this.patch(slug, id, { ticketId: t.id, started: true }) ?? { ...c, ticketId: t.id, started: true };
    return { ticket: t, chat: this.view(slug, chat) };
  }

  /** Daemon exiting: replies in progress are marked so recover() continues them; every run is stopped. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const runs = [...this.runs.values()];
    for (const run of runs) {
      if (run.stopRequested) continue;
      const c = this.get(run.slug, run.id);
      if (c) {
        const pending = [...(c.pending ?? []), ...run.later];
        this.save(run.slug, { ...c, interrupted: run.started ? {} : { prompt: run.prompt }, ...(pending.length ? { pending } : {}) });
      }
      run.stopRequested = true;
      run.handle?.stop();
    }
    await Promise.race([Promise.all(runs.map((r) => r.done)), Bun.sleep(6000)]);
  }

  /** After a restart: continue replies it cut off and send messages it held. */
  recover(): void {
    for (const p of this.store.listProfiles()) {
      for (const c of this.list(p.slug)) {
        if (!c.interrupted && !c.pending?.length) continue;
        const texts = [...(c.interrupted ? [c.interrupted.prompt ?? CONTINUE_TEXT] : []), ...(c.pending ?? [])];
        const { pending: _p, interrupted: _i, ...rest } = c;
        const next: QuickChat = rest;
        this.save(p.slug, next);
        if (!next.ticketId) this.start(p.slug, p, next, texts.join("\n\n"));
      }
    }
  }

  /** Runs in progress (tests). */
  async idle(): Promise<void> {
    while (this.runs.size) await Promise.all([...this.runs.values()].map((r) => r.done));
  }
}
