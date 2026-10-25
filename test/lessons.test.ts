import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Learner } from "../src/server/learner";
import { lessonBullets, lessonsBlock } from "../src/server/lessons";
import { SessionCache } from "../src/server/session";
import type { SideCallInput, SideCallResult } from "../src/server/side-call";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

const L = (o: unknown) => JSON.stringify(o);
const user = (uuid: string, at: string, text: string) => L({ type: "user", uuid, timestamp: at, message: { role: "user", content: text } });
const claude = (uuid: string, at: string, text: string) => L({ type: "assistant", uuid, timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } });
const RESULT = 'CKANBAN_RESULT: {"status":"done","prUrl":null,"summary":"Added the link."}';
const CORRECTED = [
  user("u0", "2026-10-18T01:00:00Z", "Add a forgot password link."),
  claude("a0", "2026-10-18T01:05:00Z", `Added the link above the button.\n${RESULT}`),
  user("u1", "2026-10-18T01:06:00Z", "No, links on forms always go under the main button."),
  claude("a1", "2026-10-18T01:08:00Z", `Moved it under the button.\n${RESULT}`),
].join("\n");
// Answers to Claude's questions before the run ended are not corrections.
const CLEAN = [
  user("c0", "2026-10-18T01:00:00Z", "Add a forgot password link."),
  claude("c1", "2026-10-18T01:01:00Z", "Above or under the button?"),
  user("c2", "2026-10-18T01:02:00Z", "Under."),
  claude("c3", "2026-10-18T01:05:00Z", `Done.\n${RESULT}`),
].join("\n");
const CORRECTED_SID = "11111111-2222-3333-4444-aaaaaaaaaaaa";
const CLEAN_SID = "11111111-2222-3333-4444-bbbbbbbbbbbb";

let server: ReturnType<typeof createServer>;
let learner: Learner;
let store: Store;
let base: string;
let folder: string;
const calls: SideCallInput[] = [];
let next: SideCallResult = { ok: true, text: L({ lessons: [{ mistake: "m", evidence: "links on forms always go under the main button", rule: "Put new links on forms under the main button.", match: "", standing: "links on forms always go under the main button" }] }), costUsd: 0.02, model: "claude-haiku-5-5" };

beforeAll(() => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-proj");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${CORRECTED_SID}.jsonl`), CORRECTED + "\n");
  writeFileSync(join(dir, `${CLEAN_SID}.jsonl`), CLEAN + "\n");
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  const sessions = new SessionCache({ configDir });
  const sideCall = async (i: SideCallInput) => {
    calls.push(i);
    return next;
  };
  learner = new Learner(store, bus, { sideCall, entries: (t) => (t.sessionId ? sessions.get(t.sessionId)?.entries : null) ?? [], isRunning: () => false });
  server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-"), sessions, sideCall, learner });
  base = `http://127.0.0.1:${server.port}`;
  // A plain folder: no version history.
  folder = tempDir("ck-plain-");
  store.saveProfile({ name: "P", slug: "p", path: folder, baseBranch: "main", maxParallel: 1, createdAt: "" });
});

afterAll(() => server.stop(true));

function ticket(sessionId: string, status: "review" | "done" | "in_progress" = "done") {
  const t = store.createTicket("p", { title: "Login page: forgot password", body: "Add a link.", status });
  store.updateTicket("p", t.id, { sessionId, runCount: 1 });
  return t.id;
}

const url = (id: string, what: string) => `${base}/api/profiles/p/tickets/${id}/${what}`;
const help = async (id: string) => (await (await fetch(url(id, "help"))).json()) as any;
const post = (id: string, what: string, b: unknown, headers: Record<string, string> = {}) =>
  fetch(url(id, what), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });

test("the help menu no longer offers lessons: the board learns on its own", async () => {
  const id = ticket(CORRECTED_SID);
  expect((await help(id)).lessons).toBeUndefined();
  calls.length = 0;
  expect((await post(id, "help", { kind: "lessons" })).status).toBe(400);
  expect((await post(id, "lesson", { card: "x", lesson: "y", action: "rule" })).status).toBe(404);
  expect(calls).toHaveLength(0);
});

test("a corrected ticket is read by the learner: the user's 'always' saves a board rule, never in the project folder", async () => {
  const id = ticket(CORRECTED_SID);
  const [c] = await learner.scanTicket("p", id);
  expect(calls.at(-1)!.prompt).toContain("links on forms always go under the main button");
  expect(c.state).toBe("saved");
  expect(readFileSync(store.boardRulesPath("p"), "utf8")).toContain("- Put new links on forms under the main button.");
  // The project's own folder is left alone.
  expect(existsSync(join(folder, "CLAUDE.md"))).toBe(false);
  // A ticket without corrections isn't read.
  calls.length = 0;
  expect(await learner.scanTicket("p", ticket(CLEAN_SID))).toEqual([]);
  expect(calls).toHaveLength(0);
});

test("Learned routes: anyone reads; only the user undoes, saves or drops; seen clears the count", async () => {
  const learned = (what = "", init?: RequestInit) => fetch(`${base}/api/profiles/p/learned${what}`, init);
  const view = (await (await learned()).json()) as any;
  expect(view.saved.length).toBeGreaterThan(0);
  expect(view.newCount).toBeGreaterThan(0);
  const change = view.saved[0];
  const postL = (what: string, headers: Record<string, string> = {}) => learned(what, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
  expect((await postL(`/changes/${change.id}/undo`, { "x-ckanban-run": "p/x" })).status).toBe(403);
  expect((await postL(`/changes/${change.id}/undo`)).status).toBe(200);
  // The rules file didn't exist before: undo takes it away again.
  expect(existsSync(store.boardRulesPath("p"))).toBe(false);
  expect((await postL(`/changes/${change.id}/undo`)).status).toBe(409);
  expect((await postL(`/changes/${change.id}/redo`)).status).toBe(200);
  expect((await postL("/changes/nope/undo")).status).toBe(404);
  expect((await postL("/lessons/nope/save")).status).toBe(404);
  expect(((await (await postL("/seen")).json()) as any).newCount).toBe(0);
});

test("next run prompt: a worktree without the project's CLAUDE.md lessons is told about them", () => {
  writeFileSync(join(folder, "CLAUDE.md"), "# Rules\n\n## Lessons\n\n- Put new links on forms under the main button.\n");
  const wt = tempDir("ck-wt-");
  expect(lessonsBlock(folder, wt)).toContain("Put new links on forms under the main button.");
  expect(lessonsBlock(folder, folder)).toBe("");
  writeFileSync(join(wt, "CLAUDE.md"), "# X\n\n## Lessons\n\n- put new links on forms under the main button.\n");
  expect(lessonsBlock(folder, wt)).toBe("");
});

test("lessonBullets: the bullets under ## Lessons, ### headings stay inside", () => {
  expect(lessonBullets("# P\n\n## Lessons\n\n- One.\n### Old\n- Two.\n\n## Other\n- Three.\n")).toEqual(["One.", "Two."]);
  expect(lessonBullets("# P\n")).toEqual([]);
});
