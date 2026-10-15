import { describe, expect, test } from "bun:test";
import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../src/server/events";
import { normalizeSettings, Notifier, pushPayload, writeNotifySettings } from "../src/server/notify";
import { PushService, VISIBLE_MS } from "../src/server/push";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";
import { b64url, decryptPayload, encryptPayload, fromB64url, generateVapidKeys, pushRequest, vapidJwt } from "../src/server/webpush";
import { tempDir } from "./helpers";

// RFC 8291 section 5 / appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** A fake browser: its key pair and auth secret, as a push subscription. */
function browser(endpoint = `https://fcm.googleapis.com/fcm/send/${b64url(randomBytes(8))}`) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = b64url(randomBytes(16));
  return { sub: { endpoint, keys: { p256dh: b64url(ecdh.getPublicKey()), auth } }, privateKey: b64url(ecdh.getPrivateKey()), auth };
}

describe("web push crypto", () => {
  test("aes128gcm encryption matches the RFC 8291 test vector", () => {
    const out = encryptPayload(Buffer.from(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, { senderPrivateKey: RFC.asPrivate, salt: RFC.salt });
    expect(b64url(out)).toBe(RFC.body);
    expect(decryptPayload(fromB64url(RFC.body), RFC.uaPrivate, RFC.auth).toString()).toBe(RFC.plaintext);
  });

  test("a random sender key and salt still decrypt on the browser side", () => {
    const b = browser();
    const out = encryptPayload(Buffer.from("hello"), b.sub.keys);
    expect(decryptPayload(out, b.privateKey, b.auth).toString()).toBe("hello");
  });

  test("VAPID JWT: ES256 header, aud/exp/sub claims, a signature the public key verifies", () => {
    const keys = generateVapidKeys();
    expect(fromB64url(keys.publicKey)).toHaveLength(65);
    const jwt = vapidJwt("https://web.push.apple.com", "https://example.com", keys, 1000);
    const [h, p, sig] = jwt.split(".");
    expect(JSON.parse(fromB64url(h).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(fromB64url(p).toString())).toEqual({ aud: "https://web.push.apple.com", exp: 1000 + 12 * 3600, sub: "https://example.com" });
    const pub = fromB64url(keys.publicKey);
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) }, format: "jwk" });
    expect(fromB64url(sig)).toHaveLength(64);
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, fromB64url(sig))).toBe(true);
  });

  test("push request: VAPID authorization for the endpoint's origin and an encrypted body", () => {
    const keys = generateVapidKeys();
    const b = browser("https://web.push.apple.com/QH123");
    const { url, init } = pushRequest(b.sub, '{"title":"x"}', keys);
    const h = init.headers as Record<string, string>;
    expect(url).toBe("https://web.push.apple.com/QH123");
    expect(h["Content-Encoding"]).toBe("aes128gcm");
    expect(h.Authorization).toContain(`k=${keys.publicKey}`);
    const jwt = h.Authorization.match(/t=([^,]+)/)![1];
    expect(JSON.parse(fromB64url(jwt.split(".")[1]).toString()).aud).toBe("https://web.push.apple.com");
    expect(decryptPayload(init.body as Buffer, b.privateKey, b.auth).toString()).toBe('{"title":"x"}');
  });
});

describe("push devices", () => {
  const setup = (status = 201) => {
    const root = tempDir("ck-push-");
    let clock = 0;
    const calls: string[] = [];
    const push = new PushService(root, { now: () => clock, fetch: async (url) => (calls.push(url), new Response("", { status })) });
    return { root, push, calls, tick: (ms: number) => (clock += ms) };
  };

  test("keys are made once and kept owner-only; subscribe adds, re-subscribe replaces, remove drops", () => {
    const { root, push } = setup();
    const key = push.publicKey();
    expect(push.publicKey()).toBe(key);
    expect(statSync(join(root, "push.json")).mode & 0o777).toBe(0o600);
    const a = browser();
    const d = push.subscribe(a.sub, "iPhone · Safari (Home Screen)");
    push.subscribe(a.sub, "iPhone · Safari (Home Screen)");
    expect(push.devices()).toEqual([{ id: d.id, label: "iPhone · Safari (Home Screen)", createdAt: d.createdAt }]);
    expect(() => push.subscribe({ endpoint: "http://insecure/x", keys: a.sub.keys }, "x")).toThrow("https");
    expect(() => push.subscribe({ endpoint: "https://x/y" }, "x")).toThrow("keys");
    expect(push.remove(a.sub.endpoint)).toBe(true);
    expect(push.devices()).toEqual([]);
    expect(push.remove(d.id)).toBe(false);
  });

  test("a device the push service says is gone (410) is removed", async () => {
    const { push } = setup(410);
    push.subscribe(browser().sub, "Android");
    const r = await push.send({ title: "t", body: "b", url: "u" });
    expect(r).toEqual({ sent: 0, removed: 1, error: null });
    expect(push.devices()).toEqual([]);
  });

  test("other failures are reported and the device kept", async () => {
    const { push } = setup(500);
    push.subscribe(browser().sub, "Android");
    const r = await push.send({ title: "t", body: "b", url: "u" });
    expect(r.error).toBe("push to Android answered 500");
    expect(push.devices()).toHaveLength(1);
  });

  test("a device with the board on screen is skipped until its heartbeat runs out or it says hidden", async () => {
    const { push, calls, tick } = setup();
    const phone = browser(), mac = browser();
    push.subscribe(phone.sub, "Phone");
    push.subscribe(mac.sub, "Mac");
    push.setVisible(phone.sub.endpoint, true);
    await push.send({ title: "t", body: "b", url: "u" });
    expect(calls).toEqual([mac.sub.endpoint]);
    // The test button reaches it anyway.
    calls.length = 0;
    await push.send({ title: "t", body: "b", url: "u" }, { skipVisible: false });
    expect(calls.sort()).toEqual([phone.sub.endpoint, mac.sub.endpoint].sort());
    calls.length = 0;
    tick(VISIBLE_MS + 1);
    await push.send({ title: "t", body: "b", url: "u" });
    expect(calls).toHaveLength(2);
    push.setVisible(phone.sub.endpoint, true);
    push.setVisible(phone.sub.endpoint, false);
    calls.length = 0;
    await push.send({ title: "t", body: "b", url: "u" }, { only: push.devices()[0].id });
    expect(calls).toEqual([phone.sub.endpoint]);
  });
});

describe("Notifier with phone push", () => {
  test("a ticket needing the user pushes to devices not looking at the board; the test button reaches every device", async () => {
    const store = new Store(tempDir("ck-home-"));
    const bus = new Bus();
    let clock = 0;
    const p: Profile = { name: "Kanban", slug: "kb", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" };
    store.saveProfile(p);
    const ticket = store.createTicket("kb", { title: "Fix it", body: "b", status: "in_progress" });
    writeNotifySettings(store.root, normalizeSettings({ mac: false }));
    const bodies: { url: string; body: Buffer }[] = [];
    const push = new PushService(store.root, { now: () => clock, fetch: async (url, init) => (bodies.push({ url, body: init.body as Buffer }), new Response("", { status: 201 })) });
    const phone = browser(), mac = browser();
    push.subscribe(phone.sub, "Phone");
    push.subscribe(mac.sub, "Mac");
    push.setVisible(mac.sub.endpoint, true);
    const notifier = new Notifier(store, bus, {
      root: store.root, push, sessionSummary: () => null, isRunning: () => false, hostHuddles: () => new Map(),
      baseUrl: () => "https://mac.tail.ts.net", debounceMs: 1000, tickMs: 60_000, now: () => clock, banner: () => {},
    });
    const stop = notifier.start();
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: store.updateTicket("kb", ticket.id, { status: "review", outcome: "done" }) });
    notifier.tick();
    clock += 1000;
    notifier.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(bodies.map((b) => b.url)).toEqual([phone.sub.endpoint]);
    expect(JSON.parse(decryptPayload(bodies[0].body, phone.privateKey, phone.auth).toString())).toEqual({
      title: "Fix it", body: "Ready for review · Kanban", url: `https://mac.tail.ts.net/#/kb/${ticket.id}`, tag: `kb/${ticket.id}`,
    });
    expect(notifier.state().lastSentAt).not.toBeNull();
    bodies.length = 0;
    const r = await notifier.test("kb");
    expect(r).toEqual({ ok: true, error: null, webhook: false, devices: 2 });
    expect(bodies).toHaveLength(2);
    bodies.length = 0;
    const one = await notifier.testDevice(push.devices().find((d) => d.label === "Mac")!.id, "kb");
    expect(one).toEqual({ ok: true, error: null });
    expect(bodies.map((b) => b.url)).toEqual([mac.sub.endpoint]);
    stop();
  });

  test("a browser on this Mac replaces the macOS banner: needs-you and Plan done go to it and open the ticket", async () => {
    const store = new Store(tempDir("ck-home-"));
    const bus = new Bus();
    let clock = 0;
    const p: Profile = { name: "Kanban", slug: "kb", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" };
    store.saveProfile(p);
    const ticket = store.createTicket("kb", { title: "Fix it", body: "b", status: "in_progress" });
    const bodies: { url: string; body: Buffer }[] = [];
    const push = new PushService(store.root, { now: () => clock, fetch: async (url, init) => (bodies.push({ url, body: init.body as Buffer }), new Response("", { status: 201 })) });
    const banners: string[] = [];
    const notifier = new Notifier(store, bus, {
      root: store.root, push, sessionSummary: () => null, isRunning: () => false, hostHuddles: () => new Map(),
      baseUrl: () => "http://localhost:7777", debounceMs: 1000, tickMs: 60_000, now: () => clock, banner: (t) => banners.push(t),
    });
    const phone = browser(), mac = browser();
    push.subscribe(phone.sub, "Phone");

    // No browser on this Mac yet: the plain banner (default on) for both.
    notifier.macOnly("Plan done: Big plan", "All done", notifier.link("kb", "t_plan"));
    expect(banners).toEqual(["Plan done: Big plan"]);
    expect(bodies).toHaveLength(0);
    expect(notifier.state().macBrowser).toBe(false);

    push.subscribe(mac.sub, "Mac · Chrome", true);
    expect(notifier.state().macBrowser).toBe(true);
    banners.length = 0;
    const stop = notifier.start();
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: store.updateTicket("kb", ticket.id, { status: "review", outcome: "done" }) });
    notifier.tick();
    clock += 1000;
    notifier.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(banners).toEqual([]);
    expect(bodies.map((b) => b.url).sort()).toEqual([phone.sub.endpoint, mac.sub.endpoint].sort());

    // Plan done: only this Mac's browser (not the phone), with the planner ticket's link.
    bodies.length = 0;
    notifier.macOnly("Plan done: Big plan", "All done", notifier.link("kb", "t_plan"));
    await new Promise((r) => setTimeout(r, 10));
    expect(banners).toEqual([]);
    expect(bodies.map((b) => b.url)).toEqual([mac.sub.endpoint]);
    expect(JSON.parse(decryptPayload(bodies[0].body, mac.privateKey, mac.auth).toString()).url).toBe("http://localhost:7777/#/kb/t_plan");

    // Banner turned off: Plan done goes nowhere on the Mac either.
    bodies.length = 0;
    notifier.update({ mac: false });
    notifier.macOnly("Plan done: Big plan", "All done", notifier.link("kb", "t_plan"));
    await new Promise((r) => setTimeout(r, 10));
    expect(bodies).toHaveLength(0);
    stop();
  });

  test("a device turned on before this Mac was told apart is marked by its heartbeat from this Mac", () => {
    const push = new PushService(tempDir("ck-home-"));
    const mac = browser(), other = browser();
    push.subscribe(mac.sub, "Mac");
    expect(push.hasThisMac()).toBe(false);
    expect(push.markThisMac(other.sub.endpoint)).toBe(false);
    expect(push.markThisMac(mac.sub.endpoint)).toBe(true);
    expect(push.markThisMac(mac.sub.endpoint)).toBe(false);
    expect(push.hasThisMac()).toBe(true);
    // Re-subscribing from elsewhere (phone access address) doesn't count as this Mac.
    push.subscribe(mac.sub, "Mac");
    expect(push.hasThisMac()).toBe(false);
  });

  test("push payload: ticket title on top, what it needs and the board below", () => {
    expect(pushPayload({ board: "kb", boardName: "Kanban", ticketId: "t_1", title: "Fix", kind: "questions", label: "Answer 2 questions", url: "u" }))
      .toEqual({ title: "Fix", body: "Answer 2 questions · Kanban", url: "u", tag: "kb/t_1" });
  });
});
