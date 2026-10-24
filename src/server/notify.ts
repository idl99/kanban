// "Needs you" notifications: when a ticket starts waiting on the user (attention.ts), tell them once, off the Mac too.
// A ticket's Claude can also send its own message (notify_user, Notifier.message). Sends to a webhook (ntfy topic URL or any JSON endpoint), to devices that turned phone push on (push.ts) and/or
// shows a macOS banner, per kind (notify.json).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AttentionKind, type HostHuddle, ticketAttention } from "./attention";
import type { Bus } from "./events";
import { run as runCmd } from "./git";
import type { PushPayload, PushService } from "./push";
import type { SessionSummary } from "./session";
import type { Store } from "./store";
import { nowIso } from "./util";

/** What a notification is about: a "needs you" kind, or a message a ticket's Claude wrote itself (notify_user). */
export type NotifyKind = AttentionKind | "message";

export const NOTIFY_KINDS: NotifyKind[] = ["stalled", "questions", "proposal", "review", "failed", "limit", "blocked", "huddle", "reply", "message"];

/** Longest notify_user message: it has to fit a phone notification. */
export const CLAUDE_MESSAGE_MAX = 200;
/** notify_user sends at most one message per ticket in this time (stops a runaway loop, not a careful Claude). */
export const CLAUDE_MESSAGE_GAP_MS = 10 * 60_000;

/** notify_user input the board refuses; status is the HTTP status. */
export class MessageError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** What notify_user tells Claude: where the message went, or why it went nowhere. */
export interface MessageResult {
  /** Reached the user somewhere (a device, the webhook or the macOS banner). */
  delivered: boolean;
  /** Phones and browsers that got it. */
  devices: number;
  /** Devices skipped because the board is on screen there right now. */
  onScreen: number;
  webhook: boolean;
  banner: boolean;
  /** Why it went nowhere: "off" (Messages from Claude is off), "nowhere" (no device, webhook or banner), "on-screen". */
  reason: "off" | "nowhere" | "on-screen" | null;
  error: string | null;
}

/** How the webhook gets the message. auto: ntfy when the URL's host has "ntfy" in it, else JSON. */
export type WebhookFormat = "auto" | "ntfy" | "json";

export interface NotifySettings {
  /** Empty: no webhook. */
  webhookUrl: string;
  format: WebhookFormat;
  /** macOS banner on this Mac (skipped while a browser on this Mac gets notifications, see Notifier.macBrowser). */
  mac: boolean;
  kinds: Record<NotifyKind, boolean>;
}

/** What the settings dialog shows besides the settings: how the last send went. */
export interface NotifyState extends NotifySettings {
  lastSentAt: string | null;
  lastError: string | null;
  /** A browser on this Mac gets notifications, so the macOS banner isn't used (see Notifier.macBrowser). */
  macBrowser: boolean;
}

// "Claude replied" fires on every Planning chat turn, mostly while the user is watching: off until they want it.
export const DEFAULT_NOTIFY: NotifySettings = {
  webhookUrl: "",
  format: "auto",
  mac: true,
  kinds: { stalled: true, questions: true, proposal: true, review: true, failed: true, limit: true, blocked: true, huddle: true, reply: false, message: true },
};

/** Settings in `<root>/notify.json`; defaults for anything missing or invalid. */
export function readNotifySettings(root: string): NotifySettings {
  const file = join(root, "notify.json");
  if (!existsSync(file)) return structuredClone(DEFAULT_NOTIFY);
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return structuredClone(DEFAULT_NOTIFY);
  }
}

export function writeNotifySettings(root: string, s: NotifySettings): void {
  const file = join(root, "notify.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

/** Merge a partial update into settings. Throws on a webhook URL that isn't http(s). */
export function normalizeSettings(raw: any, base: NotifySettings = DEFAULT_NOTIFY): NotifySettings {
  const out = structuredClone(base);
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.webhookUrl === "string") {
    const url = raw.webhookUrl.trim();
    if (url) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new Error("webhook URL is not a valid URL");
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("webhook URL must start with https:// or http://");
    }
    out.webhookUrl = url;
  }
  if (raw.format === "auto" || raw.format === "ntfy" || raw.format === "json") out.format = raw.format;
  if (typeof raw.mac === "boolean") out.mac = raw.mac;
  if (raw.kinds && typeof raw.kinds === "object") {
    for (const k of NOTIFY_KINDS) if (typeof raw.kinds[k] === "boolean") out.kinds[k] = raw.kinds[k];
  }
  return out;
}

export function isNtfy(s: Pick<NotifySettings, "webhookUrl" | "format">): boolean {
  if (s.format !== "auto") return s.format === "ntfy";
  try {
    return new URL(s.webhookUrl).hostname.includes("ntfy");
  } catch {
    return false;
  }
}

/** One "needs you" message. */
export interface NotifyMessage {
  board: string;
  boardName: string;
  ticketId: string;
  title: string;
  kind: NotifyKind;
  /** The attention label, e.g. "Answer 2 questions", or Claude's own text for kind "message". */
  label: string;
  /** Deep link to the ticket. */
  url: string;
}

/** A phone notification: the ticket as title, what it needs (and the board) below; one per ticket on screen. */
export function pushPayload(m: NotifyMessage): PushPayload {
  return { title: m.title, body: `${m.label} · ${m.boardName}`, url: m.url, tag: m.ticketId ? `${m.board}/${m.ticketId}` : "ckanban" };
}

/** HTTP headers allow Latin-1 only; ntfy reads RFC 2047 encoded words for anything else. */
export function headerValue(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${Buffer.from(flat, "utf8").toString("base64")}?=`;
}

const NTFY_TAGS: Record<NotifyKind, string> = {
  stalled: "warning", questions: "question", proposal: "memo", review: "eyes", failed: "x", limit: "hourglass", blocked: "no_entry", huddle: "speech_balloon", reply: "speech_balloon", message: "bell",
};

/** The webhook request: ntfy (plain text body, Title/Click/Tags headers) or JSON {board, ticketId, title, kind, url}. */
export function webhookRequest(s: Pick<NotifySettings, "webhookUrl" | "format">, m: NotifyMessage): { url: string; init: RequestInit } {
  if (isNtfy(s)) {
    return {
      url: s.webhookUrl,
      init: {
        method: "POST",
        headers: { Title: headerValue(m.kind === "message" ? m.title : `${m.label}: ${m.title}`), Click: m.url, Tags: NTFY_TAGS[m.kind], "Content-Type": "text/plain; charset=utf-8" },
        body: `${m.boardName} · ${m.label}`,
      },
    };
  }
  return {
    url: s.webhookUrl,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board: m.board, boardName: m.boardName, ticketId: m.ticketId, title: m.title, kind: m.kind, label: m.label, url: m.url }),
    },
  };
}

/** macOS notification; silently nothing elsewhere or when osascript fails. */
export function macBanner(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const q = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").slice(0, 240));
  runCmd(["osascript", "-e", `display notification ${q(body)} with title ${q(title)}`], homedir()).catch(() => {});
}

/**
 * Turns a stream of "what does this ticket need now" observations into notifications: one per transition into a
 * kind. A new state (a kind, or not waiting) counts only once it has held for debounceMs, so flicker (a run ending
 * and the next starting, questions answered and re-asked) neither notifies twice nor misses a real change.
 */
export class TransitionTracker {
  private states = new Map<string, { settled: AttentionKind | null; seen: AttentionKind | null; since: number }>();

  constructor(private debounceMs: number) {}

  /** Record the current state without notifying (what was already waiting when the daemon started). */
  seed(key: string, kind: AttentionKind | null, now: number): void {
    this.states.set(key, { settled: kind, seen: kind, since: now });
  }

  /** The kind to notify about now, or null. Call again later (see unsettled) to let a pending change settle. */
  observe(key: string, kind: AttentionKind | null, now: number): AttentionKind | null {
    let s = this.states.get(key);
    if (!s) {
      // First sight of a ticket after startup: it's new, so it wasn't waiting before.
      s = { settled: null, seen: kind, since: now };
      this.states.set(key, s);
    }
    if (s.seen !== kind) {
      s.seen = kind;
      s.since = now;
    }
    if (s.seen === s.settled || now - s.since < this.debounceMs) return null;
    s.settled = s.seen;
    return s.settled;
  }

  /** Tickets whose latest state hasn't settled yet. */
  unsettled(): string[] {
    return [...this.states].filter(([, s]) => s.seen !== s.settled).map(([k]) => k);
  }

  forget(key: string): void {
    this.states.delete(key);
  }
}

export interface NotifierOptions {
  root: string;
  sessionSummary: (sessionId: string) => SessionSummary | null;
  isRunning: (slug: string, id: string) => boolean;
  hostHuddles: (slug: string) => Map<string, HostHuddle>;
  /** Where links point: the tailnet URL when phone access is on, else this Mac's localhost. */
  baseUrl: () => string;
  debounceMs?: number;
  tickMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  banner?: (title: string, body: string) => void;
  now?: () => number;
  /** Phone push to the devices that turned it on; omitted: none. */
  push?: PushService;
}

export class Notifier {
  private tracker: TransitionTracker;
  private dirty = new Set<string>();
  private lastSentAt: string | null = null;
  private lastError: string | null = null;
  /** When each ticket's Claude last reached the user with notify_user (the spam guard). */
  private lastMessage = new Map<string, number>();
  private fetch: (url: string, init: RequestInit) => Promise<Response>;
  private banner: (title: string, body: string) => void;
  private now: () => number;

  constructor(private store: Store, private bus: Bus, private o: NotifierOptions) {
    this.tracker = new TransitionTracker(o.debounceMs ?? 5000);
    this.fetch = o.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }));
    this.banner = o.banner ?? macBanner;
    this.now = o.now ?? Date.now;
  }

  settings(): NotifySettings {
    return readNotifySettings(this.o.root);
  }

  state(): NotifyState {
    return { ...this.settings(), lastSentAt: this.lastSentAt, lastError: this.lastError, macBrowser: this.macBrowser() };
  }

  update(patch: unknown): NotifyState {
    writeNotifySettings(this.o.root, normalizeSettings(patch, this.settings()));
    return this.state();
  }

  /** Seeds what already waits (no notification for it), then follows ticket, session and huddle changes. */
  start(): () => void {
    const now = this.now();
    for (const p of this.store.listProfiles()) {
      for (const t of this.store.listTickets(p.slug)) this.tracker.seed(`${p.slug}/${t.id}`, this.kindOf(p.slug, t.id), now);
    }
    const off = this.bus.on((e) => {
      if (e.type === "ticket.updated") this.dirty.add(`${e.profile}/${e.ticket.id}`);
      else if (e.type === "session.updated") this.dirty.add(`${e.profile}/${e.id}`);
      else if (e.type === "huddle.updated" && e.huddle.hostTicket) this.dirty.add(`${e.profile}/${e.huddle.hostTicket}`);
      else if (e.type === "ticket.deleted") this.tracker.forget(`${e.profile}/${e.id}`);
    });
    const timer = setInterval(() => this.tick(), this.o.tickMs ?? 1000);
    return () => {
      off();
      clearInterval(timer);
    };
  }

  /** Look again at changed tickets and those whose change is still settling; notify the transitions. */
  tick(): void {
    const keys = new Set([...this.dirty, ...this.tracker.unsettled()]);
    this.dirty.clear();
    const now = this.now();
    for (const key of keys) {
      const [slug, id] = key.split("/");
      const kind = this.tracker.observe(key, this.kindOf(slug, id), now);
      if (kind) this.fire(slug, id, kind);
    }
  }

  private kindOf(slug: string, id: string): AttentionKind | null {
    const t = this.store.getTicket(slug, id);
    if (!t) return null;
    const s = t.sessionId ? this.o.sessionSummary(t.sessionId) : null;
    return ticketAttention(this.store, slug, t, s, this.o.isRunning(slug, id), this.o.hostHuddles(slug).get(id))?.kind ?? null;
  }

  private fire(slug: string, id: string, kind: AttentionKind) {
    const settings = this.settings();
    if (!settings.kinds[kind]) return;
    const t = this.store.getTicket(slug, id);
    const p = this.store.getProfile(slug);
    if (!t || !p) return;
    const s = t.sessionId ? this.o.sessionSummary(t.sessionId) : null;
    const att = ticketAttention(this.store, slug, t, s, this.o.isRunning(slug, id), this.o.hostHuddles(slug).get(id));
    void this.send(settings, {
      board: slug, boardName: p.name, ticketId: id, title: t.title, kind, label: att?.label ?? kind, url: this.link(slug, id),
    });
  }

  link(slug: string, id?: string): string {
    return `${this.o.baseUrl()}/#/${encodeURIComponent(slug)}${id ? `/${encodeURIComponent(id)}` : ""}`;
  }

  /**
   * Whether a browser on this Mac gets notifications. Then it replaces the macOS banner: its notifications open the
   * ticket when clicked, the banner can't (a click opens Finder or Script Editor).
   */
  private macBrowser(): boolean {
    return !!this.o.push?.hasThisMac();
  }

  /**
   * Only on this Mac (when the banner is on), not to the webhook or phones. For board events that aren't "needs you"
   * (plan done). `url` is the ticket a click opens.
   */
  macOnly(title: string, body: string, url: string): void {
    if (!this.settings().mac) return;
    if (!this.macBrowser()) return this.banner(title, body);
    void this.o.push!.send({ title, body, url, tag: url }, { thisMac: true }).then((r) => r.error && console.warn(`notify: ${r.error}`));
  }

  /**
   * Banner, webhook and phone push as configured. Resolves with the first error, or null. Push skips devices with
   * the board on screen unless `everyDevice` (the test button).
   */
  async send(settings: NotifySettings, m: NotifyMessage, everyDevice = false): Promise<string | null> {
    if (settings.mac && !this.macBrowser()) this.banner(`${m.label}: ${m.title}`, m.boardName);
    const [hook, push] = await Promise.all([this.sendWebhook(settings, m), this.sendPush(m, everyDevice)]);
    const error = hook.error ?? push.error;
    if (error) console.warn(`notify: ${error}`);
    if (hook.sent || push.sent || error) this.lastError = error;
    if (hook.sent || push.sent) this.lastSentAt = nowIso();
    return error;
  }

  private async sendWebhook(settings: NotifySettings, m: NotifyMessage): Promise<{ sent: boolean; error: string | null }> {
    if (!settings.webhookUrl) return { sent: false, error: null };
    const { url, init } = webhookRequest(settings, m);
    try {
      const r = await this.fetch(url, init);
      return r.ok ? { sent: true, error: null } : { sent: false, error: `webhook answered ${r.status} ${r.statusText}`.trim() };
    } catch (e) {
      return { sent: false, error: `webhook failed: ${(e as Error).message}` };
    }
  }

  /**
   * notify_user: a ticket's Claude tells the user something in its own words (ticket title above, its text below; a
   * tap opens the ticket). Same channels and on-screen skip as "needs you"; at most one per ticket per
   * CLAUDE_MESSAGE_GAP_MS. Logged on the ticket when it reached the user.
   */
  async message(slug: string, id: string, raw: string): Promise<MessageResult> {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) throw new MessageError("message is required: what you need from the user, in one short sentence");
    if (text.length > CLAUDE_MESSAGE_MAX) throw new MessageError(`message is too long (${text.length} characters, max ${CLAUDE_MESSAGE_MAX}): keep it to one short ask`);
    const t = this.store.getTicket(slug, id);
    const p = this.store.getProfile(slug);
    if (!t || !p) throw new MessageError(`ticket ${id} not found`, 404);
    const key = `${slug}/${id}`;
    const last = this.lastMessage.get(key);
    const now = this.now();
    if (last !== undefined && now - last < CLAUDE_MESSAGE_GAP_MS) {
      const next = new Date(last + CLAUDE_MESSAGE_GAP_MS);
      throw new MessageError(`a message was already sent for this ticket in the last ${CLAUDE_MESSAGE_GAP_MS / 60_000} minutes; the next one is allowed after ${next.toISOString()}`, 429);
    }
    const none = { delivered: false, devices: 0, onScreen: 0, webhook: false, banner: false, error: null };
    const settings = this.settings();
    if (!settings.kinds.message) return { ...none, reason: "off" };
    const m: NotifyMessage = { board: slug, boardName: p.name, ticketId: id, title: t.title, kind: "message", label: text, url: this.link(slug, id) };
    const banner = settings.mac && !this.macBrowser();
    if (banner) this.banner(t.title, text);
    const [hook, push] = await Promise.all([
      this.sendWebhook(settings, m),
      this.o.push ? this.o.push.send(pushPayload(m)) : Promise.resolve({ sent: 0, removed: 0, onScreen: 0, error: null }),
    ]);
    const error = hook.error ?? push.error;
    if (error) console.warn(`notify: ${error}`);
    if (hook.sent || push.sent || error) this.lastError = error;
    if (hook.sent || push.sent) this.lastSentAt = nowIso();
    const delivered = banner || hook.sent || push.sent > 0;
    if (delivered) {
      this.lastMessage.set(key, now);
      this.store.addComment(slug, id, "ai", `Sent you a notification: ${text}`);
    }
    return {
      delivered, devices: push.sent, onScreen: push.onScreen, webhook: hook.sent, banner, error,
      reason: delivered ? null : push.onScreen ? "on-screen" : error ? null : "nowhere",
    };
  }

  private async sendPush(m: NotifyMessage, everyDevice: boolean): Promise<{ sent: number; error: string | null }> {
    if (!this.o.push) return { sent: 0, error: null };
    return this.o.push.send(pushPayload(m), { skipVisible: !everyDevice });
  }

  private testMessage(slug?: string): NotifyMessage {
    const p = slug ? this.store.getProfile(slug) : this.store.listProfiles()[0];
    return {
      board: p?.slug ?? "", boardName: p?.name ?? "ckanban", ticketId: "", title: "Test notification", kind: "review",
      label: "ckanban", url: p ? this.link(p.slug) : `${this.o.baseUrl()}/`,
    };
  }

  /**
   * The "Send test notification" button: a sample message through banner, webhook and every phone (the board is on
   * screen there, so the visible skip doesn't apply), whatever the kind toggles say.
   */
  async test(slug?: string): Promise<{ ok: boolean; error: string | null; webhook: boolean; devices: number }> {
    const settings = this.settings();
    const error = await this.send(settings, this.testMessage(slug), true);
    return { ok: !error, error, webhook: !!settings.webhookUrl, devices: this.o.push?.devices().length ?? 0 };
  }

  /** A device's own "Send test": that device only. */
  async testDevice(id: string, slug?: string): Promise<{ ok: boolean; error: string | null }> {
    if (!this.o.push) return { ok: false, error: "phone push is not available" };
    const r = await this.o.push.send(pushPayload(this.testMessage(slug)), { only: id, skipVisible: false });
    const error = r.error ?? (r.removed ? "this device no longer accepts notifications: turn them on again" : r.sent ? null : "device not found");
    return { ok: !error, error };
  }
}
