import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { recapAvailable, recapPrompt, sinceLastMessage, transcript } from "../src/server/explain";
import { createServer } from "../src/server/http";
import { SessionCache, type SessionEntry } from "../src/server/session";
import { READ_TOOLS, sideCallArgs, type SideCallInput, type SideCallResult } from "../src/server/side-call";
import { SpendIndex } from "../src/server/spend";
import { Store } from "../src/server/store";
import type { Ticket } from "../src/server/types";
import { tempDir } from "./helpers";

const L = (o: unknown) => JSON.stringify(o);
const user = (uuid: string, at: string, text: string) => L({ type: "user", uuid, timestamp: at, message: { role: "user", content: text } });
const claude = (uuid: string, at: string, text: string) => L({ type: "assistant", uuid, timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } });
const AWAY = [
  user("u0", "2026-10-18T01:00:00Z", "Make the login page nicer."),
  claude("a0", "2026-10-18T01:00:05Z", "Which colour do you want?"),
  user("u1", "2026-10-18T01:01:00Z", "Add a forgot password link under the login button."),
  claude("a1", "2026-10-18T01:05:00Z", "Added the ForgotLink component under the button. A reviewer said it is hard to see in dark mode; fixed."),
].join("\n");
const QUIET = [claude("b0", "2026-10-18T01:00:00Z", "Hello."), user("b1", "2026-10-18T01:01:00Z", "Do the thing.")].join("\n");
const AWAY_SID = "11111111-2222-3333-4444-888888888888";
const QUIET_SID = "11111111-2222-3333-4444-999999999999";

let server: ReturnType<typeof createServer>;
let store: Store;
let base: string;
let repo: string;
let awayFile: string;
const calls: SideCallInput[] = [];
let next: SideCallResult = { ok: true, text: "**Nothing waits on you.** The link is on the login page.", costUsd: 0.031, model: "claude-sonnet-5-5" };

async function git(dir: string, ...args: string[]) {
  const p = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  return (await new Response(p.stdout).text()).trim();
}

beforeAll(async () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-proj");
  mkdirSync(dir, { recursive: true });
  awayFile = join(dir, `${AWAY_SID}.jsonl`);
  writeFileSync(awayFile, AWAY + "\n");
  writeFileSync(join(dir, `${QUIET_SID}.jsonl`), QUIET + "\n");
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  server = createServer({
    store, bus, board, port: 0, webDir: tempDir("ck-web-"), sessions: new SessionCache({ configDir }),
    sideCall: async (i) => {
      calls.push(i);
      return next;
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  repo = tempDir("ck-repo-");
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "t@t");
  await git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "login.html"), "<button>Log in</button>\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "init");
  store.saveProfile({ name: "P", slug: "p", path: repo, baseBranch: "main", maxParallel: 1, createdAt: "" });
});

afterAll(() => server.stop(true));

/** A ticket that ran in the board's folder itself, since its first commit. */
async function ticket(sessionId: string) {
  const t = store.createTicket("p", { title: "Login page: forgot password", body: "Add a link under the button.", status: "review" });
  store.updateTicket("p", t.id, { sessionId, baseSha: await git(repo, "rev-parse", "HEAD"), runCount: 1 });
  return t.id;
}

const help = async (id: string) => (await (await fetch(`${base}/api/profiles/p/tickets/${id}/help`)).json()) as any;
const ask = (id: string, kind: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/profiles/p/tickets/${id}/help`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ kind }) });

test("recap: offered after Claude's reply, a Sonnet side call from the user's last message on, saved as a card", async () => {
  const id = await ticket(AWAY_SID);
  calls.length = 0;
  const before = readFileSync(awayFile, "utf8");
  expect(await help(id)).toEqual({ cards: [], busy: [], recap: true, lessons: false });
  const r = await ask(id, "recap");
  expect(r.status).toBe(200);
  const card = await r.json();
  expect(card).toMatchObject({ kind: "recap", text: next.ok ? next.text : "", costUsd: 0.031 });
  expect(calls).toHaveLength(1);
  expect(calls[0].model).toBe("sonnet");
  expect(calls[0].system).toContain("under 100 words");
  // Since the user's last typed message: the earlier exchange stays out.
  expect(calls[0].prompt).toContain("Add a forgot password link");
  expect(calls[0].prompt).toContain("hard to see in dark mode");
  expect(calls[0].prompt).not.toContain("Which colour");
  // Read-only, in the ticket's folder.
  expect(calls[0].cwd).toBe(repo);
  expect(calls[0].tools).toEqual(READ_TOOLS);

  expect((await help(id)).cards).toEqual([card]);
  // The session gains no turn, the activity log stays empty, and the spend goes up.
  expect(readFileSync(awayFile, "utf8")).toBe(before);
  expect(existsSync(store.activityPath("p", id))).toBe(false);
  expect(new SpendIndex(store).ticket("p", id).costUsd).toBeCloseTo(0.031, 6);
});

test("recap: not offered while the user's message is the last thing in the chat", async () => {
  const id = await ticket(QUIET_SID);
  expect((await help(id)).recap).toBe(false);
  expect((await ask(id, "recap")).status).toBe(400);
});

test("changes: refused without changed files, explained with the diff once there are some", async () => {
  const id = await ticket(QUIET_SID);
  calls.length = 0;
  expect((await ask(id, "changes")).status).toBe(400);
  expect(calls).toHaveLength(0);

  writeFileSync(join(repo, "login.html"), "<button>Log in</button>\n<a href=\"/reset\">Forgot password?</a>\n");
  const r = await ask(id, "changes");
  expect(r.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0].system).toContain("Before and after");
  expect(calls[0].prompt).toContain("login.html");
  expect(calls[0].prompt).toContain("+<a href=\"/reset\">Forgot password?</a>");
  expect(calls[0].prompt).toContain("Add a link under the button.");
  expect(calls[0].cwd).toBe(repo);
});

test("help: bad kinds, board runs and failed calls", async () => {
  const id = await ticket(AWAY_SID);
  expect((await ask(id, "poem")).status).toBe(400);
  expect((await ask(id, "recap", { "x-ckanban-run": "1" })).status).toBe(403);
  const prev = next;
  next = { ok: false, error: "not logged in" };
  try {
    const r = await ask(id, "recap");
    expect(r.status).toBe(502);
    expect((await help(id)).cards).toEqual([]);
    expect(new SpendIndex(store).ticket("p", id).costUsd).toBe(0);
  } finally {
    next = prev;
  }
});

test("sinceLastMessage: board prompts and huddle messages are not the user's", () => {
  const e = (uuid: string, role: "user" | "assistant", kind: SessionEntry["kind"], extra: Partial<SessionEntry> = {}): SessionEntry =>
    ({ uuid, at: `2026-10-18T01:0${uuid}:00Z`, role, kind, text: `text ${uuid}`, ...extra });
  const entries = [
    e("1", "user", "text"), e("2", "assistant", "text"), e("3", "user", "board"),
    e("4", "user", "text", { peer: { dir: "in", ticketId: null } }), e("5", "assistant", "tool"), e("6", "assistant", "tool"),
  ];
  expect(sinceLastMessage(entries).last?.uuid).toBe("1");
  expect(recapAvailable(entries)).toBe(true);
  expect(recapAvailable(entries.slice(0, 1))).toBe(false);
  const text = transcript(sinceLastMessage(entries).after);
  expect(text).toContain("Board (automatic message): text 3");
  expect(text).toContain("Review team (huddle) message: text 4");
  expect(text).toContain("Claude used 2 tools");
  const t = { title: "T", status: "review", outcome: "done", prUrl: null, error: null } as unknown as Ticket;
  expect(recapPrompt({ ticket: t, entries, findings: [
    { id: "f1", text: "old finding", by: "qa", status: "resolved", resolvedBy: null, at: "2026-10-18T00:00:00Z" },
    { id: "f2", text: "new finding", by: "qa", status: "open", resolvedBy: null, at: "2026-10-18T02:00:00Z" },
  ] })).toMatch(/new finding[\s\S]*<transcript>/);
});

test("side call: a reading call gets only read tools, a turn cap and no hooks", () => {
  const args = sideCallArgs({ prompt: "p", system: "s", model: "sonnet", tools: ["Read", "Grep", "Glob", "Bash", "Edit"] });
  expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", "Read,Grep,Glob"]);
  expect(args).toContain("--max-turns");
  expect(args[args.indexOf("--settings") + 1]).toBe(L({ disableAllHooks: true }));
  expect(sideCallArgs({ prompt: "p", system: "s" })).not.toContain("--max-turns");
});
