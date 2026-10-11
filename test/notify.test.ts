import { beforeEach, expect, test } from "bun:test";
import { Bus } from "../src/server/events";
import {
  DEFAULT_NOTIFY, headerValue, isNtfy, normalizeSettings, Notifier, readNotifySettings, TransitionTracker, webhookRequest, writeNotifySettings,
  type NotifyMessage,
} from "../src/server/notify";
import { Store } from "../src/server/store";
import type { Profile, Ticket } from "../src/server/types";
import { tempDir } from "./helpers";

test("a kind notifies once it has held for the debounce, and only once while it stays", () => {
  const t = new TransitionTracker(1000);
  expect(t.observe("a", "review", 0)).toBeNull();
  expect(t.unsettled()).toEqual(["a"]);
  expect(t.observe("a", "review", 999)).toBeNull();
  expect(t.observe("a", "review", 1000)).toBe("review");
  expect(t.unsettled()).toEqual([]);
  expect(t.observe("a", "review", 5000)).toBeNull();
  expect(t.observe("a", "review", 60_000)).toBeNull();
});

test("flicker inside the debounce neither notifies nor re-arms", () => {
  const t = new TransitionTracker(1000);
  t.seed("a", "questions", 0);
  // Answered, then asked again quickly: still the same wait.
  expect(t.observe("a", null, 100)).toBeNull();
  expect(t.observe("a", "questions", 400)).toBeNull();
  expect(t.observe("a", "questions", 5000)).toBeNull();
  // A run ending and the next starting: a short blip of "failed" is not a transition.
  const u = new TransitionTracker(1000);
  expect(u.observe("b", "failed", 0)).toBeNull();
  expect(u.observe("b", null, 500)).toBeNull();
  expect(u.observe("b", null, 2000)).toBeNull();
  expect(u.unsettled()).toEqual([]);
});

test("leaving and coming back after the debounce notifies again; a new kind notifies", () => {
  const t = new TransitionTracker(1000);
  t.seed("a", "review", 0);
  expect(t.observe("a", "review", 10)).toBeNull();
  expect(t.observe("a", null, 100)).toBeNull();
  expect(t.observe("a", null, 1200)).toBeNull();
  expect(t.observe("a", "failed", 2000)).toBeNull();
  expect(t.observe("a", "failed", 3000)).toBe("failed");
  expect(t.observe("a", "questions", 3100)).toBeNull();
  expect(t.observe("a", "questions", 4100)).toBe("questions");
});

test("seeded state (waiting when the daemon started) does not notify; unseen tickets start from not waiting", () => {
  const t = new TransitionTracker(0);
  t.seed("a", "review", 0);
  expect(t.observe("a", "review", 1)).toBeNull();
  expect(t.observe("new", "questions", 1)).toBe("questions");
});

const msg: NotifyMessage = {
  board: "kb", boardName: "Kanban", ticketId: "t_1", title: "Fix the thing", kind: "review", label: "Ready for review", url: "https://mac.ts.net/#/kb/t_1",
};

test("ntfy URLs get plain text with Title, Click and Tags headers", () => {
  const { url, init } = webhookRequest({ webhookUrl: "https://ntfy.sh/my-topic", format: "auto" }, msg);
  expect(url).toBe("https://ntfy.sh/my-topic");
  expect(init.method).toBe("POST");
  const h = init.headers as Record<string, string>;
  expect(h.Title).toBe("Ready for review: Fix the thing");
  expect(h.Click).toBe("https://mac.ts.net/#/kb/t_1");
  expect(h.Tags).toBe("eyes");
  expect(init.body).toBe("Kanban · Ready for review");
});

test("other URLs get JSON", () => {
  const { init } = webhookRequest({ webhookUrl: "https://hooks.example.com/x", format: "auto" }, msg);
  expect(JSON.parse(init.body as string)).toEqual({
    board: "kb", boardName: "Kanban", ticketId: "t_1", title: "Fix the thing", kind: "review", label: "Ready for review", url: "https://mac.ts.net/#/kb/t_1",
  });
  expect(isNtfy({ webhookUrl: "https://push.example.com/t", format: "ntfy" })).toBe(true);
  expect(isNtfy({ webhookUrl: "https://ntfy.example.com/t", format: "json" })).toBe(false);
  expect(isNtfy({ webhookUrl: "https://ntfy.example.com/t", format: "auto" })).toBe(true);
});

test("non-ASCII titles are RFC 2047 encoded for the header", () => {
  expect(headerValue("plain  title")).toBe("plain title");
  const enc = headerValue("Ready: café ✓");
  expect(enc).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  expect(Buffer.from(enc.slice(10, -2), "base64").toString("utf8")).toBe("Ready: café ✓");
  // fetch would throw on a header with these characters.
  expect(() => new Headers({ Title: enc })).not.toThrow();
});

test("settings: defaults, partial updates, URL validation, file round trip", () => {
  expect(DEFAULT_NOTIFY.kinds.reply).toBe(false);
  const s = normalizeSettings({ webhookUrl: " https://ntfy.sh/t ", kinds: { review: false, bogus: true }, mac: false });
  expect(s.webhookUrl).toBe("https://ntfy.sh/t");
  expect(s.kinds.review).toBe(false);
  expect(s.kinds.questions).toBe(true);
  expect(s.mac).toBe(false);
  expect((s.kinds as any).bogus).toBeUndefined();
  expect(() => normalizeSettings({ webhookUrl: "file:///etc/passwd" })).toThrow();
  expect(() => normalizeSettings({ webhookUrl: "not a url" })).toThrow();
  expect(normalizeSettings({ webhookUrl: "" }).webhookUrl).toBe("");
  const root = tempDir();
  expect(readNotifySettings(root)).toEqual(DEFAULT_NOTIFY);
  writeNotifySettings(root, s);
  expect(readNotifySettings(root)).toEqual(s);
});

describeNotifier();

function describeNotifier() {
  let store: Store;
  let bus: Bus;
  let clock: number;
  let sent: { url: string; init: RequestInit }[];
  let banners: string[];
  let running: Set<string>;
  let notifier: Notifier;
  let ticket: Ticket;

  beforeEach(() => {
    store = new Store(tempDir("ck-home-"));
    bus = new Bus();
    clock = 0;
    sent = [];
    banners = [];
    running = new Set();
    const p: Profile = { name: "Kanban", slug: "kb", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" };
    store.saveProfile(p);
    ticket = store.createTicket("kb", { title: "Fix it", body: "b", status: "in_progress" });
    writeNotifySettings(store.root, normalizeSettings({ webhookUrl: "https://ntfy.sh/topic" }));
    notifier = new Notifier(store, bus, {
      root: store.root, sessionSummary: () => null, isRunning: (_s, id) => running.has(id), hostHuddles: () => new Map(),
      baseUrl: () => "https://mac.tail.ts.net", debounceMs: 1000, tickMs: 60_000, now: () => clock,
      fetch: async (url, init) => {
        sent.push({ url, init });
        return new Response("ok");
      },
      banner: (title) => banners.push(title),
    });
  });

  const move = (patch: Partial<Ticket>) => {
    const t = store.updateTicket("kb", ticket.id, patch);
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: t });
  };
  const after = async (ms: number) => {
    clock += ms;
    notifier.tick();
    await Promise.resolve();
  };
  /** The next tick sees the change, the one a debounce later sends it. */
  const settle = async () => {
    await after(0);
    await after(1000);
  };

  test("a ticket moving to Review sends one notification with a deep link, and a banner", async () => {
    const stop = notifier.start();
    move({ status: "review", outcome: "done" });
    await after(0);
    expect(sent).toHaveLength(0);
    await after(1000);
    expect(sent).toHaveLength(1);
    const h = sent[0].init.headers as Record<string, string>;
    expect(sent[0].url).toBe("https://ntfy.sh/topic");
    expect(h.Title).toBe("Ready for review: Fix it");
    expect(h.Click).toBe(`https://mac.tail.ts.net/#/kb/${ticket.id}`);
    expect(banners).toEqual(["Ready for review: Fix it"]);
    // Still in Review: nothing more.
    move({ title: "Fix it" });
    await after(5000);
    expect(sent).toHaveLength(1);
    stop();
  });

  test("failed and usage limit notify; a kind toggled off doesn't", async () => {
    const stop = notifier.start();
    move({ status: "review", outcome: "failed" });
    await settle();
    expect((sent[0].init.headers as Record<string, string>).Title).toBe("Run failed: Fix it");
    move({ outcome: "limit" });
    await settle();
    expect(sent).toHaveLength(2);
    expect((sent[1].init.headers as Record<string, string>).Title).toBe("Limit hit: Fix it");
    notifier.update({ kinds: { review: false }, mac: false });
    move({ outcome: "done" });
    await settle();
    expect(sent).toHaveLength(2);
    expect(banners).toHaveLength(2);
    stop();
  });

  test("tickets already waiting at startup don't notify", async () => {
    move({ status: "review", outcome: "done" });
    const stop = notifier.start();
    move({ title: "Fix it again" });
    await after(2000);
    expect(sent).toHaveLength(0);
    stop();
  });

  test("a run starting and ending quickly doesn't notify twice", async () => {
    const stop = notifier.start();
    move({ status: "review", outcome: "done" });
    await settle();
    expect(sent).toHaveLength(1);
    // Chat reply in Review: running for a moment, then back.
    running.add(ticket.id);
    move({});
    await after(300);
    running.delete(ticket.id);
    move({});
    await after(2000);
    expect(sent).toHaveLength(1);
    stop();
  });

  test("test notification goes out whatever the toggles, and webhook errors are kept", async () => {
    notifier = new Notifier(store, bus, {
      root: store.root, sessionSummary: () => null, isRunning: () => false, hostHuddles: () => new Map(), baseUrl: () => "http://localhost:3000",
      fetch: async () => new Response("nope", { status: 403, statusText: "Forbidden" }), banner: () => {},
    });
    const r = await notifier.test("kb");
    expect(r).toEqual({ ok: false, error: "webhook answered 403 Forbidden", webhook: true });
    expect(notifier.state().lastError).toBe("webhook answered 403 Forbidden");
  });
}
