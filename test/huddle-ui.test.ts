import { expect, test } from "bun:test";
import { resetTitle, scopeChip, usageText } from "../web/src/teamText";
import {
  applyTemplate, brakeLabel, cardHuddleBadge, digestPreview, digestSenders, parseDigest, draftError, draftTags, idleFor, isForYou, untaggedHint, draftSize, guestTickets, handleInitials, mentionCandidates, mentionQuery, mergeMessages, participantActivity, pickHuddle, huddleRound, huddleTitle, ticketHuddles, rosterDraft, rowHandle, shortTicketId, sortHuddles, sourceLabel, upsertHuddle, withActivity, contextText, BIG_CONTEXT_TOKENS,
} from "../web/src/huddleText";
import { mergeSteps, modelLabel, sessionMeta, sessionState, shortSession, toolIcon } from "../web/src/sessionText";

type P = { handle: string; role: string; kind: string; mode: string; status: string; statusReason?: string | null; lastActivity?: string | null; error?: string | null };
type H = { id: string; hostTicket: string; status: string; createdAt: string; participants: P[] };

const p = (handle: string, x: Partial<P> = {}): P => ({ handle, role: handle, mode: "tagged", status: "idle", kind: "agent", ...x });
const huddle = (x: Partial<H> = {}): H => ({
  id: "h1", hostTicket: "t1", status: "live", createdAt: "2026-10-10T01:00:00Z", participants: [p("you", { kind: "human", mode: "monitor" }), p("main", { kind: "ticket-main" }), p("qa-1", { role: "QA", mode: "monitor" })], ...x,
});
const msg = (seq: number) => ({ id: `m${seq}`, seq });

test("pickHuddle: the open one hosted here, else the newest closed one", () => {
  const closedOld = huddle({ id: "a", status: "closed", createdAt: "2026-10-01T00:00:00Z" });
  const closedNew = huddle({ id: "b", status: "closed", createdAt: "2026-10-05T00:00:00Z" });
  const open = huddle({ id: "c", status: "stopped", createdAt: "2026-10-02T00:00:00Z" });
  const elsewhere = huddle({ id: "d", hostTicket: "t2" });
  expect(pickHuddle([closedOld, open, closedNew, elsewhere], "t1")?.id).toBe("c");
  expect(pickHuddle([closedOld, closedNew, elsewhere], "t1")?.id).toBe("b");
  expect(pickHuddle([elsewhere], "t1")).toBeNull();
});

test("pickHuddle by id: the picked round, the default when it isn't this ticket's; ticketHuddles and huddleRound", () => {
  const r1 = huddle({ id: "a", status: "closed", createdAt: "2026-10-01T00:00:00Z" });
  const r2 = huddle({ id: "b", status: "live", createdAt: "2026-10-05T00:00:00Z" });
  const elsewhere = huddle({ id: "d", hostTicket: "t2" });
  const all = [r2, elsewhere, r1];
  expect(pickHuddle(all, "t1", "a")?.id).toBe("a");
  expect(pickHuddle(all, "t1", null)?.id).toBe("b");
  expect(pickHuddle(all, "t1", "d")?.id).toBe("b");
  expect(pickHuddle(all, "t1", "gone")?.id).toBe("b");
  expect(ticketHuddles(all, "t1").map((h) => h.id)).toEqual(["b", "a"]);
  expect(huddleRound(all, r1)).toBe(1);
  expect(huddleRound(all, r2)).toBe(2);
});

test("huddleTitle: the brief's goal or first line, shortened; else the template; else the date", () => {
  const base = { hostTicket: "t1", status: "closed", createdAt: "2026-10-10T11:20:00Z" };
  expect(huddleTitle({ ...base, brief: { text: "## Brief\n**Goal:** Competitor study: Paperclip\nDecisions: none" } })).toBe("Competitor study: Paperclip");
  expect(huddleTitle({ ...base, brief: { text: "\n# What to improve next\nmore" } })).toBe("What to improve next");
  expect(huddleTitle({ ...base, brief: { text: "x".repeat(80) } })).toBe(`X${"x".repeat(46)}…`);
  expect(huddleTitle({ ...base, brief: null, template: "design-review" })).toBe("design-review");
  expect(huddleTitle({ ...base })).toContain("2026");
});

test("mergeMessages: by seq, no duplicates", () => {
  expect(mergeMessages([msg(1), msg(3)], [msg(3), msg(2), msg(4)]).map((m) => m.seq)).toEqual([1, 2, 3, 4]);
});

test("@ autocomplete: the partial before the caret, @main first, never @you", () => {
  expect(mentionQuery("hi @ma", 6)).toEqual({ start: 3, query: "ma" });
  expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionQuery("mail a@b", 8)).toBeNull();
  expect(mentionQuery("@main done", 10)).toBeNull();
  expect(mentionCandidates(huddle()).map((c) => c.handle)).toEqual(["main", "all", "qa-1"]);
});

test("participant activity and initials", () => {
  expect(participantActivity(p("r", { status: "working", lastActivity: "Reading export.ts" }))).toBe("Reading export.ts");
  expect(participantActivity(p("r", { mode: "monitor" }))).toBe("watching");
  expect(participantActivity(p("r"))).toBe("idle");
  expect(participantActivity(p("r", { mode: "monitor" }), true)).toBe("idle");
  expect(participantActivity(p("r", { status: "failed", error: "boom\nmore" }))).toBe("failed: boom");
  expect(participantActivity(p("r", { status: "blocked", statusReason: "need the spec" }))).toBe("blocked: need the spec");
  expect(participantActivity(p("r", { status: "done" }))).toBe("done");
  expect(handleInitials("qa-2")).toBe("Q2");
  expect(handleInitials("reviewer")).toBe("R");
});

test("roster draft: size counts @main and invites; errors before Start", () => {
  const d = rosterDraft([{ preset: "reviewer" }, { preset: "qa", count: 3 }]);
  expect(draftSize(d)).toBe(5);
  expect(draftError(d)).toBeNull();
  expect(draftSize({ ...d, invites: ["t2"] })).toBe(6);
  expect(draftError({ ...d, rows: [...d.rows, { key: "x", preset: "qa", count: 4 }] })).toContain("over the limit of 8");
  expect(draftError({ ...d, rows: [{ key: "y", role: " " }] })).toBe("Name each custom role.");
  expect(draftError({ ...d, rows: [] })).toBe("Add at least one role.");
  expect(rowHandle({ role: "Accessibility tester" })).toBe("accessibility-tester");
});

// ---- Board badges and the dock's Huddles list ----

type BP = P & { ticketId?: string | null };
type BH = { id: string; hostTicket: string; hostTitle: string | null; status: string; createdAt: string; updatedAt: string; seq: number; invited: string[]; participants: BP[] };
const bh = (x: Partial<BH> = {}): BH => ({
  id: "h1", hostTicket: "t_20261009_k2pm", hostTitle: "CSV export", status: "live", createdAt: "2026-10-10T01:00:00Z", updatedAt: "2026-10-10T02:00:00Z",
  seq: 12, invited: [],
  participants: [
    p("you", { kind: "human", mode: "monitor" }),
    { ...p("main", { kind: "ticket-main", status: "working" }), ticketId: "t_20261009_k2pm" },
    p("qa-1", { status: "working" }),
    p("dev-1"),
  ],
  ...x,
});

test("cardHuddleBadge: host card of a live huddle counts agents and who is working", () => {
  const b = cardHuddleBadge([bh()], "t_20261009_k2pm");
  expect(b).toMatchObject({ huddleId: "h1", openTicket: "t_20261009_k2pm", state: "live", label: "Huddle · 3 · 2 working" });
  expect(cardHuddleBadge([bh({ status: "stopped" })], "t_20261009_k2pm")?.label).toBe("Huddle · 3 · stopped");
});

test("cardHuddleBadge: an invited ticket points at the host's Huddle tab", () => {
  const h = bh({ invited: ["t_20261008_abcd"], participants: [...bh().participants, { ...p("api", { kind: "ticket-main" }), ticketId: "t_20261008_abcd" }] });
  expect(guestTickets(h)).toEqual(["t_20261008_abcd"]);
  const b = cardHuddleBadge([h], "t_20261008_abcd");
  expect(b).toMatchObject({ state: "guest", openTicket: "t_20261009_k2pm", label: "in huddle of k2pm" });
  // Once the huddle closes, the guest card drops the badge.
  expect(cardHuddleBadge([{ ...h, status: "closed" }], "t_20261008_abcd")).toBeNull();
});

test("cardHuddleBadge: a closed huddle shows its message count; its own open huddle wins over a guest one", () => {
  expect(cardHuddleBadge([bh({ status: "closed", seq: 31 })], "t_20261009_k2pm")?.label).toBe("Huddle · closed · 31 msgs");
  const guestOf = bh({ id: "h2", hostTicket: "t_x_other", invited: ["t_20261009_k2pm"] });
  expect(cardHuddleBadge([guestOf, bh()], "t_20261009_k2pm")?.huddleId).toBe("h1");
  expect(cardHuddleBadge([bh()], "t_nobody")).toBeNull();
  expect(shortTicketId("t_20261009_k2pm")).toBe("k2pm");
});

test("sortHuddles: live, then stopped, then the newest closed ones (capped)", () => {
  const list = [
    bh({ id: "c1", status: "closed", updatedAt: "2026-10-01T00:00:00Z" }),
    bh({ id: "s", status: "stopped" }),
    bh({ id: "c2", status: "closed", updatedAt: "2026-10-05T00:00:00Z" }),
    bh({ id: "l", status: "live", updatedAt: "2026-10-02T00:00:00Z" }),
  ];
  expect(sortHuddles(list).map((h) => h.id)).toEqual(["l", "s", "c2", "c1"]);
  expect(sortHuddles(list, 1).map((h) => h.id)).toEqual(["l", "s", "c2"]);
});

test("upsertHuddle replaces by id or appends", () => {
  const a = bh({ id: "a" }), b = bh({ id: "b" });
  expect(upsertHuddle([a], b).map((h) => h.id)).toEqual(["a", "b"]);
  expect(upsertHuddle([a, b], { ...a, seq: 99 })[0].seq).toBe(99);
});

test("cardHuddleBadge: brake, quiet, failed and for-you", () => {
  const now = Date.parse("2026-10-10T02:12:00Z");
  const brake = cardHuddleBadge([bh({ status: "stopped", stopReason: "budget", maxCostUsd: 20, forYou: 2 } as Partial<BH>)], "t_20261009_k2pm", now)!;
  expect(brake).toMatchObject({ state: "brake", label: "Huddle · paused: $20 budget", forYou: 2 });
  expect(brakeLabel({ status: "stopped", stopReason: "messages" })).toBe("paused: message limit");
  expect(brakeLabel({ status: "stopped", stopReason: "loop" })).toBe("paused: waiting for you");
  // A plain Stop keeps the quiet stopped look.
  expect(cardHuddleBadge([bh({ status: "stopped", stopReason: null } as Partial<BH>)], "t_20261009_k2pm")).toMatchObject({ state: "stopped", label: "Huddle · 3 · stopped" });
  const quiet = cardHuddleBadge([bh({ quiet: true, idleSince: "2026-10-10T02:00:00Z", findings: [{ status: "resolved" }] } as Partial<BH>)], "t_20261009_k2pm", now)!;
  expect(quiet).toMatchObject({ state: "quiet", label: "Huddle · 3 · idle 12m · 0 open" });
  const failed = bh({ participants: [...bh().participants, p("x", { status: "failed" })] });
  expect(cardHuddleBadge([failed], "t_20261009_k2pm")).toMatchObject({ state: "live", failed: 1, forYou: 0 });
  expect(idleFor("2026-10-10T02:11:40Z", now)).toBe("<1m");
  expect(idleFor("2026-10-09T23:00:00Z", now)).toBe("3h");
});

test("for you and the untagged hint", () => {
  const m = (seq: number, from: string, mentions: string[]) => ({ seq, from, mentions });
  expect(isForYou(m(5, "qa-1", ["you"]), 4)).toBe(true);
  expect(isForYou(m(4, "qa-1", ["you"]), 4)).toBe(false);
  expect(isForYou(m(6, "qa-1", ["all"]), 4)).toBe(false);
  expect(isForYou(m(6, "system", ["you"]), 4)).toBe(true);
  const h = huddle();
  expect(draftTags("hi @main and @nobody, @ALL", ["main", "qa-1"])).toEqual(["main", "all"]);
  expect(untaggedHint("@qa-1 look", h)).toBeNull();
  expect(untaggedHint("   ", h)).toBeNull();
  expect(untaggedHint("thoughts?", h)).toBe("No @tag: only @qa-1 (monitor) will see this. Nobody else wakes.");
  expect(untaggedHint("thoughts?", huddle({ participants: [p("main", { kind: "ticket-main" })] }))).toContain("nobody wakes");
});

test("parseDigest: entries back from a digest, continuation lines unindented and unescaped", () => {
  const { huddleDigest } = require("../src/server/prompts");
  const text = huddleDigest([
    { seq: 1, from: "system", kind: "system", text: "Huddle started" },
    { seq: 2, from: "qa-1", kind: "message", text: "Found a bug\n[#9] not an entry\nline 3" },
    { seq: 3, from: "rev", kind: "finding", text: "Pin it" },
  ], 2);
  const d = parseDigest(text);
  expect(d.note).toContain("2 earlier unread messages");
  expect(d.entries).toEqual([
    { seq: 1, from: null, finding: false, text: "Huddle started" },
    { seq: 2, from: "qa-1", finding: false, text: "Found a bug\n[#9] not an entry\nline 3" },
    { seq: 3, from: "rev", finding: true, text: "Pin it" },
  ]);
  expect(digestSenders(d.entries)).toEqual(["qa-1", "rev"]);
  expect(digestPreview(text)).toBe("@rev: Pin it (+2 more)");
  expect(digestPreview("plain")).toBe("plain");
  // The pinned brief heading a digest is kept apart from the note and the entries.
  const withBrief = parseDigest(huddleDigest([{ seq: 4, from: "qa-1", kind: "message", text: "hi" }], 1, { text: "Goal: ship.\nDecided: no.", by: "main", at: "" }));
  expect(withBrief).toMatchObject({ brief: "Goal: ship.\nDecided: no.", note: "(1 earlier unread message left out; read them with huddle_read)" });
  expect(withBrief.entries).toEqual([{ seq: 4, from: "qa-1", finding: false, text: "hi" }]);
});

test("applyTemplate fills the roster and budget and remembers the template; none keeps the rows", () => {
  type E = { preset?: string; role?: string; handle?: string };
  const d = rosterDraft<E>([{ preset: "qa" }]);
  const t: { name: string; roster: E[]; maxCostUsd: number | null } = { name: "design-review", roster: [{ handle: "ux", role: "UX critic" }, { preset: "reviewer" }], maxCostUsd: 30 };
  const a = applyTemplate(d, t);
  expect(a.rows.map((r) => rowHandle(r))).toEqual(["ux", "reviewer"]);
  expect(a).toMatchObject({ template: "design-review", maxCostUsd: 30 });
  // Claude's own roster with a template: its rows, the template's budget and rules.
  expect(applyTemplate(d, t, [{ preset: "qa" }]).rows.map((r) => r.preset)).toEqual(["qa"]);
  expect(applyTemplate(d, { ...t, maxCostUsd: null }).maxCostUsd).toBe(20);
  const none = applyTemplate(a, null);
  expect(none.template).toBeNull();
  expect(none.rows).toBe(a.rows);
});

test("sourceLabel and withActivity", () => {
  expect(sourceLabel("ui")).toContain("board");
  expect(sourceLabel("mcp")).toContain("MCP");
  expect(sourceLabel("none")).toContain("no client header");
  expect(sourceLabel(undefined)).toBeNull();
  const h = huddle();
  const next = withActivity(h, "qa-1", "Reading a.ts");
  expect(next.participants.find((x) => x.handle === "qa-1")!.lastActivity).toBe("Reading a.ts");
  expect(withActivity(next, "qa-1", "Reading a.ts")).toBe(next);
  expect(withActivity(h, "nobody", "x")).toBe(h);
});

test("session viewer helpers: model names, meta line, tool icons, merging a refreshed tail, footer state", () => {
  expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet");
  expect(modelLabel("opus")).toBe("Opus");
  expect(modelLabel("gpt-x")).toBe("gpt-x");
  expect(modelLabel(null)).toBe("default model");
  expect(shortSession("7c1e5b2a-0000-4000-8000-0000000000a9")).toBe("7c1e…a9");
  expect(sessionMeta({ role: "QA", model: "sonnet", mode: "tagged", costUsd: 1.237, sessionId: "7c1e5b2a-x-a9", snapshot: { sha: "4f2b9d1abc" }, kind: "agent" }))
    .toBe("QA · Sonnet · tagged · $1.24 · session 7c1e…a9 · snapshot @4f2b9d1");
  expect(sessionMeta({ role: "Coordinator", model: null, mode: "monitor", costUsd: 0, sessionId: null, snapshot: null, kind: "ticket-main" })).toBe("Coordinator · monitor · $0.00");
  expect(toolIcon("Grep: join")).toBe("⌕");
  expect(toolIcon("Bash: ls")).toBe("$");
  expect(toolIcon("mcp__ckanban__huddle_read")).toBe("⚙");
  const step = (i: number, text = "") => ({ i, text });
  expect(mergeSteps([step(3), step(4, "old"), step(5)], [step(4, "new"), step(5), step(6)])).toEqual([step(3), step(4, "new"), step(5), step(6)]);
  expect(mergeSteps([step(1)], [])).toEqual([step(1)]);
  const agent = { kind: "agent", live: false, status: "stopped", sessionId: "s" };
  expect(sessionState({ ...agent, live: true }, false)).toBe("Live");
  expect(sessionState(agent, true)).toBe("Stopped · the huddle is closed; its steps stay viewable");
  expect(sessionState({ ...agent, sessionId: null }, false)).toContain("No session yet");
  expect(sessionState({ ...agent, kind: "ticket-main" }, false)).toContain("ticket's own chat");
});

test("team tab: usage text, scope chips only for exceptions, reset target", () => {
  expect(usageText(undefined)).toBe("never used");
  expect(usageText({ huddles: 0, lastUsed: null })).toBe("never used");
  expect(usageText({ huddles: 1, lastUsed: new Date(Date.now() - 5 * 3600_000).toISOString() })).toBe("5h ago · 1 huddle");
  expect(usageText({ huddles: 9, lastUsed: new Date(Date.now() - 2 * 86400_000).toISOString() })).toBe("2d ago · 9 huddles");
  expect(scopeChip({ source: "builtin", base: null, builtin: true })).toBeNull();
  expect(scopeChip({ source: "global", base: null, builtin: false })).toBeNull();
  expect(scopeChip({ source: "board", base: "global", builtin: false })).toEqual({ text: "changed on this board", tone: "warn" });
  expect(scopeChip({ source: "board", base: null, builtin: false })).toEqual({ text: "this board only", tone: "" });
  expect(resetTitle({ base: "global" })).toBe("Back to the all-boards version");
  expect(resetTitle({ base: "builtin" })).toBe("Back to the built-in version");
});

test("context tag: size text, warn threshold, and live updates through huddle.activity", () => {
  expect(contextText(850)).toBe("850 ctx");
  expect(contextText(42_400)).toBe("42k ctx");
  expect(contextText(1_200_000)).toBe("1.2M ctx");
  expect(contextText(2_000_000)).toBe("2M ctx");
  expect(BIG_CONTEXT_TOKENS).toBe(120_000);
  const h = { participants: [{ handle: "qa", lastActivity: "x", contextTokens: 1000 }] };
  expect(withActivity(h, "qa", "x", undefined, 1000)).toBe(h);
  expect(withActivity(h, "qa", "x", undefined, 2000).participants[0].contextTokens).toBe(2000);
  expect(withActivity(h, "qa", "y").participants[0].contextTokens).toBe(1000);
});
