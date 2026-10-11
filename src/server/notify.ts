// "Needs you" notifications: when a ticket starts waiting on the user (attention.ts), tell them once, off the Mac too.
// Sends to a webhook (ntfy topic URL or any JSON endpoint) and/or shows a macOS banner, per kind (notify.json).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AttentionKind, type HostHuddle, ticketAttention } from "./attention";
import type { Bus } from "./events";
import { run as runCmd } from "./git";
import type { SessionSummary } from "./session";
import type { Store } from "./store";
import { nowIso } from "./util";

export const NOTIFY_KINDS: AttentionKind[] = ["questions", "proposal", "review", "failed", "limit", "blocked", "huddle", "reply"];

/** How the webhook gets the message. auto: ntfy when the URL's host has "ntfy" in it, else JSON. */
export type WebhookFormat = "auto" | "ntfy" | "json";

export interface NotifySettings {
  /** Empty: no webhook. */
  webhookUrl: string;
  format: WebhookFormat;
  /** macOS banner on this Mac. */
  mac: boolean;
  kinds: Record<AttentionKind, boolean>;
}

/** What the settings dialog shows besides the settings: how the last send went. */
export interface NotifyState extends NotifySettings {
  lastSentAt: string | null;
  lastError: string | null;
}

// "Claude replied" fires on every Planning chat turn, mostly while the user is watching: off until they want it.
export const DEFAULT_NOTIFY: NotifySettings = {
  webhookUrl: "",
  format: "auto",
  mac: true,
  kinds: { questions: true, proposal: true, review: true, failed: true, limit: true, blocked: true, huddle: true, reply: false },
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
  kind: AttentionKind;
  /** The attention label, e.g. "Answer 2 questions". */
  label: string;
  /** Deep link to the ticket. */
  url: string;
}

/** HTTP headers allow Latin-1 only; ntfy reads RFC 2047 encoded words for anything else. */
export function headerValue(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${Buffer.from(flat, "utf8").toString("base64")}?=`;
}

const NTFY_TAGS: Record<AttentionKind, string> = {
  questions: "question", proposal: "memo", review: "eyes", failed: "x", limit: "hourglass", blocked: "no_entry", huddle: "speech_balloon", reply: "speech_balloon",
};

/** The webhook request: ntfy (plain text body, Title/Click/Tags headers) or JSON {board, ticketId, title, kind, url}. */
export function webhookRequest(s: Pick<NotifySettings, "webhookUrl" | "format">, m: NotifyMessage): { url: string; init: RequestInit } {
  if (isNtfy(s)) {
    return {
      url: s.webhookUrl,
      init: {
        method: "POST",
        headers: { Title: headerValue(`${m.label}: ${m.title}`), Click: m.url, Tags: NTFY_TAGS[m.kind], "Content-Type": "text/plain; charset=utf-8" },
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
}

export class Notifier {
  private tracker: TransitionTracker;
  private dirty = new Set<string>();
  private lastSentAt: string | null = null;
  private lastError: string | null = null;
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
    return { ...this.settings(), lastSentAt: this.lastSentAt, lastError: this.lastError };
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

  /** A banner on this Mac (when on); not sent to the webhook. For board events that aren't "needs you" (plan done). */
  macOnly(title: string, body: string): void {
    if (this.settings().mac) this.banner(title, body);
  }

  /** Banner and webhook as configured. Resolves with the webhook error, or null. */
  async send(settings: NotifySettings, m: NotifyMessage): Promise<string | null> {
    if (settings.mac) this.banner(`${m.label}: ${m.title}`, m.boardName);
    if (!settings.webhookUrl) return null;
    const { url, init } = webhookRequest(settings, m);
    let error: string | null = null;
    try {
      const r = await this.fetch(url, init);
      if (!r.ok) error = `webhook answered ${r.status} ${r.statusText}`.trim();
    } catch (e) {
      error = `webhook failed: ${(e as Error).message}`;
    }
    if (error) console.warn(`notify: ${error}`);
    this.lastError = error;
    if (!error) this.lastSentAt = nowIso();
    return error;
  }

  /** The "Send test notification" button: a sample message through banner and webhook, whatever the kind toggles say. */
  async test(slug?: string): Promise<{ ok: boolean; error: string | null; webhook: boolean }> {
    const settings = this.settings();
    const p = slug ? this.store.getProfile(slug) : this.store.listProfiles()[0];
    const error = await this.send(settings, {
      board: p?.slug ?? "", boardName: p?.name ?? "ckanban", ticketId: "", title: "Test notification", kind: "review",
      label: "ckanban", url: p ? this.link(p.slug) : `${this.o.baseUrl()}/`,
    });
    return { ok: !error, error, webhook: !!settings.webhookUrl };
  }
}
