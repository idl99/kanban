import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer, isAllowedRequest } from "../src/server/http";
import { ptySupported } from "../src/server/shell";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

let server: ReturnType<typeof createServer>;
let store: Store;
let board: Board;
let base: string;

beforeAll(() => {
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  board = new Board(store, bus, { claudeBin: "/bin/false" });
  server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-") });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const json = (method: string, body?: unknown) => ({
  method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
});

test("isAllowedRequest", () => {
  expect(isAllowedRequest(new Request("http://localhost:7777/api/x"), 7777)).toBe(true);
  expect(isAllowedRequest(new Request("http://127.0.0.1:7777/api/x"), 7777)).toBe(true);
  expect(isAllowedRequest(new Request("http://evil.com:7777/api/x"), 7777)).toBe(false);
  const cross = new Request("http://localhost:7777/api/x", { method: "POST", headers: { origin: "http://evil.com" } });
  expect(isAllowedRequest(cross, 7777)).toBe(false);
  const same = new Request("http://localhost:7777/api/x", { method: "POST", headers: { origin: "http://localhost:7777" } });
  expect(isAllowedRequest(same, 7777)).toBe(true);
});

test("rejects foreign Host header", async () => {
  const r = await fetch(`${base}/api/profiles`, { headers: { host: "evil.com" } });
  expect(r.status).toBe(403);
});

test("rejects cross-origin POST", async () => {
  const r = await fetch(`${base}/api/profiles`, {
    ...json("POST", { name: "x", path: "/tmp" }),
    headers: { "content-type": "application/json", origin: "http://evil.com" },
  });
  expect(r.status).toBe(403);
});

test("profile + ticket flow", async () => {
  const path = tempDir("ck-plain-");
  let r = await fetch(`${base}/api/profiles`, json("POST", { name: "My Proj", path }));
  expect(r.status).toBe(201);
  const p = (await r.json()) as any;
  expect(p.slug).toBe("my-proj");
  expect(p.maxParallel).toBe(5);

  r = await fetch(`${base}/api/profiles`, json("POST", { name: "My Proj", path }));
  expect(((await r.json()) as any).slug).toBe("my-proj-2");

  r = await fetch(`${base}/api/profiles/my-proj/tickets`, json("POST", { title: "Hello", body: "b" }));
  expect(r.status).toBe(201);
  const t = (await r.json()) as any;
  expect(t.status).toBe("backlog");

  r = await fetch(`${base}/api/profiles/my-proj/tickets/${t.id}`, json("PATCH", { status: "review" }));
  expect(((await r.json()) as any).status).toBe("review");

  r = await fetch(`${base}/api/profiles/my-proj/tickets/${t.id}/comments`, json("POST", { text: "hi" }));
  expect(r.status).toBe(201);

  r = await fetch(`${base}/api/profiles/my-proj/tickets`);
  const list = (await r.json()) as any;
  expect(list.length).toBe(1);
  expect(list[0].running).toBe(false);

  r = await fetch(`${base}/api/profiles/my-proj/tickets/${t.id}/comments`);
  expect(((await r.json()) as any)[0].text).toBe("hi");

  r = await fetch(`${base}/api/profiles/my-proj/tickets/${t.id}`, { method: "DELETE" });
  expect(r.status).toBe(204);
});

test("validation and 404s", async () => {
  let r = await fetch(`${base}/api/profiles`, json("POST", { name: "x", path: "/definitely/missing" }));
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/profiles/nope/tickets`);
  expect(r.status).toBe(404);
  r = await fetch(`${base}/api/profiles/my-proj-2/tickets/t_nope`);
  expect(r.status).toBe(404);
  r = await fetch(`${base}/api/profiles/my-proj-2/tickets`, json("POST", { title: "" }));
  expect(r.status).toBe(400);
});

test("rejects non-JSON content-type on mutations (form posts)", async () => {
  const r = await fetch(`${base}/api/profiles`, {
    method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ name: "x", path: "/tmp" }),
  });
  expect(r.status).toBe(415);
});

test("stale body edit returns 409", async () => {
  const path = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Conflict", path }));
  const t = (await (await fetch(`${base}/api/profiles/conflict/tickets`, json("POST", { title: "t", body: "a" }))).json()) as any;
  await fetch(`${base}/api/profiles/conflict/tickets/${t.id}`, json("PATCH", { body: "b" }));
  const r = await fetch(`${base}/api/profiles/conflict/tickets/${t.id}`, json("PATCH", { body: "c", expectedBody: "a" }));
  expect(r.status).toBe(409);
});

test("PATCH queued/:id edits a held message; a peer's or a missing one is refused", async () => {
  const path = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Queue Edit", path }));
  const t = (await (await fetch(`${base}/api/profiles/queue-edit/tickets`, json("POST", { title: "t", body: "" }))).json()) as any;
  const at = new Date().toISOString();
  store.updateTicket("queue-edit", t.id, { queued: [
    { id: "m1", text: "old", at, state: "unsent" },
    { id: "m2", text: "from a peer", at, state: "queued", peer: true },
  ] });
  const url = (m: string) => `${base}/api/profiles/queue-edit/tickets/${t.id}/queued/${m}`;
  let r = await fetch(url("m1"), json("PATCH", { text: "new" }));
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).queued[0]).toMatchObject({ id: "m1", text: "new", state: "unsent" });
  expect((await fetch(url("m1"), json("PATCH", { text: " " }))).status).toBe(400);
  r = await fetch(url("m2"), json("PATCH", { text: "x" }));
  expect(r.status).toBe(409);
  expect(((await r.json()) as any).error).toMatch(/on its way to Claude/);
  expect((await fetch(url("nope"), json("PATCH", { text: "x" }))).status).toBe(404);
});

test("claude discovery endpoints respond", async () => {
  const projects = (await (await fetch(`${base}/api/claude/projects`)).json()) as any;
  expect(Array.isArray(projects)).toBe(true);
  const defaults = (await (await fetch(`${base}/api/claude/defaults`)).json()) as any;
  expect("model" in defaults).toBe(true);
});

test("link session endpoint and sessions list", async () => {
  const path = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Linky", path }));
  let r = await fetch(`${base}/api/profiles/linky/sessions`);
  expect(r.status).toBe(200);
  const t = (await (await fetch(`${base}/api/profiles/linky/tickets`, json("POST", {
    title: "linked", status: "review", sessionId: "11111111-2222-3333-4444-555555555555",
  }))).json()) as any;
  expect(t.sessionId).toBe("11111111-2222-3333-4444-555555555555");
  expect(t.status).toBe("review");
  expect(t.resumeCommand).toContain(`--resume 11111111-2222-3333-4444-555555555555`);
  const conv = (await (await fetch(`${base}/api/profiles/linky/tickets/${t.id}/conversation`)).json()) as any;
  expect(conv).toMatchObject({ entries: [], total: 0 });
  r = await fetch(`${base}/api/profiles/linky/tickets/${t.id}/link-session`, json("POST", { sessionId: "bad" }));
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/profiles/linky/tickets/${t.id}/link-session`, json("POST", { sessionId: null }));
  expect(((await r.json()) as any).sessionId).toBeNull();
});

test("new tickets default to interview mode; outputs are served as sandboxed text", async () => {
  const path = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Modes", path }));
  const t = (await (await fetch(`${base}/api/profiles/modes/tickets`, json("POST", { title: "t" }))).json()) as any;
  expect(t.mode).toBe("interview");
  const a = (await (await fetch(`${base}/api/profiles/modes/tickets`, json("POST", { title: "t2", mode: "auto" }))).json()) as any;
  expect(a.mode).toBe("auto");
  const patched = (await (await fetch(`${base}/api/profiles/modes/tickets/${t.id}`, json("PATCH", { mode: "auto" }))).json()) as any;
  expect(patched.mode).toBe("auto");
  expect(await (await fetch(`${base}/api/profiles/modes/tickets/${t.id}/outputs`)).json()).toEqual([]);
  const r = await fetch(`${base}/api/profiles/modes/tickets/${t.id}/outputs/..%2Fticket.md`);
  expect(r.status).toBe(404);
  const dir = store.outputsDir("modes", t.id);
  mkdirSync(join(dir, "art"), { recursive: true });
  writeFileSync(join(dir, "art", "a.PNG"), "png");
  writeFileSync(join(dir, "b.jpeg"), "jpg");
  writeFileSync(join(dir, "x.svg"), "<svg><script>alert(1)</script></svg>");
  writeFileSync(join(dir, "page.html"), "<script>alert(1)</script>");
  for (const [name, type] of [["art/a.PNG", "image/png"], ["b.jpeg", "image/jpeg"], ["x.svg", "text/plain; charset=utf-8"], ["page.html", "text/plain; charset=utf-8"]]) {
    const res = await fetch(`${base}/api/profiles/modes/tickets/${t.id}/outputs/${name}`);
    expect(res.headers.get("content-type")).toBe(type);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  }
});

test("mockups can't be approved through the API any more", async () => {
  const path = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Mocks", path }));
  const t = (await (await fetch(`${base}/api/profiles/mocks/tickets`, json("POST", { title: "t", status: "backlog" }))).json()) as any;
  const r = await fetch(`${base}/api/profiles/mocks/tickets/${t.id}/approve-mockup`, json("POST", { name: "mockups/a.html" }));
  expect(r.status).toBe(404);
});

test("chat endpoint validates and conflicts", async () => {
  const path = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Chatty", path }));
  const t = (await (await fetch(`${base}/api/profiles/chatty/tickets`, json("POST", { title: "t", status: "backlog" }))).json()) as any;
  let r = await fetch(`${base}/api/profiles/chatty/tickets/${t.id}/chat`, json("POST", { text: " " }));
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/profiles/chatty/tickets/${t.id}/chat`, json("POST", { text: "hello" }));
  expect(r.status).toBe(202);
  expect(((await r.json()) as any).running).toBe(true);
  r = await fetch(`${base}/api/profiles/chatty/tickets/${t.id}/chat`, json("POST", { text: "again" }));
  expect([202, 409]).toContain(r.status);
});

test("inbox lists tickets across boards that need the user, Review included, oldest first", async () => {
  const a = tempDir("ck-plain-");
  const b = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Inbox A", path: a }));
  await fetch(`${base}/api/profiles`, json("POST", { name: "Inbox B", path: b }));
  const failed = (await (await fetch(`${base}/api/profiles/inbox-a/tickets`, json("POST", { title: "broken", status: "backlog" }))).json()) as any;
  store.updateTicket("inbox-a", failed.id, { status: "planning", outcome: "failed", error: "boom" });
  const review = (await (await fetch(`${base}/api/profiles/inbox-b/tickets`, json("POST", { title: "check me", status: "backlog" }))).json()) as any;
  store.updateTicket("inbox-b", review.id, { status: "review", outcome: "done" });
  // The failed run waits longer, so it comes first.
  store.updateTicket("inbox-a", failed.id, { lastRunAt: "2026-10-01T00:00:00.000Z" });
  store.updateTicket("inbox-b", review.id, { lastRunAt: "2026-10-02T00:00:00.000Z" });
  const inbox = (await (await fetch(`${base}/api/inbox`)).json()) as any[];
  const mine = inbox.filter((i) => i.profile.startsWith("inbox-"));
  expect(mine.map((i) => [i.title, i.attention.kind])).toEqual([["broken", "failed"], ["check me", "review"]]);
  // The same tickets say "Your turn" on their cards.
  for (const i of mine) {
    const t = (await (await fetch(`${base}/api/profiles/${i.profile}/tickets/${i.id}`)).json()) as any;
    expect(t.attention).toEqual(i.attention);
  }
});

test("tickets lists a light row for every ticket on every board", async () => {
  const a = tempDir("ck-plain-");
  const b = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Find A", path: a }));
  await fetch(`${base}/api/profiles`, json("POST", { name: "Find B", path: b }));
  const one = (await (await fetch(`${base}/api/profiles/find-a/tickets`, json("POST", { title: "alpha", status: "backlog" }))).json()) as any;
  const two = (await (await fetch(`${base}/api/profiles/find-b/tickets`, json("POST", { title: "beta", status: "backlog" }))).json()) as any;
  store.updateTicket("find-b", two.id, { status: "review", outcome: "done" });
  const all = (await (await fetch(`${base}/api/tickets`)).json()) as any[];
  const mine = all.filter((t) => t.profile.startsWith("find-")).sort((x, y) => x.title.localeCompare(y.title));
  expect(mine).toEqual([
    { profile: "find-a", profileName: "Find A", id: one.id, title: "alpha", status: "backlog", running: false, updatedAt: expect.any(String) },
    { profile: "find-b", profileName: "Find B", id: two.id, title: "beta", status: "review", running: false, updatedAt: expect.any(String) },
  ]);
});

test("health", async () => {
  const r = await fetch(`${base}/api/health`);
  const h = (await r.json()) as any;
  expect(typeof h.git).toBe("boolean");
});

test("attachments: upload, serve, and reject bad input", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let r = await fetch(`${base}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
  expect(r.status).toBe(201);
  const { url, path } = (await r.json()) as any;
  expect(url).toMatch(/^\/api\/attachments\/[0-9a-f]{32}\.png$/);
  expect(path).toBe(join(store.attachmentsDir, url.split("/").pop()));
  r = await fetch(`${base}${url}`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(png);

  r = await fetch(`${base}/api/attachments`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hi" });
  expect(r.status).toBe(415);
  r = await fetch(`${base}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: "not a png" });
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(10 * 1024 * 1024 + 1) });
  expect(r.status).toBe(413);
  r = await fetch(`${base}/api/attachments/..%2Fconfig.json`);
  expect(r.status).toBe(404);
  r = await fetch(`${base}/api/attachments`, {
    method: "POST", headers: { "content-type": "image/png", origin: "http://evil.com" }, body: png,
  });
  expect(r.status).toBe(403);
});

test("files API lists and reads inside the profile, rejects escapes", async () => {
  const path = tempDir("ck-files-");
  await Bun.write(join(path, "hello.ts"), "export {};\n");
  const r0 = await fetch(`${base}/api/profiles`, json("POST", { name: "Files", path }));
  const { slug } = (await r0.json()) as any;
  let r = await fetch(`${base}/api/profiles/${slug}/files?path=`);
  expect(((await r.json()) as any).entries).toEqual([{ name: "hello.ts", path: "hello.ts", type: "file" }]);
  r = await fetch(`${base}/api/profiles/${slug}/file?path=hello.ts`);
  expect(((await r.json()) as any).content).toBe("export {};\n");
  r = await fetch(`${base}/api/profiles/${slug}/file?path=${encodeURIComponent("../etc/passwd")}`);
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/profiles/${slug}/files?path=${encodeURIComponent("/etc")}`);
  expect(r.status).toBe(404);
  // Open in default app: same path checks before anything runs.
  r = await fetch(`${base}/api/profiles/${slug}/open-file`, json("POST", { path: "../etc/passwd" }));
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/profiles/${slug}/open-file`, json("POST", { path: "missing.ts" }));
  expect(r.status).toBe(404);
});

const openSocket = (url: string, origin: string) =>
  new Promise<{ ok: boolean; ws: WebSocket }>((resolve) => {
    const ws = new WebSocket(url, { headers: { origin } } as any);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve({ ok: true, ws });
    ws.onerror = () => resolve({ ok: false, ws });
    ws.onclose = () => resolve({ ok: false, ws });
  });

test("shell socket rejects a foreign Origin", async () => {
  const r0 = await fetch(`${base}/api/profiles`, json("POST", { name: "Sock", path: tempDir("ck-sock-") }));
  const { slug } = (await r0.json()) as any;
  const port = server.port;
  const { ok } = await openSocket(`ws://localhost:${port}/api/profiles/${slug}/shell`, "http://evil.com");
  expect(ok).toBe(false);
  const r = await fetch(`${base}/api/profiles/${slug}/shell`, { headers: { host: `localhost:${port}` } });
  expect(r.status).toBe(ptySupported() ? 403 : 501);
});

test.skipIf(!ptySupported())("shell socket runs commands on a PTY and replays output on reconnect", async () => {
  const path = tempDir("ck-shell-");
  const r0 = await fetch(`${base}/api/profiles`, json("POST", { name: "Shell", path }));
  const { slug } = (await r0.json()) as any;
  const port = server.port;
  const url = `ws://localhost:${port}/api/profiles/${slug}/shell?cols=90&rows=20`;
  const origin = `http://localhost:${port}`;
  const read = (ws: WebSocket, want: string) =>
    new Promise<string>((resolve) => {
      let out = "";
      const dec = new TextDecoder();
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") out += dec.decode(e.data as ArrayBuffer);
        if (out.includes(want)) resolve(out);
      };
    });
  const a = await openSocket(url, origin);
  expect(a.ok).toBe(true);
  const got = read(a.ws, "MARK-90");
  a.ws.send(JSON.stringify({ type: "input", data: "tty; pwd; echo MARK-$(tput cols)\n" }));
  const out = await got;
  expect(out).toContain("/dev/ttys");
  expect(out).toContain(path);
  a.ws.close();

  const b = await openSocket(url, origin);
  expect(await read(b.ws, "MARK-90")).toContain("MARK-90");
  b.ws.send(JSON.stringify({ type: "input", data: "exit\n" }));
  b.ws.close();
}, 15_000);

test("cron preview", async () => {
  let r = await fetch(`${base}/api/cron/preview?expr=${encodeURIComponent("0 9 * * 1-5")}`);
  const ok = (await r.json()) as any;
  expect(ok).toMatchObject({ valid: true, error: null, summary: "Weekdays at 09:00" });
  expect(ok.next).toHaveLength(3);
  r = await fetch(`${base}/api/cron/preview?expr=${encodeURIComponent("* *")}`);
  expect(((await r.json()) as any)).toMatchObject({ valid: false, next: [] });
});

test("schedule CRUD, run now and history", async () => {
  let r = await fetch(`${base}/api/profiles`, json("POST", { name: "Sched", path: tempDir("ck-sched-") }));
  const slug = ((await r.json()) as any).slug;
  const url = `${base}/api/profiles/${slug}/schedules`;

  r = await fetch(url, json("POST", { name: "Nightly", title: "Audit {date}", body: "go", cron: "nope" }));
  expect(r.status).toBe(400);
  expect(((await r.json()) as any).error).toContain("invalid cron expression");

  r = await fetch(url, json("POST", { name: "Nightly", title: "Audit {date}", body: "go", cron: "0 3 * * *" }));
  expect(r.status).toBe(201);
  const s = (await r.json()) as any;
  expect(s).toMatchObject({ name: "Nightly", enabled: true, summary: "Every day at 03:00", active: false });
  expect(s.nextRunAt).toBeTruthy();

  r = await fetch(`${url}/${s.id}`, json("PATCH", { enabled: false }));
  expect(((await r.json()) as any)).toMatchObject({ enabled: false, nextRunAt: null });

  r = await fetch(`${url}/${s.id}/run`, json("POST"));
  const run = (await r.json()) as any;
  expect(run.entry.kind).toBe("fired");
  const tickets = (await (await fetch(`${base}/api/profiles/${slug}/tickets`)).json()) as any[];
  expect(tickets.find((t) => t.id === run.entry.ticketId)?.scheduleId).toBe(s.id);

  r = await fetch(`${url}/${s.id}/history`);
  const h = (await r.json()) as any[];
  expect(h[0]).toMatchObject({ kind: "fired", trigger: "manual" });
  expect(h[0].ticket.id).toBe(run.entry.ticketId);

  r = await fetch(url);
  expect(((await r.json()) as any[]).map((x) => x.id)).toEqual([s.id]);

  r = await fetch(`${url}/${s.id}`, { method: "DELETE" });
  expect(r.status).toBe(204);
  r = await fetch(`${url}/${s.id}/history`);
  expect(r.status).toBe(404);
});

test("schedule edits from a board run are credited to its ticket", async () => {
  let r = await fetch(`${base}/api/profiles`, json("POST", { name: "Credit", path: tempDir("ck-credit-") }));
  const slug = ((await r.json()) as any).slug;
  const url = `${base}/api/profiles/${slug}/schedules`;
  const run = { "content-type": "application/json", "x-ckanban-run": `${slug}/t_20261001_wxyz` };
  r = await fetch(url, { method: "POST", headers: run, body: JSON.stringify({ name: "N", title: "T", body: "b", cron: "0 3 * * *" }) });
  const s = (await r.json()) as any;
  await fetch(`${url}/${s.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-ckanban-run": "garbage" }, body: JSON.stringify({ body: "c" }) });
  const h = (await (await fetch(`${url}/${s.id}/history`)).json()) as any[];
  expect(h.map((e) => [e.action, e.by])).toEqual([["updated", "user"], ["created", { ticketId: "t_20261001_wxyz" }]]);
});

test("tickets created from a planner keep parentId; unknown parent is rejected", async () => {
  const path = tempDir("ck-parent-");
  const p = (await (await fetch(`${base}/api/profiles`, json("POST", { name: "Parent Proj", path }))).json()) as any;
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const planner = (await (await fetch(tickets, json("POST", { title: "Plan" }))).json()) as any;
  let r = await fetch(tickets, json("POST", { title: "Child", body: "b", status: "backlog", parentId: planner.id }));
  expect(r.status).toBe(201);
  const child = (await r.json()) as any;
  expect(child.parentId).toBe(planner.id);
  expect(child.status).toBe("backlog");
  r = await fetch(tickets, json("POST", { title: "Orphan", parentId: "t_nope" }));
  expect(r.status).toBe(400);
});

test("inside a board run only a running plan's planner may change tickets, and only its own children", async () => {
  const path = tempDir("ck-scope-");
  const p = (await (await fetch(`${base}/api/profiles`, json("POST", { name: "Scope Proj", path }))).json()) as any;
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const post = async (u: string, b: unknown, run?: string, method = "POST") =>
    fetch(u, { method, headers: { "content-type": "application/json", ...(run ? { "x-ckanban-run": run } : {}) }, body: JSON.stringify(b) });
  const planner = (await (await post(tickets, { title: "Plan" })).json()) as any;
  const child = (await (await post(tickets, { title: "Child", parentId: planner.id, planKey: "c" })).json()) as any;
  const other = (await (await post(tickets, { title: "Other" })).json()) as any;
  const run = `${p.slug}/${planner.id}`;

  // No plan running yet: the planner's run is an ordinary board run.
  let r = await post(`${tickets}/${child.id}`, { title: "x" }, run, "PATCH");
  expect(r.status).toBe(403);
  expect(((await r.json()) as any).error).toContain("disabled inside a board run");

  // Start the plan paused right away so nothing runs in this test (no claude here).
  r = await post(`${tickets}/${planner.id}/plan`, { action: "start", maxConcurrent: 1 });
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).plan.state).toBe("running");
  await post(`${tickets}/${planner.id}/plan`, { action: "pause" });
  // A paused plan doesn't grant rights.
  r = await post(`${tickets}/${child.id}`, { body: "clearer" }, run, "PATCH");
  expect(r.status).toBe(403);
  await post(`${tickets}/${planner.id}/plan`, { action: "resume" });
  await post(`${tickets}/${planner.id}/plan`, { action: "concurrency", maxConcurrent: 3 });

  r = await post(`${tickets}/${child.id}`, { body: "clearer", dependsOn: [] }, run, "PATCH");
  expect(r.status).toBe(200);
  r = await post(`${tickets}/${other.id}`, { body: "nope" }, run, "PATCH");
  expect(r.status).toBe(403);
  expect(((await r.json()) as any).error).toContain("is not a child ticket of plan");
  r = await post(`${tickets}/${child.id}/comments`, { text: "try X" }, run);
  expect(((await r.json()) as any).text).toBe("Planner: try X");
  r = await post(tickets, { title: "Bad", dependsOn: ["ghost"] }, run);
  expect(r.status).toBe(400);
  r = await post(tickets, { title: "Split", status: "ready", dependsOn: ["c"] }, run);
  expect(r.status).toBe(201);
  const split = (await r.json()) as any;
  expect([split.parentId, split.status, split.mode, split.dependsOn]).toEqual([planner.id, "backlog", "auto", ["c"]]);
  // At most twice the plan's original children.
  r = await post(tickets, { title: "One too many" }, run);
  expect(r.status).toBe(409);
  r = await fetch(`${tickets}/${child.id}`, { method: "DELETE", headers: { "x-ckanban-run": run } });
  expect(r.status).toBe(403);
  r = await post(`${tickets}/${planner.id}/plan`, { action: "pause" }, run);
  expect(r.status).toBe(403);
  // A different ticket's run gets nothing.
  r = await post(`${tickets}/${child.id}`, { title: "x" }, `${p.slug}/${other.id}`, "PATCH");
  expect(r.status).toBe(403);
  await post(`${tickets}/${planner.id}/plan`, { action: "pause" });
});

test("POST .../branch: refused inside a board run, 400 without a conversation", async () => {
  const path = tempDir("ck-plain-");
  const p = (await (await fetch(`${base}/api/profiles`, json("POST", { name: "Branchy", path }))).json()) as any;
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const t = (await (await fetch(tickets, json("POST", { title: "Hello", body: "b" }))).json()) as any;
  let r = await fetch(`${tickets}/${t.id}/branch`, { method: "POST", headers: { "content-type": "application/json", "x-ckanban-run": `${p.slug}/${t.id}` }, body: "{}" });
  expect(r.status).toBe(403);
  expect(((await r.json()) as any).error).toContain("propose_branch");
  r = await fetch(`${tickets}/${t.id}/branch`, json("POST", {}));
  expect(r.status).toBe(400);
  expect(((await r.json()) as any).error).toContain("no Claude conversation");
});

test("the user's chat gives a ticket planner rights over its own children: adopt, change, start the plan", async () => {
  const path = tempDir("ck-manage-");
  const p = (await (await fetch(`${base}/api/profiles`, json("POST", { name: "Manage Proj", path }))).json()) as any;
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const post = async (u: string, b: unknown, run?: string, method = "POST") =>
    fetch(u, { method, headers: { "content-type": "application/json", ...(run ? { "x-ckanban-run": run } : {}) }, body: JSON.stringify(b) });
  const mgr = (await (await post(tickets, { title: "Manager" })).json()) as any;
  const a = (await (await post(tickets, { title: "A" })).json()) as any;
  const b = (await (await post(tickets, { title: "B", needs: ["Emulator"] })).json()) as any;
  expect(b.needs).toEqual(["emulator"]);
  const elsewhere = (await (await post(tickets, { title: "Elsewhere" })).json()) as any;
  const kidOfElsewhere = (await (await post(tickets, { title: "Kid", parentId: elsewhere.id })).json()) as any;
  const run = `${p.slug}/${mgr.id}`;

  // No user chat behind the run: refused, like any board run.
  let r = await post(`${tickets}/${mgr.id}/adopt`, { ids: [a.id] }, run);
  expect(r.status).toBe(403);
  r = await post(`${tickets}/${mgr.id}/plan`, { action: "start" }, run);
  expect(r.status).toBe(403);

  // The manager's run answers the user's message in its chat.
  const real = board.userChatRun.bind(board);
  board.userChatRun = (slug, id) => id === mgr.id || real(slug, id);
  try {
    r = await post(`${tickets}/${mgr.id}/adopt`, { ids: [a.id, b.id, kidOfElsewhere.id] }, run);
    expect(r.status).toBe(200);
    const adopt = (await r.json()) as any;
    expect(adopt.adopted.map((t: any) => t.title)).toEqual(["A", "B"]);
    expect(adopt.skipped).toEqual([{ id: kidOfElsewhere.id, reason: `belongs to plan ${elsewhere.id}` }]);
    // Another ticket's run can't adopt for it.
    r = await post(`${tickets}/${mgr.id}/adopt`, { ids: [elsewhere.id] }, `${p.slug}/${a.id}`);
    expect(r.status).toBe(403);
    r = await post(`${tickets}/${a.id}`, { dependsOn: [b.id], needs: ["emulator"] }, run, "PATCH");
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).needs).toEqual(["emulator"]);
    r = await post(`${tickets}/${elsewhere.id}`, { title: "x" }, run, "PATCH");
    expect(r.status).toBe(403);
    // Created children wait in Backlog in the mode asked for; the plan isn't running.
    r = await post(tickets, { title: "New child", mode: "interview", status: "ready" }, run);
    const kid = (await r.json()) as any;
    expect([kid.parentId, kid.status, kid.mode]).toEqual([mgr.id, "backlog", "interview"]);
    r = await post(`${tickets}/${kid.id}`, { parentId: null }, run, "PATCH");
    expect(((await r.json()) as any).parentId).toBeNull();
    r = await post(`${tickets}/${kid.id}`, { parentId: mgr.id }, undefined, "PATCH");
    expect(r.status).toBe(400);
    // Only start / resume, only its own plan, and no concurrency change.
    r = await post(`${tickets}/${mgr.id}/plan`, { action: "concurrency", maxConcurrent: 5 }, run);
    expect(r.status).toBe(403);
    r = await post(`${tickets}/${elsewhere.id}/plan`, { action: "start" }, run);
    expect(r.status).toBe(403);
    r = await post(`${tickets}/${mgr.id}/plan`, { action: "start", maxConcurrent: 9 }, run);
    expect(r.status).toBe(200);
    const plan = ((await r.json()) as any).plan;
    expect([plan.state, plan.maxConcurrent]).toEqual(["running", 2]);
    expect(store.listComments(p.slug, mgr.id).some((c) => c.text.startsWith("Plan started by the planner"))).toBe(true);
    await post(`${tickets}/${mgr.id}/plan`, { action: "pause" });
    // Paused: the user's chat still gives rights (the plan isn't done).
    r = await post(`${tickets}/${a.id}`, { body: "clearer" }, run, "PATCH");
    expect(r.status).toBe(200);
    r = await post(`${tickets}/${mgr.id}/plan`, { action: "resume" }, run);
    expect(((await r.json()) as any).plan.state).toBe("running");
    await post(`${tickets}/${mgr.id}/plan`, { action: "done" });
    // Done: no rights, no adopting.
    r = await post(`${tickets}/${a.id}`, { body: "late" }, run, "PATCH");
    expect(r.status).toBe(403);
    r = await post(`${tickets}/${mgr.id}/adopt`, { ids: [elsewhere.id] }, run);
    expect(r.status).toBe(403);
  } finally {
    board.userChatRun = real;
  }
});

test("a Planning chat answering the user's message may change any other ticket on its board, logged as a user request", async () => {
  const mk = async (name: string) => (await (await fetch(`${base}/api/profiles`, json("POST", { name, path: tempDir("ck-req-") }))).json()) as any;
  const p = await mk("Request Proj");
  const q = await mk("Other Proj");
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const send = async (u: string, b: unknown, headers: Record<string, string> = {}, method = "POST") =>
    fetch(u, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
  const chatT = (await (await send(tickets, { title: "Planning chat", status: "backlog" })).json()) as any;
  const x = (await (await send(tickets, { title: "X" })).json()) as any;
  const y = (await (await send(tickets, { title: "Y" })).json()) as any;
  const run = { "x-ckanban-run": `${p.slug}/${chatT.id}` };
  const errorOf = async (r: Response) => ((await r.json()) as any).error as string;

  // Without the user's message behind the run (plan wake-up, non-refine run): refused like any board run.
  let r = await send(`${tickets}/${x.id}`, { status: "done" }, run, "PATCH");
  expect(r.status).toBe(403);

  const real = board.userRequestRights.bind(board);
  board.userRequestRights = (slug, id) => (slug === p.slug && id === chatT.id ? store.getTicket(slug, id)! : real(slug, id));
  try {
    r = await send(`${tickets}/${x.id}`, { status: "done" }, run, "PATCH");
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).status).toBe("done");
    expect(store.listComments(p.slug, x.id).at(-1)!.text).toBe(`Moved it to done by the Planning chat of ${chatT.id} (user request).`);
    r = await send(`${tickets}/${y.id}`, { title: "Y2", body: "clearer" }, run, "PATCH");
    expect(r.status).toBe(200);
    expect(store.getTicket(p.slug, y.id)!.title).toBe("Y2");
    expect(store.listComments(p.slug, y.id).at(-1)!.text).toBe(`Changed title, changed body by the Planning chat of ${chatT.id} (user request).`);
    r = await send(`${tickets}/${y.id}/comments`, { text: "see X" }, run);
    expect(((await r.json()) as any).text).toBe(`From the Planning chat of ${chatT.id} (user request): see X`);
    r = await send(tickets, { title: "Follow-up" }, run);
    expect(r.status).toBe(201);
    const made = (await r.json()) as any;
    expect([made.parentId ?? null, made.status]).toEqual([null, "backlog"]);
    expect(store.listComments(p.slug, made.id).at(-1)!.text).toBe(`Created by the Planning chat of ${chatT.id} (user request).`);
    r = await send(`${tickets}/${y.id}/stop`, {}, run);
    expect(r.status).toBe(200);

    // Its own ticket: refused, the user moves it.
    r = await send(`${tickets}/${chatT.id}`, { status: "ready" }, run, "PATCH");
    expect(r.status).toBe(403);
    expect(await errorOf(r)).toContain("own ticket");
    for (const action of ["stop", "chat", "comments"]) {
      r = await send(`${tickets}/${chatT.id}/${action}`, { text: "go" }, run);
      expect(r.status).toBe(403);
    }
    expect(store.getTicket(p.slug, chatT.id)!.status).toBe("backlog");
    // Deleting stays the user's (propose_delete card), even here.
    r = await fetch(`${tickets}/${y.id}`, { method: "DELETE", headers: run });
    expect(r.status).toBe(403);
    // A huddle agent of the same ticket, another ticket's run, and another board get nothing.
    r = await send(`${tickets}/${x.id}`, { status: "review" }, { ...run, "x-ckanban-huddle-agent": "reviewer" }, "PATCH");
    expect(r.status).toBe(403);
    r = await send(`${tickets}/${x.id}`, { status: "review" }, { "x-ckanban-run": `${p.slug}/${y.id}` }, "PATCH");
    expect(r.status).toBe(403);
    const z = (await (await send(`${base}/api/profiles/${q.slug}/tickets`, { title: "Z" })).json()) as any;
    r = await send(`${base}/api/profiles/${q.slug}/tickets/${z.id}`, { status: "done" }, run, "PATCH");
    expect(r.status).toBe(403);
    expect(store.getTicket(p.slug, x.id)!.status).toBe("done");
    // The user's own delete (the card's Delete button) works.
    r = await fetch(`${tickets}/${y.id}`, { method: "DELETE" });
    expect(r.status).toBe(204);
    expect(store.getTicket(p.slug, y.id)).toBeNull();
  } finally {
    board.userRequestRights = real;
  }
});
