import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardClient } from "../src/client";
import { callTool, type ToolContext } from "../src/mcp-server";
import { Board, type ChatOptions } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { AUTO_MAX_COST_USD, Huddles, summaryFile } from "../src/server/huddle";
import { reviewHuddleRequest } from "../src/server/huddle-roster";
import { chatPrompt, firstRunPrompt, freshSessionPrompt, planningPrompt, resumePrompt } from "../src/server/prompts";
import { Store } from "../src/server/store";
import { autoHuddlesOn, type Profile, type Ticket } from "../src/server/types";
import { makeRepo, tempDir } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");

let store: Store;
let bus: Bus;
let board: Board;
let huddles: Huddles;
let server: ReturnType<typeof createServer>;
let client: BoardClient;
/** Messages the board sent into tickets' sessions (Board.chat), by ticket. */
let sent: { id: string; text: string; opts: ChatOptions }[];

beforeEach(async () => {
  process.env.CLAUDE_CONFIG_DIR = tempDir("ck-claude-");
  process.env.FAKE_MODE = "ok";
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  huddles = new Huddles(store, board, bus, { claudeBin: FAKE, idleMs: 300 });
  server = createServer({ store, bus, board, huddles, port: 0, webDir: tempDir("ck-web-") });
  client = new BoardClient(server.port);
  const p: Profile = { name: "P", slug: "p", path: await makeRepo(), baseBranch: "main", maxParallel: 3, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p);
  sent = [];
  const chat = board.chat.bind(board);
  board.chat = (slug: string, id: string, text: string, opts: ChatOptions = {}) => {
    sent.push({ id, text, opts });
    return chat(slug, id, text, opts);
  };
});

afterEach(async () => {
  await Promise.all([board.shutdown(), huddles.shutdown()]);
  server.stop(true);
  for (const k of ["FAKE_MODE", "FAKE_STREAM_DELAY", "CLAUDE_CONFIG_DIR"]) delete process.env[k];
}, 15000);

async function until(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

const runCtx = (id: string): ToolContext => ({ client, cwd: "/", env: { CKANBAN_TICKET: `p/${id}` } });
const text = (r: { content: { text: string }[] }) => r.content[0].text;
const ticket = (id: string) => store.getTicket("p", id)!;
const inProgress = (title: string, extra: Partial<Ticket> = {}) =>
  board.createTicket("p", { title, body: "Do it", status: "backlog" }).then((t) => store.updateTicket("p", t.id, { status: "in_progress", ...extra }));

/** Pretend the ticket's current run is unattended work (no real claude run needed for the guards). */
function unattended(...ids: string[]) {
  board.unattendedRun = (_slug, id) => ids.includes(id);
  const claimed = new Set<string>();
  board.claimAutoHuddle = (_slug, id) => (claimed.has(id) ? false : (claimed.add(id), true));
}

/** A roster a run builds for its change: two helpers and a lead. */
const SQUAD = [
  { preset: "reviewer", prompt: "Check the upload route's type checks." },
  { preset: "qa", prompt: "Upload a fake PDF and an .exe; both must be refused." },
  { preset: "qa-lead", prompt: "Send @main one list." },
];
const risky = (reason: string, extra: Record<string, unknown> = {}) => ({ trigger: "security", reason, roster: SQUAD, ...extra });

function writeSummary(t: string, hid: string) {
  mkdirSync(join(store.outputsDir("p", t), "huddles", hid), { recursive: true });
  writeFileSync(join(store.outputsDir("p", t), summaryFile(hid)), "# Summary\n");
}

test("⭐ important: set when creating, by the ticket's own run via update_ticket, shown in ticket lines", async () => {
  const res = await fetch(`${client.url}/api/profiles/p/tickets`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Pay", body: "", status: "backlog", important: true }),
  });
  const created = (await res.json()) as Ticket;
  expect(created.important).toBe(true);
  const t = await board.createTicket("p", { title: "Login", body: "", status: "review" });
  expect(t.important).toBeUndefined();
  // The ticket's own run (its chat included) may mark it; it's credited in a comment.
  const r = await callTool("update_ticket", { id: t.id, important: true }, runCtx(t.id));
  expect(r.isError).toBeUndefined();
  expect(text(r)).toContain("⭐ Login");
  expect(ticket(t.id).important).toBe(true);
  expect(store.listComments("p", t.id).at(-1)!.text).toContain("⭐ Important");
  // Another ticket's run has no rights on it, and the own-run exception covers only the flag.
  const other = await callTool("update_ticket", { id: t.id, important: false }, runCtx(created.id));
  expect(other.isError).toBe(true);
  const more = await callTool("update_ticket", { id: t.id, important: false, title: "x" }, runCtx(t.id));
  expect(more.isError).toBe(true);
  expect(ticket(t.id)).toMatchObject({ important: true, title: "Login" });
  // The user clears it.
  await client.updateTicket("p", t.id, { important: false });
  expect(ticket(t.id).important).toBe(false);
});

test("Auto huddles board setting: on unless turned off; toggling persists", async () => {
  expect(autoHuddlesOn(store.getProfile("p"))).toBe(true);
  expect(autoHuddlesOn({ autoHuddles: false })).toBe(false);
  const patch = (b: unknown) => fetch(`${client.url}/api/profiles/p`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  expect((await patch({ autoHuddles: false })).status).toBe(200);
  expect(store.getProfile("p")!.autoHuddles).toBe(false);
  await patch({ autoHuddles: true });
  expect(autoHuddlesOn(store.getProfile("p"))).toBe(true);
});

test("start_huddle guards: outside runs, chats, setting off, a live huddle on the ticket", async () => {
  const t = await inProgress("Login");
  // Not a board run at all.
  let r = await callTool("start_huddle", risky("new login route"), { client, cwd: "/", env: {} });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("propose_huddle");
  // A board run that isn't unattended work (no run, a chat reply or a Planning chat).
  r = await callTool("start_huddle", risky("new login route"), runCtx(t.id));
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("unattended run");
  expect(text(r)).toContain("propose_huddle");
  unattended(t.id);
  // Huddle agents and other tickets' runs can't start it for the ticket.
  const res = await fetch(`${client.url}/api/profiles/p/huddles/auto`, {
    method: "POST", headers: { "content-type": "application/json", "x-ckanban-huddle-agent": "h/x/y", "x-ckanban-run": `p/${t.id}` }, body: JSON.stringify({ reason: "x" }),
  });
  expect(res.status).toBe(403);
  // Reason required.
  r = await callTool("start_huddle", { reason: " " }, runCtx(t.id));
  expect(r.isError).toBe(true);
  // Setting off.
  store.saveProfile({ ...store.getProfile("p")!, autoHuddles: false });
  r = await callTool("start_huddle", risky("new login route"), runCtx(t.id));
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("auto huddles are off");
  store.saveProfile({ ...store.getProfile("p")!, autoHuddles: true });
  // The ticket already has an open huddle (the user's).
  const mine = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  r = await callTool("start_huddle", risky("new login route"), runCtx(t.id));
  expect(r.isError).toBe(true);
  expect(text(r)).toContain(mine.id);
  expect(ticket(t.id).autoHuddle ?? null).toBeNull();
});

test("start_huddle: the trigger is required and must fit the ticket; a run's own huddle needs a roster", async () => {
  const t = await inProgress("Upload");
  const asks = await inProgress("Asks", { body: "## Goal\nDo it\n\n## Review huddle\nA reviewer checks the copy." });
  unattended(t.id, asks.id);
  const err = async (args: Record<string, unknown>, id = t.id) => {
    const r = await callTool("start_huddle", args, runCtx(id));
    expect(r.isError).toBe(true);
    return text(r);
  };
  expect(await err({ reason: "upload route", roster: SQUAD })).toContain("trigger is required: one of security, data, payments, important, asked");
  expect(await err({ trigger: "user-facing", reason: "upload route", roster: SQUAD })).toContain("trigger is required");
  expect(await err({ trigger: "asked", reason: "upload route", roster: SQUAD })).toContain('only for a ticket with a "## Review huddle" section');
  expect(await err({ trigger: "important", reason: "upload route", roster: SQUAD })).toContain("only for a ticket marked ⭐ Important");
  // Deciding on its own, the run builds the roster: no template fallback, not even a named one.
  for (const trigger of ["security", "data", "payments"]) {
    expect(await err({ trigger, reason: "upload route" })).toContain("pass a roster built for this change");
  }
  expect(await err({ trigger: "security", reason: "upload route", template: "auto-review" })).toContain("pass a roster");
  // A section that names neither a template nor a roster: the run builds one too.
  expect(await err({ trigger: "asked", reason: "the ticket asks" }, asks.id)).toContain("pass a roster");
  expect(ticket(t.id).autoHuddle ?? null).toBeNull();
  expect(store.listHuddles("p")).toHaveLength(0);
  // A valid custom roster starts exactly that roster.
  const r = await callTool("start_huddle", risky("new upload route serves files from the app's address"), runCtx(t.id));
  expect(r.isError).toBeUndefined();
  const a = ticket(t.id).autoHuddle!;
  expect(a).toMatchObject({ state: "live", trigger: "security", template: "custom" });
  const agents = store.getHuddle("p", a.huddleId!)!.participants.filter((p) => p.kind === "agent");
  expect(agents.map((p) => p.handle)).toEqual(SQUAD.map((e) => e.preset));
  agents.forEach((p, i) => expect(p.prompt).toEndWith(SQUAD[i].prompt));
  expect(store.listComments("p", t.id).at(-1)!.text).toBe("Auto huddle started (custom roster, security): new upload route serves files from the app's address");
});

test("the auto huddle rule: real risk only, named trigger, a roster built for the change", async () => {
  const t = await board.createTicket("p", { title: "Login", body: "Do it", status: "backlog" });
  const rule = firstRunPrompt(t, { repo: "remote" as const, outputDir: "/o", autoHuddles: true });
  for (const s of ["`security`", "`data`", "`payments`", "When unsure, don't huddle", "user-facing UI or text changes", "bug fixes",
    "already covered by a specific requirement in the ticket", "check each of those points yourself", "list in your result what you checked and how",
    "build a `roster` for this change", "`list_huddle_presets`", "`qa-lead`", "Read the code without changing the checkout"]) {
    expect(rule).toContain(s);
  }
  expect(rule).not.toContain("user-facing behaviour");
  expect(rule).not.toContain("`auto-review`");
  // ⭐: always a huddle, trigger important, still a built roster.
  const star = firstRunPrompt({ ...t, important: true }, { repo: "remote" as const, outputDir: "/o", autoHuddles: true });
  expect(star).toContain("trigger `important`");
  expect(star).toContain("build a `roster`");
  expect(star).not.toContain("When unsure, don't huddle");
  // The tool's own descriptions don't call user-facing work a risk either.
  const { TOOLS } = await import("../src/mcp-server");
  const tool = TOOLS.find((x: { name: string }) => x.name === "start_huddle")!;
  expect(JSON.stringify(tool).toLowerCase()).not.toContain("user-facing");
  expect(tool.inputSchema.required).toEqual(["trigger", "reason"]);
});

test("start_huddle starts the important roster for a ⭐ ticket, once per run; the coordinator closes it itself", async () => {
  const t = await inProgress("Payments", { important: true });
  unattended(t.id);
  // ⭐ alone no longer picks a template: the run builds the roster.
  const none = await callTool("start_huddle", { trigger: "important", reason: "⭐ important: payment flow" }, runCtx(t.id));
  expect(none.isError).toBe(true);
  expect(text(none)).toContain("pass a roster built for this change");
  const roster = [
    { preset: "security", prompt: "Check the refund amount can't go negative." },
    { role: "Payments tester", prompt: "Refund twice; the second must be refused." },
    { preset: "qa-lead", prompt: "Send @main one list." },
  ];
  const r = await callTool("start_huddle", { trigger: "important", reason: "⭐ important: payment flow", roster }, runCtx(t.id));
  expect(r.isError).toBeUndefined();
  expect(text(r)).toContain("started (custom");
  const a = ticket(t.id).autoHuddle!;
  expect(a).toMatchObject({ state: "live", reason: "⭐ important: payment flow", trigger: "important", template: "custom" });
  const h = store.getHuddle("p", a.huddleId!)!;
  expect(h.auto).toEqual({ reason: "⭐ important: payment flow" });
  expect(h.maxCostUsd).toBe(20);
  expect(h.template).toBeNull();
  expect(h.participants.filter((p) => p.kind === "agent").map((p) => [p.handle, p.role])).toEqual([
    ["security", "Security reviewer"], ["payments-tester", "Payments tester"], ["qa-lead", "QA lead"],
  ]);
  // The custom roster still gets the report format and read-only rule pinned.
  expect(h.brief!.text).toContain("[MUST|SHOULD|COULD]");
  expect(h.brief!.text).toContain("never edit, checkout or reset");
  expect(h.brief!.text).toContain("Budget: $20.");
  expect(store.listComments("p", t.id).at(-1)!.text).toBe("Auto huddle started (custom roster, important): ⭐ important: payment flow");
  // One per run (and the ticket now has an open huddle anyway).
  expect((await callTool("start_huddle", { trigger: "important", reason: "again", roster }, runCtx(t.id))).isError).toBe(true);
  // @main of an auto huddle closes it at once, after the summary; the ticket stops waiting for it.
  writeSummary(t.id, h.id);
  const c = await callTool("huddle_close", { reason: "landed" }, runCtx(t.id));
  expect(text(c)).toContain("Closed the auto huddle");
  expect(store.getHuddle("p", h.id)!.status).toBe("closed");
  expect(ticket(t.id).autoHuddle ?? null).toBeNull();
});

test("start_huddle budget: the default, a budget the ticket asks for, capped at $100", async () => {
  const startMsg = (hid: string) => store.readHuddleMessages("p", hid)[0].text;
  const close = async (id: string) => {
    const hid = ticket(id).autoHuddle!.huddleId!;
    writeSummary(id, hid);
    await callTool("huddle_close", { reason: "landed" }, runCtx(id));
  };
  const [a, b, c, d] = [await inProgress("A"), await inProgress("B"), await inProgress("C"), await inProgress("D")];
  unattended(a.id, b.id, c.id, d.id);
  // Without a budget: the template's.
  let r = await callTool("start_huddle", risky("upload route"), runCtx(a.id));
  expect(text(r)).toContain("budget $20.00");
  let h = store.getHuddle("p", ticket(a.id).autoHuddle!.huddleId!)!;
  expect(h.maxCostUsd).toBe(20);
  expect(startMsg(h.id)).toContain("Budget $20.00 (default).");
  expect(startMsg(h.id)).toContain("by its own run (security: upload route)");
  await close(a.id);
  // The ticket asks for $40: the cost brake is at $40.
  r = await callTool("start_huddle", risky("upload route", { maxCostUsd: 40 }), runCtx(b.id));
  expect(text(r)).toContain("budget $40.00");
  h = store.getHuddle("p", ticket(b.id).autoHuddle!.huddleId!)!;
  expect(h.maxCostUsd).toBe(40);
  expect(startMsg(h.id)).toContain("Budget $40.00 (asked by the ticket's run).");
  await close(b.id);
  // Above the ceiling: capped.
  await callTool("start_huddle", risky("upload route", { maxCostUsd: 250 }), runCtx(c.id));
  h = store.getHuddle("p", ticket(c.id).autoHuddle!.huddleId!)!;
  expect(h.maxCostUsd).toBe(AUTO_MAX_COST_USD);
  expect(startMsg(h.id)).toContain("Budget $100.00 (asked $250.00, capped at $100.00).");
  await close(c.id);
  // Not a positive amount: refused.
  r = await callTool("start_huddle", risky("upload route", { maxCostUsd: -5 }), runCtx(d.id));
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("maxCostUsd must be a positive amount");
});

test("a ticket waiting for the slot keeps the budget it asked for in its wake", async () => {
  const a = await inProgress("A");
  const b = await inProgress("B");
  unattended(a.id, b.id);
  await callTool("start_huddle", risky("upload route"), runCtx(a.id));
  const ha = ticket(a.id).autoHuddle!.huddleId!;
  await callTool("start_huddle", { trigger: "data", reason: "data migration", roster: SQUAD, maxCostUsd: 500 }, runCtx(b.id));
  expect(ticket(b.id).autoHuddle).toMatchObject({ state: "waiting", maxCostUsd: AUTO_MAX_COST_USD });
  writeSummary(a.id, ha);
  await callTool("huddle_close", { reason: "landed" }, runCtx(a.id));
  await until(() => sent.some((m) => m.id === b.id));
  const wake = sent.find((m) => m.id === b.id)!.text;
  expect(wake).toContain(`maxCostUsd ${AUTO_MAX_COST_USD}`);
  expect(wake).toContain("trigger data, the same roster you built before");
});

test("one auto huddle per board: the second ticket waits for the slot and is woken when it frees", async () => {
  const a = await inProgress("A");
  const b = await inProgress("B");
  unattended(a.id, b.id);
  // The roster the run built is the huddle's roster.
  expect(text(await callTool("start_huddle", risky("upload route"), runCtx(a.id)))).toContain("started");
  const ha = ticket(a.id).autoHuddle!.huddleId!;
  expect(store.getHuddle("p", ha)!.participants.filter((p) => p.kind === "agent").map((p) => p.handle)).toEqual(["reviewer", "qa", "qa-lead"]);
  const r = await callTool("start_huddle", { trigger: "data", reason: "data migration", roster: SQUAD }, runCtx(b.id));
  expect(r.isError).toBeUndefined();
  expect(text(r)).toContain("waits for the huddle slot");
  expect(ticket(b.id).autoHuddle).toMatchObject({ state: "waiting", reason: "data migration", trigger: "data", template: "custom", huddleId: null });
  expect(store.listComments("p", b.id).at(-1)!.text).toContain("Auto huddle wanted (data: data migration)");
  expect(store.listHuddles("p").filter((h) => h.hostTicket === b.id)).toHaveLength(0);
  // Waiting doesn't need the user.
  const view = (await client.getTicket("p", b.id)) as Ticket & { attention: unknown };
  expect(view.attention).toBeNull();
  // A's huddle closes: B is woken (as its own work) to take the slot.
  writeSummary(a.id, ha);
  await callTool("huddle_close", { reason: "landed" }, runCtx(a.id));
  await until(() => sent.some((m) => m.id === b.id));
  const wake = sent.find((m) => m.id === b.id)!;
  expect(wake.opts.hostWake).toBe(true);
  expect(wake.text).toContain("start_huddle");
  expect(wake.text).toContain("data migration");
  expect(ticket(b.id).autoHuddle ?? null).toBeNull();
  // Its woken run takes the slot.
  expect(text(await callTool("start_huddle", { trigger: "data", reason: "data migration", roster: SQUAD }, runCtx(b.id)))).toContain("started");
  expect(ticket(b.id).autoHuddle).toMatchObject({ state: "live" });
});

test("a ticket waiting for the huddle slot survives a restart and is woken after it", async () => {
  const b = await inProgress("B", { autoHuddle: { state: "waiting", reason: "security fix", template: "auto-review-important", at: new Date().toISOString(), huddleId: null } });
  // The board's recover leaves it waiting in In Progress (no "resuming" run).
  const board2 = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  const huddles2 = new Huddles(store, board2, bus, { claudeBin: FAKE, idleMs: 300 });
  const woken: string[] = [];
  const chat = board2.chat.bind(board2);
  board2.chat = (slug: string, id: string, t: string, opts: ChatOptions = {}) => {
    if (opts.hostWake) woken.push(id);
    return chat(slug, id, t, opts);
  };
  board2.recover();
  expect(ticket(b.id).status).toBe("in_progress");
  expect(board2.isRunning("p", b.id)).toBe(false);
  expect(woken).toEqual([]);
  huddles2.recover();
  expect(woken).toEqual([b.id]);
  await Promise.all([board2.shutdown(), huddles2.shutdown()]);
});

test("a brake stopping an auto huddle wakes the host to decide (no landing with MUST findings open); the user stopping it sends the card to Review", async () => {
  const t = await inProgress("Login", { important: true });
  unattended(t.id);
  await callTool("start_huddle", { trigger: "important", reason: "⭐ important", roster: SQUAD }, runCtx(t.id));
  const hid = ticket(t.id).autoHuddle!.huddleId!;
  (huddles as any).halt("p", hid, "budget", "The huddle spent $20.00 of its $20.00 budget and stopped.");
  await until(() => sent.some((m) => m.id === t.id && m.opts.hostWake));
  const wake = sent.find((m) => m.id === t.id && m.opts.hostWake)!;
  expect(wake.text).toContain("do NOT land");
  expect(wake.text).toContain("budget cap");
  expect(ticket(t.id).autoHuddle ?? null).toBeNull();
  await board.whenIdle();

  const u = await inProgress("Other");
  unattended(u.id);
  await callTool("start_huddle", risky("upload route"), runCtx(u.id));
  const uh = ticket(u.id).autoHuddle!.huddleId!;
  huddles.stopAll("p", uh);
  expect(ticket(u.id)).toMatchObject({ status: "review", outcome: "stopped", autoHuddle: null });
});

test("a run that started (or waits for) an auto huddle ends In Progress, not in Review", async () => {
  process.env.FAKE_STREAM_DELAY = "300";
  const t = await board.createTicket("p", { title: "Login", body: "Do it", status: "ready" });
  await until(() => board.isRunning("p", t.id));
  expect(board.unattendedRun("p", t.id)).toBe(true);
  expect(board.claimAutoHuddle("p", t.id)).toBe(true);
  expect(board.claimAutoHuddle("p", t.id)).toBe(false);
  board.setAutoHuddle("p", t.id, { state: "waiting", reason: "risky", template: "auto-review", at: new Date().toISOString(), huddleId: null });
  await board.whenIdle();
  expect(ticket(t.id)).toMatchObject({ status: "in_progress", outcome: null, lastActivity: "Waiting for huddle slot" });
  // Stop on the waiting card clears it.
  expect(board.stop("p", t.id)).toBe(true);
  expect(ticket(t.id)).toMatchObject({ status: "review", outcome: "stopped", autoHuddle: null });
});

test("the auto huddle prompt section: unattended run prompts only, when the board setting is on", async () => {
  const t = await board.createTicket("p", { title: "Login", body: "Do it", status: "backlog" });
  const on = firstRunPrompt(t, { repo: "remote" as const, outputDir: "/o", autoHuddles: true });
  expect(on).toContain("# Auto huddle");
  expect(on).toContain("start_huddle");
  expect(on).toContain("At most once per run; never from a Planning chat");
  expect(firstRunPrompt(t, { repo: "remote" as const, outputDir: "/o" })).not.toContain("# Auto huddle");
  expect(firstRunPrompt(t, { repo: "remote" as const, outputDir: "/o", autoHuddles: false })).not.toContain("# Auto huddle");
  expect(firstRunPrompt({ ...t, important: true }, { repo: "remote" as const, outputDir: "/o", autoHuddles: true })).toContain("marked ⭐ Important");
  expect(resumePrompt(t, [], "/o", true)).toContain("# Auto huddle");
  expect(resumePrompt(t, [], "/o")).not.toContain("# Auto huddle");
  const fresh = { repo: "remote" as const, linked: false, baseBranch: "main", lastResult: null, comments: [], outputDir: "/o" };
  expect(freshSessionPrompt(t, { ...fresh, autoHuddles: true })).toContain("# Auto huddle");
  expect(freshSessionPrompt(t, fresh)).not.toContain("# Auto huddle");
  // Chats and Planning never get it.
  expect(planningPrompt(t, "/t.md")).not.toContain("start_huddle");
  expect(chatPrompt(t, "hi", "refine", "/o")).not.toContain("start_huddle");
  expect(chatPrompt(t, "hi", "act", "/o")).not.toContain("start_huddle");
});

const ASKS = "## Goal\nDo it\n\n## Review huddle\nTemplate: `auto-review-important`\nCheck the login copy.\nBudget: ~$30\n\n## Acceptance criteria\n- works";

test("a ticket's ## Review huddle section: parsed for its template and budget", () => {
  expect(reviewHuddleRequest("## Goal\nx")).toBeNull();
  expect(reviewHuddleRequest(ASKS)).toEqual({ text: "Template: `auto-review-important`\nCheck the login copy.\nBudget: ~$30", template: "auto-review-important", maxCostUsd: 30 });
  // Last section, bold labels, no budget.
  expect(reviewHuddleRequest("# T\n### Review Huddle\n**Template:** auto-review")).toEqual({ text: "**Template:** auto-review", template: "auto-review" });
  expect(reviewHuddleRequest("## Review huddle\nA reviewer checks the docs.")).toEqual({ text: "A reviewer checks the docs." });
  // The words inside the check text aren't labels.
  expect(reviewHuddleRequest("## Review huddle\nCheck the email template copy and the budget: it costs $5.")).toEqual({ text: "Check the email template copy and the budget: it costs $5." });
  expect(reviewHuddleRequest("## Review huddle\n- **Template**: auto-review\n- Budget (default): about $1,000.50")).toMatchObject({ template: "auto-review", maxCostUsd: 1000.5 });
});

test("a ticket that asks for a review huddle: its run starts it after the work, even with Auto huddles off", async () => {
  store.saveProfile({ ...store.getProfile("p")!, autoHuddles: false });
  const plain = await inProgress("Plain");
  const asks = await inProgress("Login", { body: ASKS });
  unattended(plain.id, asks.id);
  // No section: the setting still decides.
  const off = await callTool("start_huddle", risky("risky"), runCtx(plain.id));
  expect(off.isError).toBe(true);
  expect(text(off)).toContain("auto huddles are off");
  // The section counts as opt-in and gives the template and budget.
  const r = await callTool("start_huddle", { trigger: "asked", reason: "the ticket asks for one" }, runCtx(asks.id));
  expect(r.isError).toBeUndefined();
  const a = ticket(asks.id).autoHuddle!;
  expect(a).toMatchObject({ state: "live", trigger: "asked", template: "auto-review-important" });
  expect(store.listComments("p", asks.id).at(-1)!.text).toBe("Auto huddle started (auto-review-important, asked): the ticket asks for one");
  expect(store.getHuddle("p", a.huddleId!)!.maxCostUsd).toBe(30);
  // The run prompt gets the section even with the setting off; it says to do the work first.
  const t = ticket(asks.id);
  for (const p of [firstRunPrompt(t, { repo: "remote" as const, outputDir: "/o", autoHuddles: false }), resumePrompt(t, [], "/o", false)]) {
    expect(p).toContain("# Review huddle (the ticket asks for one)");
    expect(p).toContain("Do the work yourself first");
    expect(p).toContain("`auto-review-important`");
    expect(p).toContain("($30 here)");
  }
  expect(firstRunPrompt(ticket(plain.id), { repo: "remote" as const, outputDir: "/o", autoHuddles: false })).not.toContain("start_huddle");
});

test("Planning: the chat writes the huddle into the ticket; propose_huddle is refused there and works after Planning", async () => {
  const t = await board.createTicket("p", { title: "Login", body: "Do it", status: "backlog" });
  store.updateTicket("p", t.id, { status: "planning" });
  const refine = chatPrompt(ticket(t.id), "I want a huddle", "refine", "/o");
  expect(refine).toContain("## Review huddle");
  expect(refine).toContain("Budget: ~$N");
  const r = await callTool("propose_huddle", { template: "auto-review" }, runCtx(t.id));
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("## Review huddle");
  // Backlog chats too: the work hasn't started there either.
  store.updateTicket("p", t.id, { status: "backlog" });
  expect((await callTool("propose_huddle", { template: "auto-review" }, runCtx(t.id))).isError).toBe(true);
  store.updateTicket("p", t.id, { status: "review" });
  expect((await callTool("propose_huddle", { template: "auto-review" }, runCtx(t.id))).isError).toBeUndefined();
});

test("the UI asks before a run and the user's huddle work the same ticket at once", async () => {
  const ui = { "content-type": "application/json", "x-ckanban-source": "ui" };
  const patch = (id: string, b: object, headers: Record<string, string> = ui) =>
    fetch(`${client.url}/api/profiles/p/tickets/${id}`, { method: "PATCH", headers, body: JSON.stringify(b) });
  const t = await board.createTicket("p", { title: "Login", body: "Do it", status: "backlog" });
  store.updateTicket("p", t.id, { status: "planning" });
  huddles.create("p", t.id, [{ preset: "reviewer" }]);
  // Moving it to Ready while the huddle is live: a question, nothing changes.
  const asked = await patch(t.id, { body: "New text", status: "ready" });
  expect(asked.status).toBe(409);
  expect(await asked.json()).toEqual({ error: "A huddle is already working on this ticket.", confirm: "huddle-open" });
  expect(ticket(t.id)).toMatchObject({ status: "planning", body: "Do it" });
  // Other edits don't ask; the user's yes starts it.
  expect((await patch(t.id, { title: "Login page" })).status).toBe(200);
  expect((await patch(t.id, { body: "New text", status: "backlog" })).status).toBe(200);
  board.updateTicket = (async (_s: string, id: string) => ticket(id)) as typeof board.updateTicket;
  expect((await patch(t.id, { status: "ready", confirmParallel: true })).status).toBe(200);
  // Callers other than the UI (CLI, runs) aren't asked.
  expect((await patch(t.id, { status: "ready" }, { "content-type": "application/json" })).status).toBe(200);

  // Starting a huddle while the ticket's run is working on it.
  const w = await inProgress("Work");
  board.isRunning = (_s, id) => id === w.id;
  const start = (b: object) => fetch(`${client.url}/api/profiles/p/huddles`, { method: "POST", headers: ui, body: JSON.stringify({ ticketId: w.id, roster: [{ preset: "reviewer" }], ...b }) });
  const q = await start({});
  expect(q.status).toBe(409);
  expect(((await q.json()) as { confirm: string }).confirm).toBe("run-active");
  expect(store.listHuddles("p").some((h) => h.hostTicket === w.id)).toBe(false);
  expect((await start({ confirmParallel: true })).status).toBe(201);
});
