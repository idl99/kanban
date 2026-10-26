import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { run } from "../src/server/git";
import { createServer, isAllowedRequest } from "../src/server/http";
import { ptySupported } from "../src/server/shell";
import { Store } from "../src/server/store";
import { makeRepo, tempDir } from "./helpers";

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

test("PATCH ticket and board set model and effort; bad values are refused, null clears", async () => {
  const path = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Effort", path, effort: "high" }));
  expect(((await (await fetch(`${base}/api/profiles/effort`)).json()) as any).effort).toBe("high");
  expect((await fetch(`${base}/api/profiles/effort`, json("PATCH", { effort: "loud" }))).status).toBe(400);
  expect(((await (await fetch(`${base}/api/profiles/effort`, json("PATCH", { effort: "" }))).json()) as any).effort).toBeNull();
  const t = (await (await fetch(`${base}/api/profiles/effort/tickets`, json("POST", { title: "t", body: "" }))).json()) as any;
  const url = `${base}/api/profiles/effort/tickets/${t.id}`;
  let r = await fetch(url, json("PATCH", { effort: "xhigh", model: "opus" }));
  expect(await r.json()).toMatchObject({ effort: "xhigh", model: "opus" });
  expect((await fetch(url, json("PATCH", { effort: "loud" }))).status).toBe(400);
  expect((await fetch(url, json("PATCH", { model: "gpt-4" }))).status).toBe(400);
  r = await fetch(url, json("PATCH", { effort: null, model: null }));
  const cleared = (await r.json()) as any;
  expect(cleared.effort ?? null).toBeNull();
  expect(cleared.model ?? null).toBeNull();
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

test("chat file paths: find-files says which exist, file reads them, nothing outside the folders", async () => {
  const path = tempDir("ck-plain-");
  mkdirSync(join(path, "docs"));
  writeFileSync(join(path, "docs", "review.md"), "# Review\n- a\n");
  writeFileSync(join(path, "page.html"), "<script>alert(1)</script>");
  writeFileSync(join(path, "pic.png"), "png");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Paths", path }));
  const t = (await (await fetch(`${base}/api/profiles/paths/tickets`, json("POST", { title: "t" }))).json()) as any;
  writeFileSync(join(store.outputsDir("paths", t.id), "report.md"), "r");
  const tk = `${base}/api/profiles/paths/tickets/${t.id}`;
  const outside = join(tempDir(), "secret.md");
  writeFileSync(outside, "s");
  const r = await fetch(`${tk}/find-files`, json("POST", { paths: ["docs/review.md", "docs/missing.md", "../../etc/passwd", outside, "report.md", "docs"] }));
  expect(((await r.json()) as any).found).toEqual({
    "docs/review.md": { root: "project", rel: "docs/review.md" },
    "report.md": { root: "outputs", rel: "report.md" },
  });
  const f = (await (await fetch(`${tk}/file?path=${encodeURIComponent("docs/review.md")}`)).json()) as any;
  expect(f).toMatchObject({ path: "docs/review.md", content: "# Review\n- a\n", binary: false, tooLarge: false, root: "project" });
  for (const bad of ["../../etc/passwd", outside, "/etc/hosts", "docs/missing.md"]) {
    expect((await fetch(`${tk}/file?path=${encodeURIComponent(bad)}`)).status).toBe(404);
    expect((await fetch(`${tk}/file?raw=1&path=${encodeURIComponent(bad)}`)).status).toBe(404);
  }
  for (const [name, type] of [["pic.png", "image/png"], ["page.html", "text/plain; charset=utf-8"]]) {
    const res = await fetch(`${tk}/file?raw=1&path=${name}`);
    expect(res.headers.get("content-type")).toBe(type);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  }
  expect((await fetch(`${tk}/file?raw=1&download=1&path=pic.png`)).headers.get("content-disposition")).toContain("pic.png");
  // A ticket working in the project folder has no copy of its own; one with a copy is read from there first.
  store.updateTicket("paths", t.id, { workdir: path });
  expect(((await (await fetch(`${tk}/file?path=docs/review.md`)).json()) as any).root).toBe("project");
  const copyDir = tempDir();
  mkdirSync(join(copyDir, "docs"));
  writeFileSync(join(copyDir, "docs", "review.md"), "# Newer");
  store.updateTicket("paths", t.id, { worktree: copyDir });
  expect((await (await fetch(`${tk}/file?path=docs/review.md`)).json()) as any).toMatchObject({ root: "ticket", content: "# Newer" });
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

test("snoozing an Inbox entry hides it from counts until it is unsnoozed or moved", async () => {
  await fetch(`${base}/api/profiles`, json("POST", { name: "Snooze", path: tempDir("ck-snooze-") }));
  const t = (await (await fetch(`${base}/api/profiles/snooze/tickets`, json("POST", { title: "later", status: "backlog" }))).json()) as any;
  const url = `${base}/api/profiles/snooze/tickets/${t.id}`;
  // Nothing waits on the user yet: nothing to snooze.
  expect((await fetch(`${url}/snooze`, json("POST", {}))).status).toBe(409);
  store.updateTicket("snooze", t.id, { status: "review", outcome: "done" });
  const mine = async () => ((await (await fetch(`${base}/api/inbox`)).json()) as any[]).filter((i) => i.profile === "snooze");
  const snoozed = (await (await fetch(`${url}/snooze`, json("POST", {}))).json()) as any;
  expect(snoozed.attention).toBeNull();
  expect(snoozed.snoozed).toMatchObject({ attention: { kind: "review" } });
  expect(Date.parse(snoozed.snoozed.until) - Date.now()).toBeGreaterThan(23 * 3600_000);
  expect(await mine()).toEqual([expect.objectContaining({ id: t.id, snoozedUntil: snoozed.snoozed.until, attention: expect.objectContaining({ kind: "review" }) })]);
  const back = (await (await fetch(`${url}/snooze`, { method: "DELETE" })).json()) as any;
  expect(back.attention).toMatchObject({ kind: "review" });
  expect((await mine())[0].snoozedUntil).toBeUndefined();
  // Moving the ticket clears its snooze.
  await fetch(`${url}/snooze`, json("POST", {}));
  await fetch(url, json("PATCH", { status: "done" }));
  expect(store.getTicket("snooze", t.id)!.snooze).toBeNull();
});

test("tickets lists a light row for every ticket on every board", async () => {
  const a = tempDir("ck-plain-");
  const b = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Find A", path: a }));
  await fetch(`${base}/api/profiles`, json("POST", { name: "Find B", path: b }));
  const one = (await (await fetch(`${base}/api/profiles/find-a/tickets`, json("POST", { title: "alpha", status: "backlog" }))).json()) as any;
  const two = (await (await fetch(`${base}/api/profiles/find-b/tickets`, json("POST", { title: "beta", status: "backlog" }))).json()) as any;
  store.updateTicket("find-b", two.id, { status: "review", outcome: "done", prUrl: "https://github.com/a/b/pull/7" });
  store.addComment("find-b", two.id, "ai", "Added the retry loop.");
  const all = (await (await fetch(`${base}/api/tickets`)).json()) as any[];
  const mine = all.filter((t) => t.profile.startsWith("find-")).sort((x, y) => x.title.localeCompare(y.title));
  expect(mine).toEqual([
    { profile: "find-a", profileName: "Find A", id: one.id, title: "alpha", status: "backlog", running: false, updatedAt: expect.any(String),
      body: "", summary: "", prUrl: null },
    { profile: "find-b", profileName: "Find B", id: two.id, title: "beta", status: "review", running: false, updatedAt: expect.any(String),
      body: "", summary: "Added the retry loop.", prUrl: "https://github.com/a/b/pull/7" },
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
  r = await fetch(`${base}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(25 * 1024 * 1024 + 1) });
  expect(r.status).toBe(413);
  r = await fetch(`${base}/api/attachments/..%2Fconfig.json`);
  expect(r.status).toBe(404);
  r = await fetch(`${base}/api/attachments`, {
    method: "POST", headers: { "content-type": "image/png", origin: "http://evil.com" }, body: png,
  });
  expect(r.status).toBe(403);
});

test("attachments: files upload with their name, serve safely and report their size", async () => {
  const up = (name: string, body: string | Uint8Array, type = "application/octet-stream") =>
    fetch(`${base}/api/attachments`, { method: "POST", headers: { "content-type": type, "x-file-name": encodeURIComponent(name) }, body });
  let r = await up("Q3 contract.pdf", "%PDF-1.7\nhello");
  expect(r.status).toBe(201);
  const pdf = ((await r.json()) as any).url as string;
  expect(pdf).toMatch(/^\/api\/attachments\/[0-9a-f]{32}\.pdf$/);
  r = await fetch(`${base}${pdf}`);
  expect(r.headers.get("content-type")).toBe("application/pdf");
  expect(r.headers.get("content-disposition") ?? "").not.toContain("attachment"); // opens in the browser
  expect(r.headers.get("content-security-policy")).toBe("sandbox");
  r = await fetch(`${base}${pdf}?download=1&name=${encodeURIComponent("Q3 contract.pdf")}`);
  expect(r.headers.get("content-disposition")).toStartWith('attachment; filename="Q3 contract.pdf"');
  r = await fetch(`${base}${pdf}/info`);
  expect(await r.json()).toEqual({ size: 14 });

  r = await up("notes.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]));
  const docx = ((await r.json()) as any).url as string;
  r = await fetch(`${base}${docx}?name=notes.docx`);
  expect(r.headers.get("content-disposition")).toStartWith('attachment; filename="notes.docx"');

  r = await up("page.html", "<script>alert(1)</script>");
  const html = ((await r.json()) as any).url as string;
  r = await fetch(`${base}${html}`);
  expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");

  expect((await up("setup.exe", "MZ")).status).toBe(415);
  expect((await up("fake.pdf", "not a pdf")).status).toBe(400);
  expect((await up("notes.txt", "hi", "text/plain")).status).toBe(415); // a plain form post can't upload
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
    // Done: the user's chat may still tidy up the plan's own children, but not adopt more or restart it.
    r = await post(`${tickets}/${a.id}`, { body: "late" }, run, "PATCH");
    expect(r.status).toBe(200);
    r = await post(`${tickets}/${elsewhere.id}`, { body: "late" }, run, "PATCH");
    expect(r.status).toBe(403);
    r = await post(`${tickets}/${mgr.id}/adopt`, { ids: [elsewhere.id] }, run);
    expect(r.status).toBe(403);
    r = await post(`${tickets}/${mgr.id}/plan`, { action: "resume" }, run);
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

test("a ticket's active run may change other tickets on its board: labelled notes, logged changes, limits on starting and closing", async () => {
  const p = (await (await fetch(`${base}/api/profiles`, json("POST", { name: "Runner Proj", path: tempDir("ck-runner-") }))).json()) as any;
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const send = async (u: string, b: unknown, headers: Record<string, string> = {}, method = "POST") =>
    fetch(u, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
  const mk = async (title: string) => (await (await send(tickets, { title })).json()) as any;
  const a = await mk("Post #006 again");
  const old = await mk("Old #006");
  const busy = await mk("Busy");
  const dirty = await mk("Dirty");
  const next = await mk("Next");
  const run = { "x-ckanban-run": `${p.slug}/${a.id}` };
  const errorOf = async (r: Response) => ((await r.json()) as any).error as string;
  const lastNote = (id: string) => store.listComments(p.slug, id).at(-1)!;
  const by = `by the run of ${a.id} ("Post #006 again")`;

  // Not working right now: refused like before.
  let r = await send(`${tickets}/${old.id}/comments`, { text: "replaced" }, run);
  expect(r.status).toBe(403);
  expect(await errorOf(r)).toContain("disabled inside a board run");

  const realRights = board.runnerRights.bind(board);
  const realRunning = board.isRunning.bind(board);
  board.runnerRights = (slug, id) => (slug === p.slug && id === a.id ? store.getTicket(slug, id)! : realRights(slug, id));
  board.isRunning = (slug, id) => id === busy.id || realRunning(slug, id);
  try {
    // A note: Claude's, labelled with the ticket that wrote it.
    r = await send(`${tickets}/${old.id}/comments`, { text: "replaced by job 4f2k; nothing to post here" }, run);
    expect(r.status).toBe(201);
    const note = (await r.json()) as any;
    expect([note.author, note.from, note.text]).toEqual(["ai", a.id, `Note from ticket ${a.id} ("Post #006 again"): replaced by job 4f2k; nothing to post here`]);
    // Edits and moves are logged on the changed ticket.
    r = await send(`${tickets}/${old.id}`, { title: "Old #006 (replaced)" }, run, "PATCH");
    expect(r.status).toBe(200);
    expect(lastNote(old.id).text).toBe(`Changed title ${by}.`);
    r = await send(`${tickets}/${old.id}`, { status: "done" }, run, "PATCH");
    expect(r.status).toBe(200);
    expect(store.getTicket(p.slug, old.id)!.status).toBe("done");
    expect(lastNote(old.id).text).toBe(`Moved it to done ${by}.`);
    r = await send(tickets, { title: "Spin-off" }, run);
    expect(r.status).toBe(201);
    const made = (await r.json()) as any;
    expect([made.parentId ?? null, made.status]).toEqual([null, "backlog"]);
    expect(lastNote(made.id).text).toBe(`Created ${by}.`);

    // Closing work that is under way or not saved yet: refused, the user can.
    r = await send(`${tickets}/${busy.id}`, { status: "done" }, run, "PATCH");
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toContain("working right now");
    const wt = await makeRepo();
    writeFileSync(join(wt, "draft.md"), "half done\n");
    store.updateTicket(p.slug, dirty.id, { worktree: wt });
    r = await send(`${tickets}/${dirty.id}`, { status: "done" }, run, "PATCH");
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toContain("aren't saved in its version history");
    expect(store.getTicket(p.slug, dirty.id)!.status).toBe("backlog");
    r = await send(`${tickets}/${dirty.id}`, { status: "done" }, {}, "PATCH");
    expect(r.status).toBe(200);

    // Starting runs: past the chain limit refused; within it, the started ticket remembers who started it.
    board.markStartedBy(p.slug, a.id, { ticketId: "t_20261001_root", depth: 2 });
    r = await send(`${tickets}/${next.id}`, { status: "ready" }, run, "PATCH");
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toContain("chain of runs started by runs stops at 2");
    r = await send(`${tickets}/${next.id}/chat`, { text: "go" }, run);
    expect(r.status).toBe(409);
    expect(store.getTicket(p.slug, next.id)!.status).toBe("backlog");
    board.markStartedBy(p.slug, a.id, null);
    r = await send(`${tickets}/${next.id}/chat`, { text: "please pick this up" }, run);
    expect(r.status).toBe(202);
    expect(store.getTicket(p.slug, next.id)!.startedBy).toEqual({ ticketId: a.id, depth: 1 });
    // Labelled with the sending ticket, so the chat shows it as that ticket's, not the user's.
    expect(store.getTicket(p.slug, next.id)!.queued?.at(-1)).toMatchObject({
      text: `Message from ticket ${a.id} ("Post #006 again"): please pick this up`, from: { ticketId: a.id, title: "Post #006 again" },
    });
    expect(store.getTicket(p.slug, next.id)!.status).not.toBe("planning");
    expect(store.listComments(p.slug, next.id).some((c) => c.text === `Message sent ${by}.`)).toBe(true);
    r = await send(`${tickets}/${busy.id}/stop`, {}, run);
    expect(r.status).toBe(200);

    // Still refused: deleting, its own ticket, and a huddle helper of the same ticket.
    r = await fetch(`${tickets}/${next.id}`, { method: "DELETE", headers: run });
    expect(r.status).toBe(403);
    r = await send(`${tickets}/${a.id}`, { title: "x" }, run, "PATCH");
    expect(r.status).toBe(403);
    expect(await errorOf(r)).toContain("own ticket");
    r = await send(`${tickets}/${next.id}/comments`, { text: "x" }, { ...run, "x-ckanban-huddle-agent": "reviewer" });
    expect(r.status).toBe(403);
    // Spending cap and model stay the user's; tickets on another board stay out of reach.
    r = await send(`${tickets}/${next.id}`, { runCapUsd: 0 }, run, "PATCH");
    expect(r.status).toBe(403);
    const q = (await (await fetch(`${base}/api/profiles`, json("POST", { name: "Elsewhere Proj", path: tempDir("ck-else-") }))).json()) as any;
    const far = (await (await send(`${base}/api/profiles/${q.slug}/tickets`, { title: "Far" })).json()) as any;
    r = await send(`${base}/api/profiles/${q.slug}/tickets/${far.id}/comments`, { text: "hi" }, run);
    expect(r.status).toBe(403);
  } finally {
    board.runnerRights = realRights;
    board.isRunning = realRunning;
  }
});

test("a chat answering the user's message changes tickets on another board; other runs stay on their own board", async () => {
  const home = (await (await fetch(`${base}/api/profiles`, json("POST", { name: "Berry Best", path: tempDir("ck-home-b-") }))).json()) as any;
  const far = (await (await fetch(`${base}/api/profiles`, json("POST", { name: "Fatt Interior", path: tempDir("ck-far-") }))).json()) as any;
  const farTickets = `${base}/api/profiles/${far.slug}/tickets`;
  const send = async (u: string, b: unknown, headers: Record<string, string> = {}, method = "POST") =>
    fetch(u, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
  const mk = async (u: string, title: string) => (await (await send(u, { title })).json()) as any;
  const chat = await mk(`${base}/api/profiles/${home.slug}/tickets`, "Kitchen quote");
  const work = await mk(`${base}/api/profiles/${home.slug}/tickets`, "Work run");
  const existing = await mk(farTickets, "Measure the hallway");
  const errorOf = async (r: Response) => ((await r.json()) as any).error as string;
  const lastNote = (id: string) => store.listComments(far.slug, id).at(-1)!;
  const asChat = { "x-ckanban-run": `${home.slug}/${chat.id}` };
  const asWork = { "x-ckanban-run": `${home.slug}/${work.id}` };
  const by = `by the chat of ${chat.id} on Berry Best (user request)`;

  const realAsked = board.userAskedRun.bind(board);
  const realRunner = board.runnerRights.bind(board);
  board.userAskedRun = (slug, id) => (slug === home.slug && id === chat.id) || realAsked(slug, id);
  // The work run may change its own board, but that never reaches another board.
  board.runnerRights = (slug, id) => (slug === home.slug && id === work.id ? store.getTicket(slug, id)! : realRunner(slug, id));
  try {
    // Create: lands in Backlog with the credit line.
    let r = await send(farTickets, { title: "Cross-board test", body: "from the kitchen chat" }, asChat);
    expect(r.status).toBe(201);
    const made = (await r.json()) as any;
    expect([made.status, made.mode]).toEqual(["backlog", "interview"]);
    expect(lastNote(made.id).text).toBe(`Created ${by}.`);
    expect(store.getTicket(far.slug, made.id)!.startedBy ?? null).toBeNull();
    // Edit, comment, move: logged with the source board and ticket.
    r = await send(`${farTickets}/${existing.id}`, { title: "Measure the hallway twice" }, asChat, "PATCH");
    expect(r.status).toBe(200);
    expect(lastNote(existing.id).text).toBe(`Changed title ${by}.`);
    r = await send(`${farTickets}/${existing.id}/comments`, { text: "bring the laser" }, asChat);
    expect(r.status).toBe(201);
    expect(lastNote(existing.id).text).toBe(`From the chat of ${chat.id} on Berry Best (user request): bring the laser`);
    // Starting a run there counts against the chat's ticket on its own board, and remembers that board.
    r = await send(`${farTickets}/${existing.id}`, { status: "ready" }, asChat, "PATCH");
    expect(r.status).toBe(200);
    expect(store.getTicket(far.slug, existing.id)!.startedBy).toEqual({ ticketId: chat.id, depth: 1, slug: home.slug });
    board.markStartedBy(home.slug, chat.id, { ticketId: "t_20261001_root", depth: 2 });
    r = await send(farTickets, { title: "Start me", status: "ready" }, asChat);
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toContain("stops at 2");
    board.markStartedBy(home.slug, chat.id, null);
    // Spending cap and deleting stay the user's.
    r = await send(`${farTickets}/${existing.id}`, { runCapUsd: 0 }, asChat, "PATCH");
    expect(r.status).toBe(403);
    r = await fetch(`${farTickets}/${made.id}`, { method: "DELETE", headers: asChat });
    expect(r.status).toBe(403);

    // A work run and a huddle helper of the chat's ticket: refused, saying why.
    for (const headers of [asWork, { ...asChat, "x-ckanban-huddle-agent": "reviewer" }]) {
      r = await send(farTickets, { title: "Nope" }, headers);
      expect(r.status).toBe(403);
      expect(await errorOf(r)).toContain("only works in a chat reply to a message the user typed");
    }
    expect(store.listTickets(far.slug).some((t) => t.title === "Nope")).toBe(false);
    // Own board: unchanged, the work run still changes its own board's tickets.
    r = await send(`${base}/api/profiles/${home.slug}/tickets/${chat.id}/comments`, { text: "note" }, asWork);
    expect(r.status).toBe(201);
  } finally {
    board.userAskedRun = realAsked;
    board.runnerRights = realRunner;
  }
});

test("a ticket's own chat moves its own card to done, backlog or ready only at the user's request", async () => {
  const p = (await (await fetch(`${base}/api/profiles`, json("POST", { name: "Self Move", path: tempDir("ck-self-") }))).json()) as any;
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const t = (await (await fetch(tickets, json("POST", { title: "Mine", status: "review" }))).json()) as any;
  const patch = (b: unknown, headers: Record<string, string>) =>
    fetch(`${tickets}/${t.id}`, { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
  const run = { "x-ckanban-run": `${p.slug}/${t.id}` };
  const errorOf = async (r: Response) => ((await r.json()) as any).error as string;

  // No reply to the user's own message behind the run: refused, with what would work.
  let r = await patch({ status: "done" }, run);
  expect(r.status).toBe(403);
  expect(await errorOf(r)).toContain("only when the user asks for that in a message they typed");

  const asked: string[] = [];
  const real = board.requestSelfMove.bind(board);
  board.requestSelfMove = (slug, id, status) => (slug === p.slug && id === t.id ? (asked.push(status), true) : real(slug, id, status));
  try {
    for (const status of ["done", "backlog", "ready"]) {
      r = await patch({ status }, run);
      expect(r.status).toBe(200);
      expect((await r.json()) as any).toMatchObject({ id: t.id, status: "review", selfMove: status });
    }
    expect(asked).toEqual(["done", "backlog", "ready"]);
    // Other columns, other changes and a huddle agent of the same ticket: refused.
    for (const [b, h] of [[{ status: "planning" }, run], [{ status: "done", title: "x" }, run], [{ status: "done" }, { ...run, "x-ckanban-huddle-agent": "reviewer" }]] as const) {
      r = await patch(b, h);
      expect(r.status).toBe(403);
    }
    expect(asked.length).toBe(3);
    expect(store.getTicket(p.slug, t.id)!.status).toBe("review");
  } finally {
    board.requestSelfMove = real;
  }
});

test("spending: card cost, today's spend and caps set by the user only", async () => {
  const path = tempDir("ck-plain-");
  let r = await fetch(`${base}/api/profiles`, json("POST", { name: "Spend", path }));
  const p = (await r.json()) as any;
  r = await fetch(`${base}/api/profiles/${p.slug}`, json("PATCH", { runCapUsd: 3 }));
  expect(((await r.json()) as any).runCapUsd).toBe(3);
  r = await fetch(`${base}/api/profiles/${p.slug}/tickets`, json("POST", { title: "Costly" }));
  const t = (await r.json()) as any;
  store.appendActivity(p.slug, t.id, 1, { type: "result", session_id: "s", total_cost_usd: 0.42 });
  // Backlog cards show no $; Review cards do.
  r = await fetch(`${base}/api/profiles/${p.slug}/tickets/${t.id}`);
  expect(((await r.json()) as any).costUsd).toBeNull();
  store.updateTicket(p.slug, t.id, { status: "review" });
  r = await fetch(`${base}/api/profiles/${p.slug}/tickets/${t.id}`);
  expect((await r.json()) as any).toMatchObject({ costUsd: 0.42, runCap: 3 });
  r = await fetch(`${base}/api/spend`);
  const spend = (await r.json()) as any;
  expect(spend.boards.find((b: any) => b.slug === p.slug).costUsd).toBeCloseTo(0.42);

  r = await fetch(`${base}/api/profiles/${p.slug}/tickets/${t.id}`, json("PATCH", { runCapUsd: 0 }));
  expect((await r.json()) as any).toMatchObject({ runCapUsd: 0, runCap: null });
  r = await fetch(`${base}/api/profiles/${p.slug}/tickets/${t.id}`, json("PATCH", { runCapUsd: -1 }));
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/profiles/${p.slug}/tickets/${t.id}`, {
    ...json("PATCH", { runCapUsd: 100 }), headers: { "content-type": "application/json", "x-ckanban-run": `${p.slug}/${t.id}` },
  });
  expect(r.status).toBe(403);
});

test("notification settings: read, update, validate; board runs are refused", async () => {
  let r = await fetch(`${base}/api/notify`);
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).webhookUrl).toBe("");
  r = await fetch(`${base}/api/notify`, json("POST", { webhookUrl: "https://ntfy.sh/abc", kinds: { review: false } }));
  const s = (await r.json()) as any;
  expect(s.webhookUrl).toBe("https://ntfy.sh/abc");
  expect(s.kinds.review).toBe(false);
  expect(s.kinds.questions).toBe(true);
  r = await fetch(`${base}/api/notify`, json("POST", { webhookUrl: "javascript:alert(1)" }));
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/notify`, { headers: { "x-ckanban-run": "p/t_1" } });
  expect(r.status).toBe(403);
  r = await fetch(`${base}/api/notify`, json("POST", { webhookUrl: "" }));
  expect(((await r.json()) as any).webhookUrl).toBe("");
});

test("phone push: public key, turn a device on, heartbeat, remove; board runs are refused", async () => {
  let r = await fetch(`${base}/api/push`);
  const first = (await r.json()) as any;
  expect(first.publicKey).toMatch(/^[\w-]{80,}$/);
  expect(first.devices).toEqual([]);
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: first.publicKey, auth: "BTBZMqHH6r4Tts7J_aSIgg" } };
  r = await fetch(`${base}/api/push/subscribe`, json("POST", { subscription: sub, label: "Android · Chrome" }));
  const d = (await r.json()) as any;
  expect(d.label).toBe("Android · Chrome");
  r = await fetch(`${base}/api/push/subscribe`, json("POST", { subscription: { endpoint: "nope" } }));
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/push/visible`, json("POST", { endpoint: sub.endpoint, visible: true }));
  expect(r.status).toBe(200);
  // Turned on at the board's own (localhost) address: a browser on this Mac, so the macOS banner steps aside.
  expect(((await (await fetch(`${base}/api/notify`)).json()) as any).macBrowser).toBe(true);
  r = await fetch(`${base}/api/push`, { headers: { "x-ckanban-run": "p/t_1" } });
  expect(r.status).toBe(403);
  r = await fetch(`${base}/api/push/remove`, json("POST", { id: d.id }));
  expect(((await r.json()) as any).devices).toEqual([]);
  expect(((await (await fetch(`${base}/api/notify`)).json()) as any).macBrowser).toBe(false);
});

test("version history: offered for a plain folder, turned on with one local commit, a .gitignore and nothing pushed", async () => {
  const path = tempDir("ck-plain-");
  writeFileSync(join(path, "index.html"), "<h1>shop</h1>\n");
  writeFileSync(join(path, ".env"), "SECRET=1\n");
  mkdirSync(join(path, "node_modules", "x"), { recursive: true });
  writeFileSync(join(path, "node_modules", "x", "i.js"), "1\n");
  let r = await fetch(`${base}/api/version-history?path=${encodeURIComponent(path)}`);
  expect(await r.json()).toEqual({ git: true, repo: "plain" });
  r = await fetch(`${base}/api/version-history`, json("POST", { path }));
  expect(r.status).toBe(200);
  const out = (await r.json()) as any;
  expect(out).toMatchObject({ changed: true, repo: "local" });
  const files = (await run(["git", "ls-files"], path)).stdout.trim().split("\n");
  expect(files.sort()).toEqual([".gitignore", "index.html"]);
  expect((await run(["git", "log", "--format=%s"], path)).stdout.trim()).toBe("Initial snapshot (ckanban)");
  expect((await run(["git", "remote"], path)).stdout.trim()).toBe("");
  // Already on: nothing happens a second time.
  r = await fetch(`${base}/api/version-history`, json("POST", { path }));
  expect(((await r.json()) as any).changed).toBe(false);
  expect((await run(["git", "rev-list", "--count", "HEAD"], path)).stdout.trim()).toBe("1");
  r = await fetch(`${base}/api/version-history`, json("POST", { path: "relative/path" }));
  expect(r.status).toBe(400);
});

test("the Changes tab explains why a ticket without a worktree has nothing to show", async () => {
  const path = tempDir("ck-plain-");
  const p = (await (await fetch(`${base}/api/profiles`, json("POST", { name: "Diffless", path }))).json()) as any;
  const t = (await (await fetch(`${base}/api/profiles/${p.slug}/tickets`, json("POST", { title: "x" }))).json()) as any;
  const r = await fetch(`${base}/api/profiles/${p.slug}/tickets/${t.id}/diff`);
  expect(r.status).toBe(404);
  expect(((await r.json()) as any).error).toBe("No version history for this folder, so changes can't be shown.");
});

test("board Workspace setting: default worktree, folder or worktree only", async () => {
  const path = await makeRepo();
  let r = await fetch(`${base}/api/profiles`, json("POST", { name: "Ws board", path }));
  expect(r.status).toBe(201);
  const p = (await r.json()) as any;
  expect(p.workspace).toBeUndefined();
  r = await fetch(`${base}/api/profiles/${p.slug}`, json("PATCH", { workspace: "folder" }));
  expect(((await r.json()) as any).workspace).toBe("folder");
  r = await fetch(`${base}/api/profiles/${p.slug}`, json("PATCH", { workspace: "elsewhere" }));
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/profiles`, json("POST", { name: "Ws board 2", path, workspace: "folder" }));
  expect(((await r.json()) as any).workspace).toBe("folder");
});

test("tags: the user sets them; a ticket's own run may only suggest them", async () => {
  const path = tempDir("ck-tags-");
  const p = (await (await fetch(`${base}/api/profiles`, json("POST", { name: "Tag Proj", path }))).json()) as any;
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const send = (u: string, b: unknown, run?: string, method = "PATCH") =>
    fetch(u, { method, headers: { "content-type": "application/json", ...(run ? { "x-ckanban-run": run } : {}) }, body: JSON.stringify(b) });
  const t = (await (await send(tickets, { title: "Post 5", tags: ["Post", "#XHS"] }, undefined, "POST")).json()) as any;
  expect(t.tags).toEqual(["post", "xhs"]);
  const run = `${p.slug}/${t.id}`;
  let r = await send(`${tickets}/${t.id}`, { suggestedTags: ["Video"] }, run);
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).suggestedTags).toEqual(["video"]);
  // Setting tags directly from a run is refused, like other board changes.
  r = await send(`${tickets}/${t.id}`, { tags: ["video"] }, run);
  expect(r.status).toBe(403);
  r = await send(`${tickets}/${t.id}`, { tags: ["post", "xhs", "video"] });
  const kept = (await r.json()) as any;
  expect([kept.tags, kept.suggestedTags]).toEqual([["post", "xhs", "video"], []]);
});

test("one-time jobs: schedule, list, update, run now, and runs manage only their own", async () => {
  let r = await fetch(`${base}/api/profiles`, json("POST", { name: "Jobs", path: tempDir("ck-jobs-") }));
  const slug = ((await r.json()) as any).slug;
  const url = `${base}/api/profiles/${slug}/jobs`;
  const src = (await (await fetch(`${base}/api/profiles/${slug}/tickets`, json("POST", { title: "Planner", status: "backlog" }))).json()) as any;
  const as = (run: string, method: string, b?: unknown) => ({
    method, headers: { "content-type": "application/json", "x-ckanban-run": `${slug}/${run}` }, body: b ? JSON.stringify(b) : undefined,
  });
  const d = new Date(Date.now() + 3 * 86400_000);
  const when = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 22:00`;

  r = await fetch(url, as(src.id, "POST", { name: "Past", at: "2020-01-01 10:00", action: { kind: "command", command: "true" } }));
  expect(r.status).toBe(400);
  expect(((await r.json()) as any).error).toContain("in the past");

  r = await fetch(url, as(src.id, "POST", { name: "Post A", at: when, action: { kind: "command", command: "echo posted" } }));
  expect(r.status).toBe(201);
  const j = (await r.json()) as any;
  expect(j).toMatchObject({ name: "Post A", state: "scheduled", sourceTicketId: src.id });
  expect(j.when).toContain("22:00 (in ");

  r = await fetch(`${url}?ticketId=${src.id}`);
  expect(((await r.json()) as any[]).map((x) => x.id)).toEqual([j.id]);

  const other = (await (await fetch(`${base}/api/profiles/${slug}/tickets`, json("POST", { title: "Other", status: "backlog" }))).json()) as any;
  r = await fetch(`${url}/${j.id}`, as(other.id, "PATCH", { name: "Hijack" }));
  expect(r.status).toBe(403);
  // A run whose ticket doesn't exist can't make a job it couldn't manage.
  r = await fetch(url, as("t_20261001_ghost", "POST", { name: "x", at: when, action: { kind: "command", command: "true" } }));
  expect(r.status).toBe(404);
  // Huddle teammates run as the host ticket but may not touch its jobs.
  const agent = as(src.id, "POST");
  r = await fetch(`${url}/${j.id}/cancel`, { ...agent, headers: { ...agent.headers, "x-ckanban-huddle-agent": "h_x/qa-1" } });
  expect(r.status).toBe(403);
  expect(((await r.json()) as any).error).toContain("huddle participants");
  r = await fetch(`${url}/${j.id}`, as(src.id, "PATCH", { name: "Post A!" }));
  expect(((await r.json()) as any).name).toBe("Post A!");

  r = await fetch(`${url}/${j.id}/run`, as(src.id, "POST"));
  expect(((await r.json()) as any).state).toBe("running");
  for (let i = 0; i < 50 && ((await (await fetch(`${url}/${j.id}`)).json()) as any).state === "running"; i++) await Bun.sleep(50);
  const done = (await (await fetch(`${url}/${j.id}`)).json()) as any;
  expect(done).toMatchObject({ state: "done", result: { exitCode: 0, output: "posted\n" } });

  r = await fetch(`${url}/${j.id}/cancel`, json("POST"));
  expect(r.status).toBe(409);
  // Skipping is gone: a late command skips itself, cancel covers the rest.
  r = await fetch(`${url}/${j.id}/skip`, json("POST"));
  expect(r.status).toBe(404);
  r = await fetch(`${url}/nope1234`);
  expect(r.status).toBe(404);
});

test("notify: only the ticket's own Claude sends it, and it is told where it went", async () => {
  const path = tempDir("ck-plain-");
  const p = (await (await fetch(`${base}/api/profiles`, json("POST", { name: "Notify", path }))).json()) as any;
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const send = (u: string, b: unknown, headers: Record<string, string> = {}) =>
    fetch(u, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
  const t = (await (await send(tickets, { title: "Pitch" })).json()) as any;
  const other = (await (await send(tickets, { title: "Other" })).json()) as any;
  const run = { "x-ckanban-run": `${p.slug}/${t.id}` };
  const url = `${tickets}/${t.id}/notify`;
  expect((await send(url, { message: "Pick A or B" })).status).toBe(403);
  expect((await send(`${tickets}/${other.id}/notify`, { message: "Pick A or B" }, run)).status).toBe(403);
  expect((await send(url, { message: "Pick A or B" }, { ...run, "x-ckanban-huddle-agent": "h1/reviewer" })).status).toBe(403);
  expect((await send(url, {}, run)).status).toBe(400);
  // No real macOS banner from a test.
  await send(`${base}/api/notify`, { mac: false });
  const r = await send(url, { message: "Pick A or B" }, run);
  expect(r.status).toBe(200);
  expect(((await r.json()) as any)).toMatchObject({ delivered: false, reason: "nowhere" });
});

test("follow-ups: a run sets and stops its own ticket's only; the user's Stop, seen and chat", async () => {
  const path = tempDir("ck-plain-");
  const p = (await (await fetch(`${base}/api/profiles`, json("POST", { name: "Follow", path }))).json()) as any;
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const send = (u: string, b: unknown, run?: string, method = "POST") =>
    fetch(u, { method, headers: { "content-type": "application/json", ...(run ? { "x-ckanban-run": run } : {}) }, body: JSON.stringify(b) });
  const t = (await (await send(tickets, { title: "Pitch" })).json()) as any;
  const other = (await (await send(tickets, { title: "Other" })).json()) as any;
  const run = `${p.slug}/${t.id}`;
  const fu = `${tickets}/${t.id}/follow-up`;

  let r = await send(`${tickets}/${other.id}/follow-up`, { after: "1d", note: "x" }, run);
  expect(r.status).toBe(403);
  r = await send(fu, { after: "0.5m", note: "x" }, run);
  expect(r.status).toBe(400);
  expect(((await r.json()) as any).error).toContain("at least 1 minute");
  r = await send(fu, { after: "1d", note: "Check Gmail" }, run);
  expect(r.status).toBe(201);
  expect(((await r.json()) as any).followUp).toMatchObject({ note: "Check Gmail", cancelOnReply: true });
  // Follow up now and seen are the user's.
  expect((await send(`${fu}/now`, {}, run)).status).toBe(403);
  expect((await send(`${tickets}/${t.id}/seen`, {}, run)).status).toBe(403);
  r = await send(`${tickets}/${t.id}/seen`, {});
  expect(((await r.json()) as any).seenAt).toBeString();
  // Claude stops with a reason; the card shows it.
  expect((await send(fu, {}, run, "DELETE")).status).toBe(400);
  r = await send(fu, { reason: "No reply after 2 nudges" }, run, "DELETE");
  expect(((await r.json()) as any).followUpStopped).toMatchObject({ reason: "No reply after 2 nudges" });
  // The user's chat message cancels a cancel-on-reply follow-up.
  await send(fu, { after: "1d", note: "Check again" }, run);
  await send(`${tickets}/${t.id}/chat`, { text: "they replied by phone" });
  expect(store.getTicket(p.slug, t.id)!.followUp).toBeNull();
  // The user's Stop.
  await send(fu, { after: "1d", note: "Check again" }, run);
  r = await send(fu, {}, undefined, "DELETE");
  expect(((await r.json()) as any).followUp).toBeNull();
});

test("POST move sends a Backlog ticket to another board", async () => {
  await fetch(`${base}/api/profiles`, json("POST", { name: "Move A", path: tempDir("ck-plain-") }));
  await fetch(`${base}/api/profiles`, json("POST", { name: "Move B", path: tempDir("ck-plain-") }));
  const t = (await (await fetch(`${base}/api/profiles/move-a/tickets`, json("POST", { title: "Wrong board", body: "b", status: "backlog" }))).json()) as any;
  let r = await fetch(`${base}/api/profiles/move-a/tickets/${t.id}/move`, json("POST", { board: "nowhere" }));
  expect(r.status).toBe(404);
  r = await fetch(`${base}/api/profiles/move-a/tickets/${t.id}/move`, json("POST", { board: "move-b" }));
  expect(r.status).toBe(201);
  expect(((await r.json()) as any).title).toBe("Wrong board");
  expect(((await (await fetch(`${base}/api/profiles/move-a/tickets`)).json()) as any[]).length).toBe(0);
  expect(((await (await fetch(`${base}/api/profiles/move-b/tickets`)).json()) as any[]).map((x) => x.title)).toEqual(["Wrong board"]);
});
