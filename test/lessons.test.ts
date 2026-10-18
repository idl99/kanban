import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { addProjectRule, lessonBullets, lessonsBlock, parseLessons, withLesson } from "../src/server/lessons";
import { SessionCache } from "../src/server/session";
import type { SideCallInput, SideCallResult } from "../src/server/side-call";
import { SpendIndex } from "../src/server/spend";
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
let store: Store;
let base: string;
let folder: string;
const calls: SideCallInput[] = [];
const LESSONS = {
  lessons: [
    { mistake: "Claude put a new link above the button.", evidence: "links on forms always go under the main button", level: "rule", rule: "Put new links on forms under the main button.", title: "Links under buttons" },
    { mistake: "Each form places links its own way.", evidence: "always go under the main button", level: "structure", rule: "Make one shared form footer that holds links under the button.", title: "Shared form footer" },
    { mistake: "x", level: "poem", rule: "y" },
  ],
  note: "",
};
let next: SideCallResult = { ok: true, text: "```json\n" + L(LESSONS) + "\n```", costUsd: 0.02, model: "claude-sonnet-5-5" };

beforeAll(() => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-proj");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${CORRECTED_SID}.jsonl`), CORRECTED + "\n");
  writeFileSync(join(dir, `${CLEAN_SID}.jsonl`), CLEAN + "\n");
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

test("a corrected Done ticket: lessons quote the correction, a rule goes into CLAUDE.md, a code lesson becomes a linked ticket", async () => {
  const id = ticket(CORRECTED_SID);
  expect((await help(id)).lessons).toBe(true);
  calls.length = 0;
  const r = await post(id, "help", { kind: "lessons" });
  expect(r.status).toBe(200);
  const card = (await r.json()) as any;
  expect(calls).toHaveLength(1);
  expect(calls[0].model).toBe("sonnet");
  expect(calls[0].system).toContain("structure");
  expect(calls[0].prompt).toContain("links on forms always go under the main button");
  // Bad lessons are dropped; the good ones keep their level.
  expect(card.lessons.map((l: any) => l.level)).toEqual(["rule", "structure"]);
  expect(card.lessons[0].evidence).toContain("under the main button");
  expect(new SpendIndex(store).ticket("p", id).costUsd).toBeCloseTo(0.02, 6);

  // Add to project rules: a plain folder without CLAUDE.md gets one.
  const [rule, code] = card.lessons;
  const added = (await (await post(id, "lesson", { card: card.id, lesson: rule.id, action: "rule" })).json()) as any;
  expect(added.lessons[0].done.action).toBe("rule");
  expect(readFileSync(join(folder, "CLAUDE.md"), "utf8")).toBe("## Lessons\n\n- Put new links on forms under the main button.\n");
  // Once handled, it can't be done twice.
  expect((await post(id, "lesson", { card: card.id, lesson: rule.id, action: "rule" })).status).toBe(409);

  // Make it a ticket: a Backlog ticket that follows this one up, with the lesson as its description.
  const made = (await (await post(id, "lesson", { card: card.id, lesson: code.id, action: "ticket" })).json()) as any;
  const nt = store.getTicket("p", made.lessons[1].done.ticketId)!;
  expect(nt).toMatchObject({ status: "backlog", followUpOf: id, title: "Shared form footer" });
  expect(nt.body).toContain("shared form footer");
  expect(nt.body).toContain("always go under the main button");
  expect((await help(id)).cards[0].lessons[1].done.ticketId).toBe(nt.id);
});

test("next run prompt: a worktree without the rule is told about it", () => {
  const wt = tempDir("ck-wt-");
  expect(lessonsBlock(folder, wt)).toContain("Put new links on forms under the main button.");
  expect(lessonsBlock(folder, folder)).toBe("");
  writeFileSync(join(wt, "CLAUDE.md"), "# X\n\n## Lessons\n\n- put new links on forms under the main button.\n");
  expect(lessonsBlock(folder, wt)).toBe("");
});

test("no corrections, no item; the call is refused too", async () => {
  const id = ticket(CLEAN_SID);
  expect((await help(id)).lessons).toBe(false);
  calls.length = 0;
  expect((await post(id, "help", { kind: "lessons" })).status).toBe(400);
  expect(calls).toHaveLength(0);
  // A corrected ticket that is still being worked on doesn't offer it either.
  expect((await help(ticket(CORRECTED_SID, "in_progress"))).lessons).toBe(false);
  // A follow-up ticket counts as a correction.
  const f = store.createTicket("p", { title: "More", body: "", status: "backlog" });
  store.updateTicket("p", f.id, { followUpOf: id });
  expect((await help(id)).lessons).toBe(true);
});

test("nothing worth a rule, unreadable answers, bad actions and board runs", async () => {
  const id = ticket(CORRECTED_SID, "review");
  const prev = next;
  try {
    next = { ok: true, text: L({ lessons: [], note: "The change was a new wish, not a mistake." }), costUsd: 0.01, model: "m" };
    const card = (await (await post(id, "help", { kind: "lessons" })).json()) as any;
    expect(card.lessons).toEqual([]);
    expect(card.text).toBe("Nothing worth a rule. The change was a new wish, not a mistake.");
    next = { ok: true, text: "Sorry, I can't.", costUsd: 0.01, model: "m" };
    expect((await post(id, "help", { kind: "lessons" })).status).toBe(502);
  } finally {
    next = prev;
  }
  expect((await post(id, "lesson", { card: "x", lesson: "y", action: "rule" })).status).toBe(404);
  expect((await post(id, "lesson", { card: "x", lesson: "y", action: "delete" })).status).toBe(400);
  expect((await post(id, "lesson", { card: "x", lesson: "y", action: "rule" }, { "x-ckanban-run": "1" })).status).toBe(403);
  expect((await post(id, "help", { kind: "lessons" }, { "x-ckanban-run": "1" })).status).toBe(403);
});

test("withLesson: adds one bullet at the end of the Lessons section and keeps the rest", () => {
  const doc = "# Project\n\nIntro.\n\n## Lessons\n\n- One.\n\n## Other\n\nText.\n";
  expect(withLesson(doc, "Two.")).toBe("# Project\n\nIntro.\n\n## Lessons\n\n- One.\n- Two.\n\n## Other\n\nText.\n");
  expect(withLesson("# Project\n\nIntro.", "Two.")).toBe("# Project\n\nIntro.\n\n## Lessons\n\n- Two.\n");
  expect(withLesson("## Lessons\n", "Two.")).toBe("## Lessons\n\n- Two.\n");
  expect(withLesson("", "Two.")).toBe("## Lessons\n\n- Two.\n");
  expect(lessonBullets(withLesson(doc, "Two."))).toEqual(["One.", "Two."]);
  // ### headings stay inside the section.
  expect(withLesson("## Lessons\n\n### Old\n- A.\n", "B.")).toBe("## Lessons\n\n### Old\n- A.\n- B.\n");
});

test("addProjectRule: an existing rule is not added again", () => {
  const dir = tempDir("ck-rules-");
  writeFileSync(join(dir, "CLAUDE.md"), "# Rules\n\n## Lessons\n\n- Keep it short.\n");
  expect(addProjectRule(dir, "keep it short.").added).toBe(false);
  expect(addProjectRule(dir, "Say why.").added).toBe(true);
  expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("# Rules\n\n## Lessons\n\n- Keep it short.\n- Say why.\n");
  expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
});

test("parseLessons: at most three, needs a level, a mistake and a rule", () => {
  const ids = (() => { let n = 0; return () => `l${n++}`; })();
  const many = Array.from({ length: 5 }, (_, i) => ({ mistake: `m${i}`, evidence: "e", level: "check", rule: `r${i}`, title: "" }));
  const r = parseLessons(L({ lessons: many }), ids)!;
  expect(r.lessons).toHaveLength(3);
  expect(r.lessons[0].title).toBe("m0");
  expect(parseLessons("no json here", ids)).toBeNull();
  expect(parseLessons(L({ nope: 1 }), ids)).toBeNull();
});
