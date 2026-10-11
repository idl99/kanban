import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attentionFor, ticketAttention } from "../src/server/attention";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { isTransientText, transientError } from "../src/server/retry";
import { buildArgs, startRun } from "../src/server/runner";
import { Store } from "../src/server/store";
import type { Ticket } from "../src/server/types";
import { makeRepo, tempDir } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");
const STREAM = buildArgs("u1", false, null);

let store: Store;
let bus: Bus;
let board: Board;
let argsFile: string;
const ENV = ["FAKE_MODE", "FAKE_ARGS_FILE", "CLAUDE_CONFIG_DIR", "FAKE_ONCE_FILE", "FAKE_SILENT_MS", "FAKE_BG_MS", "FAKE_PR", "FAKE_NO_SAVE"];

async function setup(opts: { stallMs?: number; retryDelayMs?: number } = {}) {
  const path = await makeRepo();
  store.saveProfile({ name: "P", slug: "p", path, baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() });
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false, retryDelayMs: opts.retryDelayMs ?? 50, stallMs: opts.stallMs ?? 0, notify: () => {} });
}

const runs = (): number => (existsSync(argsFile) ? readFileSync(argsFile, "utf8").trim().split("\n").length : 0);
const prompts = (): string[] => (existsSync(argsFile) ? readFileSync(argsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l).prompt) : []);

async function until(fn: () => boolean, ms = 8000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  argsFile = join(tempDir("ck-args-"), "args.jsonl");
  process.env.FAKE_ARGS_FILE = argsFile;
  process.env.CLAUDE_CONFIG_DIR = tempDir("ck-claude-");
  process.env.FAKE_PR = "https://github.com/x/y/pull/7";
});

afterEach(async () => {
  await board?.shutdown();
  for (const k of ENV) delete process.env[k];
}, 10000);

test("transient API errors are told apart from lasting ones and the usage limit", () => {
  expect(isTransientText("API Error: 529 Overloaded")).toBe(true);
  expect(isTransientText("API Error: 503 Service Unavailable")).toBe(true);
  expect(isTransientText("Error: read ECONNRESET")).toBe(true);
  expect(isTransientText("TypeError: fetch failed")).toBe(true);
  expect(isTransientText("API Error: 400 prompt is too long")).toBe(false);
  expect(isTransientText("You've hit your session limit · resets 4am")).toBe(false);
  const apiErr = (text: string, status?: number) => [
    { type: "assistant", message: { content: [{ type: "text", text }] }, is_api_error_message: true },
    { type: "result", is_error: true, result: text, ...(status ? { api_error_status: status } : {}) },
  ];
  expect(transientError(apiErr("API Error: 529 Overloaded", 529))).toContain("529");
  expect(transientError(apiErr("Something odd", 502))).toBe("Something odd");
  expect(transientError(apiErr("API Error: 401 invalid x-api-key", 401))).toBeNull();
  // Claude's own words about a 503 in the code it works on aren't an API error.
  expect(transientError([{ type: "assistant", message: { content: [{ type: "text", text: "The server returns 503 overloaded" }] } }])).toBeNull();
  expect(transientError([], "Error: socket hang up\n")).toBe("Error: socket hang up");
  expect(transientError([], "boom: something failed")).toBeNull();
  // stderr: only its last line, only for a run that got no result, and no bare numbers.
  expect(transientError([], "MCP server \"x\" connection error: ECONNREFUSED 127.0.0.1:9\nError: something unrelated broke")).toBeNull();
  expect(transientError([], "Processed 500 files\nfatal: not a git repository")).toBeNull();
  expect(transientError([{ type: "result", is_error: true, result: "Error: prompt is too long", api_error_status: 400 }], "ECONNRESET")).toBeNull();
  // An API-error event with nothing in it doesn't hide the 529 before it.
  expect(transientError([...apiErr("API Error: 529 Overloaded", 529).slice(0, 1), { type: "result", is_error: true }])).toContain("529");
});

test("runner: a silent run stalls, and output clears it", async () => {
  process.env.FAKE_MODE = "silent";
  process.env.FAKE_SILENT_MS = "2000";
  const seen: boolean[] = [];
  const r = await startRun({ bin: FAKE, cwd: tempDir(), args: STREAM, input: "go", onEvent: () => {}, stallMs: 1000, onStall: (s) => seen.push(s) }).done;
  expect(r.code).toBe(0);
  // A slow start under load can add a stall/clear pair before the silence; it always ends cleared.
  expect(seen[0]).toBe(true);
  expect(seen.at(-1)).toBe(false);
  expect(seen.every((v, i) => v === (i % 2 === 0))).toBe(true);
}, 10000);

test("runner: waiting on a declared background task is not a stall", async () => {
  process.env.FAKE_MODE = "bgsilent";
  process.env.FAKE_BG_MS = "2500";
  const seen: boolean[] = [];
  const r = await startRun({ bin: FAKE, cwd: tempDir(), args: STREAM, input: "go", onEvent: () => {}, graceMs: 50, stallMs: 1000, onStall: (s) => seen.push(s) }).done;
  expect(r.code).toBe(0);
  expect(seen).toEqual([]);
}, 10000);

test("a silent run becomes stalled, needs the user, and Restart resumes the same session", async () => {
  await setup({ stallMs: 1000 });
  process.env.FAKE_MODE = "silent";
  process.env.FAKE_ONCE_FILE = join(tempDir("ck-once-"), "once");
  const t = await board.createTicket("p", { title: "Hang", body: "", status: "ready" });
  await until(() => !!store.getTicket("p", t.id)?.stalled);
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("in_progress");
  expect(got.stalled?.minutes).toBe(1);
  const att = ticketAttention(store, "p", got, null, board.isRunning("p", t.id));
  expect(att?.kind).toBe("stalled");
  expect(board.waitsOnUser("p", t.id)).toBe(true);

  board.stallAction("p", t.id, "restart");
  await board.whenIdle();
  const done = store.getTicket("p", t.id)!;
  expect(done.outcome).toBe("done");
  expect(done.status).toBe("review");
  expect(done.stalled).toBeNull();
  expect(done.runCount).toBe(1);
  expect(runs()).toBe(2);
  expect(prompts()[1]).toContain("stopped responding");
  // The restart resumed the same session.
  const lines = readFileSync(argsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l).args as string[]);
  expect(lines[1]).toContain("--resume");
  expect(lines[1]).toContain(done.sessionId!);
  expect(store.listComments("p", t.id).map((c) => c.text)).toContain("Restarted the stalled run: it continues in the same session.");
}, 15000);

test("Keep waiting clears the stall; the run then finishes by itself", async () => {
  await setup({ stallMs: 1000 });
  process.env.FAKE_MODE = "silent";
  process.env.FAKE_SILENT_MS = "2500";
  const t = await board.createTicket("p", { title: "Slow", body: "", status: "ready" });
  await until(() => !!store.getTicket("p", t.id)?.stalled);
  expect(board.stallAction("p", t.id, "wait").stalled).toBeNull();
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("done");
  expect(got.stalled).toBeNull();
  expect(runs()).toBe(1);
}, 15000);

test("Stop on a stalled run stops it", async () => {
  await setup({ stallMs: 1000 });
  process.env.FAKE_MODE = "silent";
  const t = await board.createTicket("p", { title: "Hang", body: "", status: "ready" });
  await until(() => !!store.getTicket("p", t.id)?.stalled);
  board.stallAction("p", t.id, "stop");
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("stopped");
  expect(got.stalled).toBeNull();
}, 15000);

test("a transient API failure retries once in the same session and succeeds", async () => {
  await setup();
  process.env.FAKE_MODE = "overloaded";
  process.env.FAKE_ONCE_FILE = join(tempDir("ck-once-"), "once");
  const t = await board.createTicket("p", { title: "Flaky", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("done");
  expect(got.prUrl).toBe("https://github.com/x/y/pull/7");
  expect(got.runCount).toBe(1);
  expect(runs()).toBe(2);
  expect(prompts()[1]).toContain("temporary API error");
  const texts = store.listComments("p", t.id).map((c) => c.text);
  expect(texts.some((c) => c.startsWith("Run hit a temporary API error (API Error: 529"))).toBe(true);
  expect(texts.at(-1)).toBe("fake done");
}, 15000);

test("a second transient failure fails the run as before", async () => {
  await setup();
  process.env.FAKE_MODE = "overloaded";
  const t = await board.createTicket("p", { title: "Down", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("failed");
  expect(runs()).toBe(2);
}, 15000);

test("a lasting API error does not retry", async () => {
  await setup();
  process.env.FAKE_MODE = "badrequest";
  const t = await board.createTicket("p", { title: "Bad", body: "", status: "ready" });
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.outcome).toBe("failed");
  expect(runs()).toBe(1);
  expect(store.listComments("p", t.id).some((c) => c.text.includes("temporary API error"))).toBe(false);
});

test("a stalled running ticket is in the attention kinds; once the run ends it isn't", () => {
  const T = (p: Partial<Ticket>): Ticket => ({
    id: "t", title: "T", status: "in_progress", order: 1, sessionId: "s", worktree: null, branch: null, prUrl: null,
    outcome: null, lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: "", updatedAt: "", body: "b", ...p,
  });
  const stalled = { at: "2026-10-11T10:00:00Z", minutes: 20 };
  expect(attentionFor(T({ stalled }), null, true)).toEqual({ kind: "stalled", label: "Stalled · no output for 20 min", since: stalled.at });
  expect(attentionFor(T({ stalled }), null, false)).toBeNull();
  expect(attentionFor(T({}), null, true)).toBeNull();
});

test("Restart of a run that hung before its session was saved starts over with the ticket's prompt", async () => {
  await setup({ stallMs: 1000 });
  process.env.FAKE_MODE = "silent";
  process.env.FAKE_NO_SAVE = "1";
  process.env.FAKE_ONCE_FILE = join(tempDir("ck-once-"), "once");
  const t = await board.createTicket("p", { title: "Hang at start", body: "IMPORTANT TASK BODY", status: "ready" });
  await until(() => !!store.getTicket("p", t.id)?.stalled);
  board.stallAction("p", t.id, "restart");
  await board.whenIdle();
  expect(runs()).toBe(2);
  expect(prompts()[1]).toContain("IMPORTANT TASK BODY");
}, 15000);

test("Restart and Keep waiting refuse a run that isn't stalled; a second Restart click is refused too", async () => {
  await setup({ stallMs: 1000 });
  process.env.FAKE_MODE = "silent";
  process.env.FAKE_SILENT_MS = "2500";
  const t = await board.createTicket("p", { title: "Healthy", body: "", status: "ready" });
  await until(() => board.isRunning("p", t.id) && existsSync(argsFile));
  expect(() => board.stallAction("p", t.id, "restart")).toThrow("not stalled");
  expect(() => board.stallAction("p", t.id, "wait")).toThrow("not stalled");
  await until(() => !!store.getTicket("p", t.id)?.stalled);
  board.stallAction("p", t.id, "restart");
  expect(() => board.stallAction("p", t.id, "restart")).toThrow("not stalled");
  await board.whenIdle();
  expect(runs()).toBe(2);
}, 15000);

test("a stalled flag left by a daemon shutdown is cleared when the run starts again", async () => {
  await setup({ stallMs: 1000 });
  process.env.FAKE_MODE = "silent";
  process.env.FAKE_SILENT_MS = "4000";
  const t = await board.createTicket("p", { title: "Hang", body: "", status: "ready" });
  await until(() => !!store.getTicket("p", t.id)?.stalled);
  await board.shutdown();
  expect(store.getTicket("p", t.id)!.stalled).not.toBeNull();
  process.env.FAKE_SILENT_MS = "300";
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false, retryDelayMs: 50, stallMs: 60_000, notify: () => {} });
  board.recover();
  await until(() => board.isRunning("p", t.id));
  expect(store.getTicket("p", t.id)!.stalled).toBeNull();
  await board.whenIdle();
}, 20000);

test("Stop during the retry pause: no second run, outcome stopped", async () => {
  await setup({ retryDelayMs: 1500 });
  process.env.FAKE_MODE = "overloaded";
  process.env.FAKE_ONCE_FILE = join(tempDir("ck-once-"), "once");
  const t = await board.createTicket("p", { title: "Flaky", body: "", status: "ready" });
  await until(() => store.listComments("p", t.id).some((c) => c.text.includes("temporary API error")));
  expect(board.stop("p", t.id)).toBe(true);
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.outcome).toBe("stopped");
  expect(runs()).toBe(1);
}, 15000);
