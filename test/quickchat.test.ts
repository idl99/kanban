import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus, type BusEvent } from "../src/server/events";
import { createServer } from "../src/server/http";
import { autoTitle, CONTINUE_TEXT, QuickChats, quickChatNote } from "../src/server/quickchat";
import { SessionCache } from "../src/server/session";
import { SpendIndex } from "../src/server/spend";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";
import { FAKE } from "./board-env";
import { readJsonl, tempDir, until } from "./helpers";

let store: Store;
let bus: Bus;
let board: Board;
let chats: QuickChats;
let argsFile: string;
let profile: Profile;
let events: BusEvent[];

const args = () => readJsonl(argsFile) as { args: string[]; cwd: string; prompt: string }[];

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  events = [];
  bus.on((e) => events.push(e));
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  chats = new QuickChats(store, bus, board, { claudeBin: FAKE, mcp: () => "{}" });
  argsFile = join(tempDir("ck-args-"), "args.jsonl");
  process.env.FAKE_ARGS_FILE = argsFile;
  process.env.CLAUDE_CONFIG_DIR = tempDir("ck-claude-");
  process.env.FAKE_MODE = "ok";
  profile = { name: "My Board", slug: "p", path: tempDir("ck-plain-"), baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(profile);
});

afterEach(async () => {
  await chats.shutdown();
  await board.shutdown();
  for (const k of ["FAKE_MODE", "CLAUDE_CONFIG_DIR", "FAKE_ARGS_FILE", "FAKE_TOTAL_COST"]) delete process.env[k];
}, 10000);

test("autoTitle takes the first line of the first message, without images or markdown", () => {
  expect(autoTitle("![image](/api/attachments/a.png)\n## Why is Review always full?\nmore")).toBe("Why is Review always full?");
  expect(autoTitle("see [the doc](https://x.y) please")).toBe("see the doc please");
  expect(autoTitle("")).toBe("New chat");
  expect(autoTitle(null)).toBe("New chat");
  const long = autoTitle("a".repeat(200));
  expect(long.length).toBe(80);
  expect(long.endsWith("…")).toBe(true);
});

test("the note says which board and folder the chat is on and how to reach the board", () => {
  const note = quickChatNote(profile);
  expect(note).toContain(`"My Board" (slug: p)`);
  expect(note).toContain(profile.path);
  expect(note).toContain("create_ticket");
  expect(note).toContain("not a ticket");
});

test("a first message makes a chat that runs Claude in the board's folder, with full powers and the board note", async () => {
  const v = chats.send("p", null, "What is in this folder?");
  expect(v.title).toBe("What is in this folder?");
  expect(v.running).toBe(true);
  expect(board.restartState().waiting).toBe(1);
  await chats.idle();
  const [run] = args();
  expect(run.cwd).toBe(profile.path);
  expect(run.prompt).toBe("What is in this folder?");
  expect(run.args).toContain("--session-id");
  expect(run.args).toContain(v.sessionId);
  expect(run.args).toContain("bypassPermissions");
  expect(run.args).not.toContain("--disallowedTools");
  expect(run.args[run.args.indexOf("--append-system-prompt") + 1]).toBe(quickChatNote(profile));
  const c = chats.get("p", v.id)!;
  expect(c.started).toBe(true);
  expect(c.error).toBeNull();
  expect(chats.view("p", c).running).toBe(false);
  expect(board.restartState().waiting).toBe(0);
  // It takes no ticket run slot.
  expect(board.running("p")).toBe(0);
  expect(events.some((e) => e.type === "chat.draft" && e.id === v.id && e.text === "Work complete.")).toBe(false);
  expect(events.some((e) => e.type === "chat.updated" && e.id === v.id)).toBe(true);
});

test("the next message continues the same conversation, and the list shows the latest chat first", async () => {
  const a = chats.send("p", null, "first chat");
  await chats.idle();
  const b = chats.send("p", null, "second chat");
  await chats.idle();
  chats.send("p", a.id, "back to the first");
  await chats.idle();
  const runs = args();
  expect(runs).toHaveLength(3);
  expect(runs[2].args).toContain("--resume");
  expect(runs[2].args).toContain(a.sessionId);
  expect(runs[2].prompt).toBe("back to the first");
  expect(chats.list("p").map((c) => c.id)).toEqual([a.id, b.id]);
  // Chats are files: a new instance (a restarted daemon) lists the same ones.
  const again = new QuickChats(store, bus, board, { claudeBin: FAKE });
  expect(again.list("p").map((c) => c.id)).toEqual([a.id, b.id]);
  expect(again.view("p", again.get("p", a.id)!).title).toBe("first chat");
});

test("rename sets the title; an empty one goes back to the automatic title", async () => {
  const v = chats.send("p", null, "hello there");
  await chats.idle();
  expect(chats.rename("p", v.id, "  My   chat ").title).toBe("My chat");
  expect(chats.view("p", chats.get("p", v.id)!).renamed).toBe(true);
  const back = chats.rename("p", v.id, "");
  expect(back.title).toBe("hello there");
  expect(back.renamed).toBe(false);
});

test("delete removes the chat and its spend log", async () => {
  const v = chats.send("p", null, "temp");
  await chats.idle();
  await chats.remove("p", v.id);
  expect(chats.get("p", v.id)).toBeNull();
  expect(chats.list("p")).toEqual([]);
  expect(events.some((e) => e.type === "chat.updated" && e.id === v.id && e.chat === null)).toBe(true);
});

test("Make ticket creates a Backlog ticket on the same conversation, marks the chat and refuses more messages", async () => {
  const v = chats.send("p", null, "Plan a login page");
  await chats.idle();
  const { ticket, chat } = await chats.makeTicket("p", v.id);
  expect(ticket.status).toBe("backlog");
  expect(ticket.title).toBe("Plan a login page");
  expect(ticket.sessionId).toBe(v.sessionId);
  expect(ticket.workdir).toBe(profile.path);
  expect(ticket.body).toContain("> Plan a login page");
  expect(chat.ticketId).toBe(ticket.id);
  expect(chats.get("p", v.id)!.ticketId).toBe(ticket.id);
  expect(() => chats.send("p", v.id, "more")).toThrow(/became a ticket/);
  await expect(chats.makeTicket("p", v.id)).rejects.toThrow(/already a ticket/);
  // The ticket's chat continues the conversation.
  await board.chat("p", ticket.id, "carry on");
  await until(() => args().length === 2 && !board.isRunning("p", ticket.id));
  const last = args()[1];
  expect(last.args).toContain("--resume");
  expect(last.args).toContain(v.sessionId);
});

test("two Make ticket calls at once make one ticket, and no reply starts meanwhile", async () => {
  const v = chats.send("p", null, "Plan a page");
  await chats.idle();
  const both = await Promise.allSettled([chats.makeTicket("p", v.id), chats.makeTicket("p", v.id)]);
  expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(store.listTickets("p")).toHaveLength(1);
  expect(() => chats.send("p", v.id, "more")).toThrow(/ticket/);
  expect(chats.isRunning("p", v.id)).toBe(false);
});

test("Make ticket waits for a reply in progress and for the first message", async () => {
  process.env.FAKE_MODE = "slow";
  const v = chats.send("p", null, "long one");
  await until(() => args().length === 1);
  await expect(chats.makeTicket("p", v.id)).rejects.toThrow(/still replying/);
  chats.stop("p", v.id);
  await chats.idle();
  expect(chats.get("p", v.id)!.error).toBeNull();
});

test("a message sent while Claude replies reaches the same run", async () => {
  process.env.FAKE_STEP_MS = "150";
  try {
    const v = chats.send("p", null, "start");
    await until(() => args().length === 1);
    chats.send("p", v.id, "and also this");
    await chats.idle();
    expect(args()).toHaveLength(1);
    const results = readJsonl(chats.activityPath("p", v.id)).map((e) => e.event.result as string);
    expect(results.join("\n")).toContain("Steered: and also this");
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
});

test("chat spend counts in today's spend", async () => {
  process.env.FAKE_TOTAL_COST = "0.25";
  chats.send("p", null, "how much?");
  await chats.idle();
  const today = new SpendIndex(store).today();
  expect(today.costUsd).toBeCloseTo(0.25);
  expect(today.boards.find((b) => b.slug === "p")!.costUsd).toBeCloseTo(0.25);
});

test("a restart holds new messages and continues a reply it cut off", async () => {
  // Held while a restart is pending (a reply in progress keeps it waiting).
  process.env.FAKE_MODE = "partial";
  const v = chats.send("p", null, "write a lot");
  await until(() => events.some((e) => e.type === "chat.draft" && e.id === v.id && e.text === "Half a repl"));
  board.requestRestart(() => {}, 60_000);
  const w = chats.send("p", null, "while restarting");
  expect(w.running).toBe(false);
  expect(w.waiting).toBe(1);
  await chats.shutdown();
  expect(chats.get("p", v.id)!.interrupted).toEqual({});
  await board.shutdown();
  // The restarted daemon.
  process.env.FAKE_MODE = "ok";
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  chats = new QuickChats(store, bus, board, { claudeBin: FAKE, mcp: () => "{}" });
  chats.recover();
  await chats.idle();
  const prompts = args().slice(1).map((a) => a.prompt);
  expect(prompts).toContain(CONTINUE_TEXT);
  expect(prompts).toContain("while restarting");
  expect(chats.get("p", v.id)!.interrupted).toBeUndefined();
  expect(chats.get("p", w.id)!.pending).toBeUndefined();
});

test("HTTP: list, send, conversation, rename, make ticket and delete", async () => {
  const sessions = new SessionCache({ configDir: process.env.CLAUDE_CONFIG_DIR });
  const server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-"), sessions, quickChats: chats, isUserBrowser: async () => true });
  const base = `http://127.0.0.1:${server.port}/api/profiles/p/chats`;
  const call = async (method: string, path = "", body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", origin: `http://127.0.0.1:${server.port}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: r.status === 204 ? null : await r.json() as any };
  };
  try {
    expect((await call("GET")).body).toEqual([]);
    expect((await call("POST", "", { text: "  " })).status).toBe(400);
    expect((await call("POST", "", { text: "hi" }, { "x-ckanban-run": "p/t_1" })).status).toBe(403);
    // A program without the browser's Origin (a board run's curl) can't start one either.
    expect((await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) })).status).toBe(403);
    const made = await call("POST", "", { text: "What is here?" });
    expect(made.status).toBe(201);
    const id = made.body.id;
    await chats.idle();
    const conv = await call("GET", `/${id}/conversation`);
    expect(conv.body.entries.some((e: any) => e.role === "user" && e.text === "What is here?")).toBe(true);
    expect((await call("PATCH", `/${id}`, { title: "Renamed" })).body.title).toBe("Renamed");
    const list = await call("GET");
    expect(list.body.map((c: any) => c.id)).toEqual([id]);
    const t = await call("POST", `/${id}/ticket`);
    expect(t.status).toBe(201);
    expect(t.body.ticket.title).toBe("Renamed");
    expect(t.body.chat.ticketId).toBe(t.body.ticket.id);
    expect((await call("POST", `/${id}/messages`, { text: "more" })).status).toBe(409);
    expect((await call("DELETE", `/${id}`)).status).toBe(204);
    expect((await call("GET", `/${id}`)).status).toBe(404);
  } finally {
    server.stop(true);
  }
});
