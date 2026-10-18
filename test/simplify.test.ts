import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { SessionCache } from "../src/server/session";
import { makeSideCaller, parseSideResult, sideCallArgs, type SideCallInput, type SideCallResult } from "../src/server/side-call";
import { SpendIndex } from "../src/server/spend";
import { Store } from "../src/server/store";
import { simplifiable as webSimplifiable } from "../web/src/simplifyText";
import { simplifiable } from "../src/server/simplify";
import { tempDir } from "./helpers";

const L = (o: unknown) => JSON.stringify(o);
const LONG = "I added the ForgotLink component to LoginForm.tsx and wired it to /auth/reset via navigate(). Tests: 14 passed, tsc clean. "
  + "Pushed 3f9a2c1 to main; the daemon restart is pending until the other runs finish, then the link shows up.";
const RAW = [
  L({ type: "user", uuid: "u1", timestamp: "2026-10-18T01:00:00Z", message: { role: "user", content: "Add a forgot password link under the login button, please, with tests and everything else you need to make it work well." } }),
  L({ type: "assistant", uuid: "a1", timestamp: "2026-10-18T01:00:05Z", message: { role: "assistant", content: [{ type: "text", text: LONG }] } }),
  L({ type: "assistant", uuid: "a2", timestamp: "2026-10-18T01:00:06Z", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
].join("\n");
const SID = "11111111-2222-3333-4444-777777777777";

let server: ReturnType<typeof createServer>;
let store: Store;
let base: string;
let sessionFile: string;
const calls: SideCallInput[] = [];
let next: SideCallResult = { ok: true, text: "The login page now has a Forgot password link.", costUsd: 0.0012, model: "claude-haiku-5-5" };
let gate: Promise<void> | null = null;

beforeAll(() => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-proj");
  mkdirSync(dir, { recursive: true });
  sessionFile = join(dir, `${SID}.jsonl`);
  writeFileSync(sessionFile, RAW + "\n");
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  server = createServer({
    store, bus, board, port: 0, webDir: tempDir("ck-web-"), sessions: new SessionCache({ configDir }),
    sideCall: async (i) => {
      calls.push(i);
      if (gate) await gate;
      return next;
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
});

afterAll(() => server.stop(true));

function ticket() {
  const t = store.createTicket("p", { title: "Login page: forgot password", body: "", status: "review" });
  store.updateTicket("p", t.id, { sessionId: SID });
  return t.id;
}

const simplify = (id: string, uuid: string) =>
  fetch(`${base}/api/profiles/p/tickets/${id}/simplify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uuid }) });
const saved = async (id: string) => (await (await fetch(`${base}/api/profiles/p/tickets/${id}/simplified`)).json()) as Record<string, string>;

test("simplify: one side call with the ticket title, saved per message, second time free", async () => {
  const id = ticket();
  calls.length = 0;
  const before = readFileSync(sessionFile, "utf8");
  const r = await simplify(id, "a1");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ text: next.ok ? next.text : "", cached: false });
  expect(calls).toHaveLength(1);
  expect(calls[0].prompt).toContain("Login page: forgot password");
  expect(calls[0].prompt).toContain("LoginForm.tsx");
  expect(calls[0].system).toContain("like one human talking to another");

  // Cached: no new call, survives a reload (GET simplified).
  expect(await (await simplify(id, "a1")).json()).toMatchObject({ cached: true });
  expect(calls).toHaveLength(1);
  expect(await saved(id)).toEqual({ a1: "The login page now has a Forgot password link." });

  // Never in the session or the activity log.
  expect(readFileSync(sessionFile, "utf8")).toBe(before);
  expect(existsSync(store.activityPath("p", id))).toBe(false);
});

test("simplify: the side call's cost is added to the ticket's spend and Usage total", async () => {
  const id = ticket();
  const spend = new SpendIndex(store);
  expect(spend.ticket("p", id).costUsd).toBe(0);
  const today = spend.today().costUsd;
  await simplify(id, "a1");
  expect(spend.ticket("p", id).costUsd).toBeCloseTo(0.0012, 6);
  expect(spend.today().costUsd - today).toBeCloseTo(0.0012, 6);
  const usage = (await (await fetch(`${base}/api/profiles/p/tickets/${id}/usage`)).json()) as any;
  expect(usage.totals.costUsd).toBeCloseTo(0.0012, 6);
  expect(usage.sideCostUsd).toBeCloseTo(0.0012, 6);
});

test("simplify: double clicks share one call", async () => {
  const id = ticket();
  calls.length = 0;
  let open!: () => void;
  gate = new Promise((r) => (open = r));
  const a = simplify(id, "a1");
  const b = simplify(id, "a1");
  await Bun.sleep(50);
  open();
  gate = null;
  expect((await a).status).toBe(200);
  expect((await b).status).toBe(200);
  expect(calls).toHaveLength(1);
});

test("simplify: short replies, unknown messages and failed calls", async () => {
  const id = ticket();
  expect((await simplify(id, "a2")).status).toBe(400);
  expect((await simplify(id, "u1")).status).toBe(400);
  expect((await simplify(id, "nope")).status).toBe(404);
  const fromRun = await fetch(`${base}/api/profiles/p/tickets/${id}/simplify`, {
    method: "POST", headers: { "content-type": "application/json", "x-ckanban-run": "1" }, body: JSON.stringify({ uuid: "a1" }),
  });
  expect(fromRun.status).toBe(403);
  const prev = next;
  next = { ok: false, error: "not logged in" };
  try {
    const r = await simplify(id, "a1");
    expect(r.status).toBe(502);
    expect(await saved(id)).toEqual({});
    expect(new SpendIndex(store).ticket("p", id).costUsd).toBe(0);
  } finally {
    next = prev;
  }
});

test("simplifiable: same rule on the server and in the chat", () => {
  const cases = [
    { role: "assistant" as const, kind: "text" as const, text: LONG, uuid: "x", at: "" },
    { role: "assistant" as const, kind: "text" as const, text: "Done.", uuid: "x", at: "" },
    { role: "user" as const, kind: "text" as const, text: LONG, uuid: "x", at: "" },
    { role: "assistant" as const, kind: "tool" as const, text: LONG, uuid: "x", at: "" },
    { role: "assistant" as const, kind: "text" as const, text: LONG, uuid: "x", at: "", commandOutput: true },
  ];
  expect(cases.map(simplifiable)).toEqual([true, false, false, false, false]);
  expect(cases.map(webSimplifiable)).toEqual(cases.map(simplifiable));
});

test("side call: one-shot, cheapest model, no tools or session; reads answer and cost", async () => {
  const args = sideCallArgs({ prompt: "p", system: "s" });
  expect(args).toContain("--no-session-persistence");
  expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "haiku"]);
  expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
  expect(args).not.toContain("--resume");

  expect(parseSideResult(L({ type: "result", is_error: false, result: " Hi ", total_cost_usd: 0.002, modelUsage: { "claude-haiku-5-5": {} } }), 0, "", "haiku"))
    .toEqual({ ok: true, text: "Hi", costUsd: 0.002, model: "claude-haiku-5-5" });
  expect(parseSideResult(L({ type: "result", is_error: true, result: "Invalid API key" }), 1, "", "haiku")).toEqual({ ok: false, error: "Invalid API key" });
  expect(parseSideResult("", 1, "boom\n", "haiku")).toEqual({ ok: false, error: "boom" });

  // A fake claude: prompt on stdin, JSON answer on stdout, run outside the project.
  const bins = tempDir("ck-side-");
  const fake = join(bins, "claude");
  writeFileSync(fake, `#!/bin/sh\nIN=$(cat)\nprintf '{"type":"result","is_error":false,"result":"%s|%s","total_cost_usd":0.001}' "$IN" "$(pwd)"\n`);
  chmodSync(fake, 0o755);
  const cwd = join(bins, "work");
  const r = await makeSideCaller({ bin: fake, cwd, env: { PATH: process.env.PATH } })({ prompt: "hello", system: "s" });
  expect(r).toMatchObject({ ok: true, costUsd: 0.001 });
  expect(r.ok && r.text.split("|")[0]).toBe("hello");
  expect(r.ok && r.text.split("|")[1]).toEndWith("work");
});
