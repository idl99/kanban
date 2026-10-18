import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus, type BusEvent } from "../src/server/events";
import { SessionCache, findSessionFile, parseNewTickets, parseProposal, parseSession, pollSessions } from "../src/server/session";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

const L = (o: unknown) => JSON.stringify(o);
const user = (text: any, at: string, extra: object = {}) =>
  L({ type: "user", uuid: `u${at}`, timestamp: at, message: { role: "user", content: text }, ...extra });
const asst = (content: any[], at: string, extra: object = {}) =>
  L({ type: "assistant", uuid: `a${at}`, timestamp: at, message: { role: "assistant", content }, ...extra });

const RAW = [
  L({ type: "custom-title", customTitle: "flight proposal." }),
  user("<command-name>/clear</command-name>", "2026-09-29T01:00:00Z"),
  user("Draft the flight proposal", "2026-09-29T01:00:01Z"),
  asst([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "On it." }], "2026-09-29T01:00:02Z"),
  asst([{ type: "tool_use", id: "t1", name: "Artifact", input: { action: "publish", file_path: "/x/flight-autopilot.html" } }], "2026-09-29T01:00:03Z"),
  user([{ type: "tool_result", tool_use_id: "t1", content: "Published /x/flight-autopilot.html at https://claude.ai/artifact/EHESGk3 (Version 1)" }], "2026-09-29T01:00:04Z"),
  user([{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "Published /x/flight-autopilot.html at https://claude.ai/artifact/EHESGk3 (Version 2)" }] }], "2026-09-29T01:00:05Z"),
  asst([{ type: "tool_use", id: "t3", name: "Bash", input: { command: "ls -la" } }], "2026-09-29T01:00:06Z"),
  asst([{ type: "text", text: "sidechain noise" }], "2026-09-29T01:00:07Z", { isSidechain: true }),
  user("looks good, ship it", "2026-09-29T01:00:08Z"),
  "garbage line",
].join("\n");

test("parseSession: timeline, artifacts deduped, last message", () => {
  const s = parseSession(RAW);
  expect(s.title).toBe("flight proposal.");
  expect(s.entries.map((e) => [e.role, e.kind, e.text])).toEqual([
    ["user", "text", "Draft the flight proposal"],
    ["assistant", "text", "On it."],
    ["assistant", "tool", "Artifact: /x/flight-autopilot.html"],
    ["assistant", "tool", "Bash: ls -la"],
    ["user", "text", "looks good, ship it"],
  ]);
  expect(s.artifacts).toEqual([
    { url: "https://claude.ai/artifact/EHESGk3", label: "flight-autopilot", at: "2026-09-29T01:00:04Z" },
  ]);
  expect(s.lastMessage).toEqual({ role: "user", text: "looks good, ship it", at: "2026-09-29T01:00:08Z" });
});

test("parseSession lists pages published by the artifact helper, not other Bash output", () => {
  const out = "Published /o/claude-surfaces.html at https://claude.ai/artifact/NJd6w5oY7";
  const raw = [
    asst([{ type: "tool_use", id: "b1", name: "Bash", input: { command: "'/bun' '/src/cli.ts' artifact publish /o/claude-surfaces.html --url x" } }], "2026-09-29T01:00:01Z"),
    user([{ type: "tool_result", tool_use_id: "b1", content: out }], "2026-09-29T01:00:02Z"),
    asst([{ type: "tool_use", id: "b2", name: "Bash", input: { command: "grep -r Published ~/.claude/projects" } }], "2026-09-29T01:00:03Z"),
    user([{ type: "tool_result", tool_use_id: "b2", content: "Published /y/other.html at https://claude.ai/artifact/Other1" }], "2026-09-29T01:00:04Z"),
  ].join("\n");
  expect(parseSession(raw).artifacts).toEqual([
    { url: "https://claude.ai/artifact/NJd6w5oY7", label: "claude-surfaces", at: "2026-09-29T01:00:02Z" },
  ]);
});

test("parseSession falls back to ai-title and handles empty", () => {
  expect(parseSession(L({ type: "ai-title", aiTitle: "Auto name" })).title).toBe("Auto name");
  const empty = parseSession("");
  expect(empty.entries).toEqual([]);
  expect(empty.lastMessage).toBeNull();
});

test("findSessionFile + cache reparses only on change", () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-some-folder");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
  writeFileSync(file, user("hi", "2026-09-29T01:00:00Z") + "\n");
  expect(findSessionFile("11111111-2222-3333-4444-555555555555", { configDir })).toBe(file);
  expect(findSessionFile("nope", { configDir })).toBeNull();
  const cache = new SessionCache({ configDir });
  const a = cache.get("11111111-2222-3333-4444-555555555555")!;
  expect(cache.get("11111111-2222-3333-4444-555555555555")).toBe(a);
  appendFileSync(file, asst([{ type: "text", text: "hello" }], "2026-09-29T01:00:01Z") + "\n");
  expect(cache.get("11111111-2222-3333-4444-555555555555")!.lastMessage!.text).toBe("hello");
});

test("pollSessions emits session.updated when a linked session file changes", () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-f");
  mkdirSync(dir, { recursive: true });
  const sid = "11111111-2222-3333-4444-555555555555";
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, user("first", "2026-09-29T01:00:00Z") + "\n");
  const store = new Store(tempDir());
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  const t = store.createTicket("p", { title: "x", body: "", status: "review" });
  store.updateTicket("p", t.id, { sessionId: sid });
  const bus = new Bus();
  const seen: BusEvent[] = [];
  bus.on((e) => seen.push(e));
  const cache = new SessionCache({ configDir });
  const state = new Map<string, string>();
  pollSessions(store, bus, cache, state);
  expect(seen.length).toBe(1);
  pollSessions(store, bus, cache, state);
  expect(seen.length).toBe(1);
  appendFileSync(file, asst([{ type: "text", text: "reply" }], "2026-09-29T01:00:01Z") + "\n");
  pollSessions(store, bus, cache, state);
  expect(seen.length).toBe(2);
  const e = seen[1] as any;
  expect(e).toMatchObject({ type: "session.updated", profile: "p", id: t.id });
  expect(e.session.lastMessage.text).toBe("reply");
});

test("parseSession hides board instructions and extracts questions + proposals", () => {
  const raw = [
    user('<ckanban-context note="Board started work on the ticket">\nYou are an agent...\n</ckanban-context>', "2026-09-29T02:00:00Z"),
    user('I want to build a habit tracker\n\n<ckanban-context>\nrefine rules\n</ckanban-context>', "2026-09-29T02:00:01Z"),
    asst([{ type: "text", text: 'A few questions:\n<ckanban-questions>\n[{"question":"Who uses it?","options":[{"label":"Just me"},{"label":"Friends","description":"shared","recommended":true}],"multiSelect":false}]\n</ckanban-questions>' }], "2026-09-29T02:00:02Z"),
    user("My answers:\n- Who uses it? → Friends", "2026-09-29T02:00:03Z"),
    asst([{ type: "text", text: 'Here is the ticket:\n<ckanban-ticket>{"title":"Habit tracker MVP","description":"## Goal\\nTrack habits"}</ckanban-ticket>' }], "2026-09-29T02:00:04Z"),
    asst([{ type: "text", text: "<ckanban-questions>not json</ckanban-questions>" }], "2026-09-29T02:00:05Z"),
  ].join("\n");
  const s = parseSession(raw);
  expect(s.entries.map((e) => [e.role, e.kind, e.text])).toEqual([
    ["user", "board", "Board started work on the ticket"],
    ["user", "text", "I want to build a habit tracker"],
    ["assistant", "text", "A few questions:"],
    ["user", "text", "My answers:\n- Who uses it? → Friends"],
    ["assistant", "text", "Here is the ticket:"],
    ["assistant", "text", "<ckanban-questions>not json</ckanban-questions>"],
  ]);
  expect(s.entries[2].questions).toEqual([
    { question: "Who uses it?", multiSelect: false, options: [
      { label: "Just me", description: undefined, recommended: false },
      { label: "Friends", description: "shared", recommended: true },
    ] },
  ]);
  expect(s.entries[4].proposal).toEqual({ title: "Habit tracker MVP", description: "## Goal\nTrack habits" });
  expect(s.lastMessage!.text).toBe("<ckanban-questions>not json</ckanban-questions>");
});

test("parseSession shows messages sent mid-turn (queued_command attachments) as user messages", () => {
  const queued = (prompt: unknown, at: string, commandMode = "prompt") =>
    L({ type: "attachment", uuid: `q${at}`, timestamp: at, attachment: { type: "queued_command", prompt, commandMode } });
  const raw = [
    user("Build it", "2026-10-01T02:00:00Z"),
    asst([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 5" } }], "2026-10-01T02:00:01Z"),
    queued([{ type: "text", text: "Is it cron?\n\n<ckanban-context note=\"\">\n(Sent while you were working.)\n</ckanban-context>" }], "2026-10-01T02:00:02Z"),
    queued("<task-notification>\n<task-id>x</task-id>\n</task-notification>", "2026-10-01T02:00:03Z", "task-notification"),
    asst([{ type: "text", text: "Done. Your question: it is the daemon's own timer." }], "2026-10-01T02:00:04Z"),
  ].join("\n");
  expect(parseSession(raw).entries.map((e) => [e.role, e.kind, e.text])).toEqual([
    ["user", "text", "Build it"],
    ["assistant", "tool", "Bash: sleep 5"],
    ["user", "text", "Is it cron?"],
    ["assistant", "text", "Done. Your question: it is the daemon's own timer."],
  ]);
});

test("parseSession: open questions and pending proposal reset after the user replies", () => {
  const q = '<ckanban-questions>[{"question":"A?","options":[{"label":"x"}]},{"question":"B?","options":[{"label":"y"}]}]</ckanban-questions>';
  const p = '<ckanban-ticket>{"title":"T2","description":"D2"}</ckanban-ticket>';
  const asked = parseSession([asst([{ type: "text", text: q }], "1")].join("\n"));
  expect(asked.openQuestions).toBe(2);
  const answered = parseSession([asst([{ type: "text", text: q }], "1"), user("answers", "2")].join("\n"));
  expect(answered.openQuestions).toBe(0);
  const proposed = parseSession([user("answers", "2"), asst([{ type: "text", text: p }], "3")].join("\n"));
  expect(proposed.pendingProposal).toEqual({ title: "T2", description: "D2" });
  const after = parseSession([asst([{ type: "text", text: p }], "3"), user("ok", "4")].join("\n"));
  expect(after.pendingProposal).toBeNull();
});

test("artifacts only come from the Artifact tool, not from text quoted in other tool output", () => {
  const raw = [
    asst([{ type: "tool_use", id: "b1", name: "Bash", input: { command: "grep Published other.jsonl" } }], "2026-09-29T03:00:00Z"),
    user([{ type: "tool_result", tool_use_id: "b1", content: "Published /x/flight-autopilot.html at https://claude.ai/artifact/EHESGk3 (Version 1)" }], "2026-09-29T03:00:01Z"),
    asst([{ type: "tool_use", id: "a1", name: "Artifact", input: { file_path: "/y/board.html" } }], "2026-09-29T03:00:02Z"),
    user([{ type: "tool_result", tool_use_id: "a1", content: "Published /y/board.html at https://claude.ai/artifact/Mine123 (Version 1)" }], "2026-09-29T03:00:03Z"),
  ].join("\n");
  expect(parseSession(raw).artifacts.map((a) => a.label)).toEqual(["board"]);
});

test("move marker is hidden from text and exposed as moved", () => {
  const s = parseSession(asst([{ type: "text", text: 'Top 5:\n1. a\n<ckanban-move to="planning"/>' }], "2026-09-29T04:00:00Z"));
  expect(s.entries[0].text).toBe("Top 5:\n1. a");
  expect(s.entries[0].moved).toBe("planning");
});

test("move marker on a blocked reply shows no move: the board kept the card", () => {
  const tag = '<ckanban-move to="planning"/>';
  const result = (status: string) => `CKANBAN_RESULT: {"status":"${status}","prUrl":null,"summary":"x"}`;
  const blocked = parseSession(asst([{ type: "text", text: `Fixes A-H.\n${tag}\n${result("blocked")}` }], "2026-09-29T04:00:00Z"));
  expect(blocked.entries[0].moved).toBeUndefined();
  expect(blocked.entries[0].text).not.toContain("ckanban-move");
  const done = parseSession(asst([{ type: "text", text: `Fixes A-H.\n${tag}\n${result("done")}` }], "2026-09-29T04:00:00Z"));
  expect(done.entries[0].moved).toBe("planning");
  // The result line in a later block of the same reply still counts; the next user message ends the reply.
  const split = parseSession([
    asst([{ type: "text", text: `Fixes A-H.\n${tag}` }], "2026-09-29T04:00:00Z"),
    asst([{ type: "text", text: result("blocked") }], "2026-09-29T04:00:01Z"),
    user("Ideas?", "2026-09-29T04:01:00Z"),
    asst([{ type: "text", text: `Some ideas.\n${tag}` }], "2026-09-29T04:01:01Z"),
  ].join("\n"));
  expect(split.entries.map((e) => e.moved)).toEqual([undefined, undefined, undefined, "planning"]);
});

test("stay marker is hidden from text", () => {
  const s = parseSession(asst([{ type: "text", text: "Proposed 1 ticket.\n<ckanban-stay/>" }], "2026-09-29T04:00:00Z"));
  expect(s.entries[0].text).toBe("Proposed 1 ticket.");
});

test("parseSession: <ckanban-tickets> becomes newTickets, stripped from the text", () => {
  const block = '<ckanban-tickets>[{"title":"A","description":"## Goal\\nDo A"},{"title":"B"},{"description":"no title"}]</ckanban-tickets>';
  const s = parseSession(asst([{ type: "text", text: `Here is the split.\n\n${block}\n\nApply what you like.` }], "1"));
  const e = s.entries[0];
  expect(e.text).toBe("Here is the split.\n\n\n\nApply what you like.");
  expect(e.newTickets).toEqual([{ title: "A", description: "## Goal\nDo A" }, { title: "B", description: "" }]);
  expect(e.proposal).toBeUndefined();
  expect(s.pendingNewTickets).toHaveLength(2);
  expect(parseSession([asst([{ type: "text", text: block }], "1"), user("thanks", "2")].join("\n")).pendingNewTickets).toEqual([]);
  // Only the block: the board still has something to show as the last message.
  expect(parseSession(asst([{ type: "text", text: block }], "1")).lastMessage!.text).toBe("Proposed 2 new tickets");
});

test("parseSession: invalid <ckanban-tickets> JSON stays visible text", () => {
  const bad = "<ckanban-tickets>[{title: A}]</ckanban-tickets>";
  const e = parseSession(asst([{ type: "text", text: `x ${bad}` }], "1")).entries[0];
  expect(e.newTickets).toBeUndefined();
  expect(e.text).toContain(bad);
});

test("parseSession: ticket proposal and new tickets in one reply", () => {
  const text = '<ckanban-ticket>{"title":"Planner","description":"D"}</ckanban-ticket>\n<ckanban-tickets>[{"title":"Child","description":"C"}]</ckanban-tickets>';
  const e = parseSession(asst([{ type: "text", text }], "1")).entries[0];
  expect(e.proposal).toEqual({ title: "Planner", description: "D" });
  expect(e.newTickets).toEqual([{ title: "Child", description: "C" }]);
  expect(e.text).toBe("");
});

test("parseSession: proposed tickets keep key and dependsOn", () => {
  const block = '<ckanban-tickets>[{"key":"api","title":"API","description":"d"},{"key":"ui","title":"UI","dependsOn":["api", 3, ""]}]</ckanban-tickets>';
  expect(parseSession(asst([{ type: "text", text: block }], "1")).entries[0].newTickets).toEqual([
    { key: "api", title: "API", description: "d" },
    { key: "ui", title: "UI", description: "", dependsOn: ["api"] },
  ]);
});

test("parseSession: chat blocks survive wrong, missing or quoted closing tags", () => {
  const entry = (text: string) => parseSession(asst([{ type: "text", text }], "1")).entries[0];
  const json = '{"title":"T","description":"D"}';
  for (const text of [
    `Here:\n<ckanban-ticket>${json}</ckanban-ticket>`,
    `Here:\n<ckanban-ticket>${json}</parameter>`,
    `Here:\n<ckanban-ticket>${json}`,
    "Here:\n<ckanban-ticket>\n```json\n" + json + "\n```\n</ckanban-ticket>",
  ]) {
    const e = entry(text);
    expect(e.proposal).toEqual({ title: "T", description: "D" });
    expect(e.text).toBe("Here:");
    expect(e.unreadable).toBeUndefined();
  }
  expect(entry(`<ckanban-ticket>${json}</ckanban-ticket>\n\nApply it, then move it to Ready.`).text).toBe("Apply it, then move it to Ready.");
  // A closing tag and braces quoted inside the description don't end the block early.
  const quoted = '{"title":"Parser","description":"Stop at </ckanban-ticket> {not here} or \\"]\\" either"}';
  const q = entry(`<ckanban-ticket>${quoted}</ckanban-ticket> after`);
  expect(q.proposal).toEqual({ title: "Parser", description: 'Stop at </ckanban-ticket> {not here} or "]" either' });
  expect(q.text).toBe("after");
  // ckanban-ticket never grabs a ckanban-tickets block.
  const t = entry('<ckanban-tickets>[{"title":"A"}]</parameter>');
  expect(t.newTickets).toEqual([{ title: "A", description: "" }]);
  expect(t.proposal).toBeUndefined();
});

test("parseSession: unreadable chat blocks stay visible and are flagged", () => {
  const entry = (text: string) => parseSession(asst([{ type: "text", text }], "1")).entries[0];
  const bad = entry('<ckanban-ticket>{"title": "T", oops}</ckanban-ticket>');
  expect(bad.proposal).toBeUndefined();
  expect(bad.unreadable).toBe("proposal");
  expect(bad.text).toContain("oops");
  const cut = entry('<ckanban-questions>[{"question":"A?"');
  expect(cut.unreadable).toBe("questions");
  expect(entry("<ckanban-tickets>[{title: A}]</ckanban-tickets>").unreadable).toBe("tickets");
  expect(entry("plain reply").unreadable).toBeUndefined();
});

test("parseSession: prose mentioning the opening tag before the real block still parses", () => {
  const entry = (text: string) => parseSession(asst([{ type: "text", text }], "1")).entries[0];
  const e = entry('I will send a <ckanban-ticket> block now, and `<ckanban-ticket>{oops}` was a typo.\n<ckanban-ticket>{"title":"T","description":"D"}</ckanban-ticket>');
  expect(e.proposal).toEqual({ title: "T", description: "D" });
  expect(e.unreadable).toBeUndefined();
  expect(e.text).toContain("I will send a <ckanban-ticket> block now");
  expect(e.text).not.toContain('"title":"T"');
  // Only broken occurrences: still flagged.
  const bad = entry('See <ckanban-questions> below.\n<ckanban-questions>[{"question": oops}]</ckanban-questions>');
  expect(bad.questions).toBeUndefined();
  expect(bad.unreadable).toBe("questions");
});

test("parseSession: planning tool calls become forms and cards keyed by the tool_use id", () => {
  const questions = [{ question: "Color?", options: [{ label: "Red", recommended: true }, { label: "Blue", mockup: "a-blue.html" }], multiSelect: false }];
  const raw = [
    user("plan it", "2026-10-04T01:00:00Z"),
    asst([
      { type: "text", text: "A few questions:" },
      { type: "tool_use", id: "toolu_bad", name: "mcp__ckanban__ask_questions", input: { questions: [{ ...questions[0], options: [{ label: "Red", recommended: true }, { label: "Blue", recommended: true }] }] } },
    ], "2026-10-04T01:00:01Z"),
    user([{ type: "tool_result", tool_use_id: "toolu_bad", is_error: true, content: [{ type: "text", text: "question 1: mark exactly one option recommended (found 2)" }] }], "2026-10-04T01:00:02Z"),
    asst([{ type: "tool_use", id: "toolu_q", name: "mcp__ckanban__ask_questions", input: { questions } }], "2026-10-04T01:00:03Z"),
    user([{ type: "tool_result", tool_use_id: "toolu_q", content: [{ type: "text", text: "Shown to the user as a form." }] }], "2026-10-04T01:00:04Z"),
  ].join("\n");
  const s = parseSession(raw);
  // The errored call doesn't render; no tool label line for the card calls.
  expect(s.entries.map((e) => [e.uuid, e.kind])).toEqual([["u2026-10-04T01:00:00Z", "text"], ["a2026-10-04T01:00:01Z", "text"], ["toolu_q", "text"]]);
  const q = s.entries[2];
  expect(q.role).toBe("assistant");
  expect(q.text).toBe("");
  expect(q.questions).toEqual([{ question: "Color?", multiSelect: false, options: [
    { label: "Red", description: undefined, recommended: true }, { label: "Blue", description: undefined, recommended: false, mockup: "a-blue.html" },
  ] }]);
  expect(s.openQuestions).toBe(1);
  expect(s.lastMessage?.text).toBe("Asked 1 question");

  const more = parseSession([
    raw,
    user("Red", "2026-10-04T01:00:05Z"),
    asst([
      { type: "tool_use", id: "toolu_p", name: "mcp__ckanban__propose_ticket", input: { title: " Fix chat ", description: "## Goal" } },
      { type: "tool_use", id: "toolu_t", name: "propose_tickets", input: { tickets: [{ key: "api", title: "API", description: "A" }, { key: "ui", title: "UI", description: "B", dependsOn: ["api"] }] } },
    ], "2026-10-04T01:00:06Z"),
  ].join("\n"));
  const p = more.entries.find((e) => e.uuid === "toolu_p")!;
  expect(p.proposal).toEqual({ title: "Fix chat", description: "## Goal" });
  const t = more.entries.find((e) => e.uuid === "toolu_t")!;
  expect(t.newTickets).toEqual([{ key: "api", title: "API", description: "A" }, { key: "ui", title: "UI", description: "B", dependsOn: ["api"] }]);
  expect(more.entries.some((e) => e.kind === "tool")).toBe(false);
  expect(more.pendingProposal).toEqual({ title: "Fix chat", description: "## Goal" });
  expect(more.pendingNewTickets).toHaveLength(2);
  expect(more.openQuestions).toBe(0);
});

test("parseSession: propose_branch shows a Branch card", () => {
  const s = parseSession(asst([{ type: "tool_use", id: "toolu_b", name: "mcp__ckanban__propose_branch", input: { reason: " Try SQLite " } }], "2026-10-06T01:00:00Z"));
  expect(s.entries).toEqual([{ uuid: "toolu_b", at: "2026-10-06T01:00:00Z", role: "assistant", kind: "text", text: "", branch: { reason: "Try SQLite" } }]);
  expect(s.lastMessage?.text).toBe("Offered to branch this ticket");
  expect(parseSession(asst([{ type: "tool_use", id: "b2", name: "propose_branch", input: {} }], "1")).entries[0].branch).toEqual({ reason: "" });
});

test("parseSession: propose_delete shows a delete card; a refused call shows none", () => {
  const s = parseSession(asst([{ type: "tool_use", id: "toolu_d", name: "mcp__ckanban__propose_delete", input: { ids: [" t_1 ", "t_2", "t_1", 3], reason: " replaced " } }], "2026-10-10T01:00:00Z"));
  expect(s.entries).toEqual([{ uuid: "toolu_d", at: "2026-10-10T01:00:00Z", role: "assistant", kind: "text", text: "", deletion: { ids: ["t_1", "t_2"], reason: "replaced" } }]);
  expect(s.lastMessage?.text).toBe("Asked to delete 2 tickets");
  const refused = parseSession([
    asst([{ type: "tool_use", id: "toolu_own", name: "mcp__ckanban__propose_delete", input: { ids: ["t_9"], reason: "x" } }], "2026-10-10T01:00:00Z"),
    user([{ type: "tool_result", tool_use_id: "toolu_own", is_error: true, content: [{ type: "text", text: "t_9 is this chat's own ticket" }] }], "2026-10-10T01:00:01Z"),
  ].join("\n"));
  expect(refused.entries.some((e) => e.deletion)).toBe(false);
  expect(parseSession(asst([{ type: "tool_use", id: "x", name: "propose_delete", input: { ids: [] } }], "1")).entries[0].kind).toBe("tool");
});

test("parseSession: propose_teammate shows a teammate card; refused or broken calls show none; pending until the user's next message", () => {
  const input = { name: "WA Watcher", role: " WhatsApp responder ", prompt: " Draft replies. ", model: "", mode: "tagged", workspace: "shared", canEdit: false, why: " No teammate watches a web inbox. " };
  const s = parseSession(asst([{ type: "tool_use", id: "toolu_t", name: "mcp__ckanban__propose_teammate", input }], "2026-10-10T01:00:00Z"));
  expect(s.entries).toEqual([{
    uuid: "toolu_t", at: "2026-10-10T01:00:00Z", role: "assistant", kind: "text", text: "",
    teammate: { name: "wa-watcher", role: "WhatsApp responder", prompt: "Draft replies.", model: null, mode: "tagged", workspace: "shared", canEdit: false, why: "No teammate watches a web inbox." },
  }]);
  expect(s.lastMessage?.text).toBe("Proposed teammate @wa-watcher");
  expect(s.pendingTeammates).toEqual(["toolu_t"]);
  // Fields Claude left out stay out (an existing teammate keeps its values for them).
  expect(parseSession(asst([{ type: "tool_use", id: "t2", name: "propose_teammate", input: { name: "qa", prompt: "p", why: "w" } }], "1")).entries[0].teammate).toEqual({ name: "qa", prompt: "p", why: "w" });
  const refused = parseSession([
    asst([{ type: "tool_use", id: "toolu_bad", name: "mcp__ckanban__propose_teammate", input }], "2026-10-10T01:00:00Z"),
    user([{ type: "tool_result", tool_use_id: "toolu_bad", is_error: true, content: [{ type: "text", text: "nope" }] }], "2026-10-10T01:00:01Z"),
  ].join("\n"));
  expect(refused.entries.some((e) => e.teammate)).toBe(false);
  for (const bad of [{ name: "x", prompt: "p" }, { name: "you", prompt: "p", why: "w" }, { name: "x", prompt: "p", why: "w", mode: "loud" }]) {
    expect(parseSession(asst([{ type: "tool_use", id: "x", name: "propose_teammate", input: bad }], "1")).entries[0].kind).toBe("tool");
  }
  const answered = parseSession([
    asst([{ type: "tool_use", id: "toolu_t", name: "mcp__ckanban__propose_teammate", input }], "2026-10-10T01:00:00Z"),
    user("thanks", "2026-10-10T01:00:01Z"),
  ].join("\n"));
  expect(answered.pendingTeammates).toEqual([]);
});

test("parseSession: an unreadable planning tool call falls back to a tool line", () => {
  const s = parseSession(asst([{ type: "tool_use", id: "x", name: "mcp__ckanban__propose_tickets", input: { tickets: "nope" } }], "1"));
  expect(s.entries[0].kind).toBe("tool");
});

test("parseSession lists pages published by the publish_artifact MCP tool", () => {
  const raw = [
    asst([{ type: "tool_use", id: "m1", name: "mcp__ckanban__publish_artifact", input: { html: "<p>x</p>" } }], "2026-10-06T01:00:01Z"),
    user([{ type: "tool_result", tool_use_id: "m1", content: [{ type: "text", text: "Published /o/artifacts/plan.html at https://claude.ai/artifact/Plan123" }] }], "2026-10-06T01:00:02Z"),
  ].join("\n");
  expect(parseSession(raw).artifacts).toEqual([{ url: "https://claude.ai/artifact/Plan123", label: "plan", at: "2026-10-06T01:00:02Z" }]);
});

test("parseSession: huddle digests are huddle entries, not the user's; Claude's reply to them doesn't need the user", () => {
  const digest = "[#1] (system) Huddle started\n\n[#2] @qa-1: @main look";
  const raw = [
    user("hi", "2026-10-10T01:00:00Z"),
    asst([{ type: "text", text: "Hello" }], "2026-10-10T01:00:01Z"),
    user(`${digest}\n\n<ckanban-context note="Huddle messages" huddle="h_abc">\nrules\n</ckanban-context>`, "2026-10-10T01:00:02Z"),
  ].join("\n");
  const s = parseSession(raw);
  const e = s.entries.at(-1)!;
  expect(e).toMatchObject({ role: "user", kind: "text", text: digest, huddleId: "h_abc", peer: { dir: "in", ticketId: null } });
  expect(s.lastMessage).toMatchObject({ role: "user", from: "huddle" });
  const replied = parseSession(`${raw}\n${asst([{ type: "text", text: "Posted in the huddle." }], "2026-10-10T01:00:03Z")}`);
  expect(replied.lastMessage).toMatchObject({ role: "assistant", peerReply: true });
  expect(parseSession(RAW).lastMessage?.from).toBeUndefined();
});

test("parseSession: a propose_huddle card with a template and no roster", () => {
  const raw = [
    asst([{ type: "tool_use", id: "h1", name: "mcp__ckanban__propose_huddle", input: { template: "design-review", reason: "Review the feature" } }], "2026-10-10T01:00:00Z"),
    asst([{ type: "tool_use", id: "h2", name: "mcp__ckanban__propose_huddle", input: { template: "design-review", roster: [{ preset: "qa" }] } }], "2026-10-10T01:00:01Z"),
    asst([{ type: "tool_use", id: "h3", name: "mcp__ckanban__propose_huddle", input: { reason: "no roster, no template" } }], "2026-10-10T01:00:02Z"),
  ].join("\n");
  const cards = parseSession(raw).entries.filter((e: any) => e.huddle).map((e: any) => e.huddle);
  expect(cards).toEqual([
    { roster: [], reason: "Review the feature", template: "design-review" },
    { roster: [{ preset: "qa" }], reason: "", template: "design-review" },
  ]);
});

test("proposed tickets: important, or a ⭐ before the title, marks them Important and the star leaves the title", () => {
  expect(parseNewTickets([{ key: "a", title: "⭐ Apply to OpenAI", description: "x" }, { key: "b", title: "Plain", description: "y", important: true }, { key: "c", title: "Other", description: "z" }]))
    .toEqual([
      { key: "a", title: "Apply to OpenAI", description: "x", important: true },
      { key: "b", title: "Plain", description: "y", important: true },
      { key: "c", title: "Other", description: "z" },
    ]);
  expect(parseProposal({ title: "⭐ Fix login", description: "d" })).toEqual({ title: "Fix login", description: "d", important: true });
  expect(parseProposal({ title: "Fix login", description: "d" })).toEqual({ title: "Fix login", description: "d" });
});
