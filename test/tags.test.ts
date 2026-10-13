import { afterEach, beforeEach, expect, test } from "bun:test";
import { callTool, ticketsError, type ToolContext } from "../src/mcp-server";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { Scheduler } from "../src/server/scheduler";
import { parseNewTickets } from "../src/server/session";
import { Store } from "../src/server/store";
import { normalizeTag as serverNormalizeTag, normalizeTags } from "../src/server/tags";
import { boardTags, hasTags, normalizeTag, parseSearch, tagHue } from "../web/src/tagText";
import { tempDir } from "./helpers";

test("normalizeTags: trimmed, lowercase, no #, dashes for spaces, no blanks or repeats, capped", () => {
  expect(normalizeTags(["Post", "#XHS", " post ", "", "  ", "Kitchen Reno", 3, "##deep"])).toEqual(["post", "xhs", "kitchen-reno", "deep"]);
  expect(normalizeTags("post")).toEqual([]);
  expect(normalizeTags(["a".repeat(40)])).toEqual(["a".repeat(24)]);
  expect(normalizeTags(Array.from({ length: 15 }, (_, i) => `t${i}`))).toHaveLength(10);
  // The board and the server agree on every name.
  for (const v of ["Post", "#XHS", " Kitchen  Reno ", "#", "x".repeat(30)]) expect(normalizeTag(v)).toBe(serverNormalizeTag(v));
});

test("parseSearch: #words are tags, the rest is text", () => {
  expect(parseSearch("#post kitchen")).toEqual({ tags: ["post"], text: "kitchen" });
  expect(parseSearch("  #Post  #xhs #post  Bukit Jalil ")).toEqual({ tags: ["post", "xhs"], text: "bukit jalil" });
  expect(parseSearch("# alone")).toEqual({ tags: [], text: "alone" });
  expect(parseSearch("")).toEqual({ tags: [], text: "" });
});

test("hasTags needs every tag; boardTags counts, most used first", () => {
  const ts = [{ tags: ["post", "xhs"] }, { tags: ["post"] }, { tags: ["website"] }, {}];
  expect(ts.filter((t) => hasTags(t, ["post"]))).toHaveLength(2);
  expect(ts.filter((t) => hasTags(t, ["post", "xhs"]))).toHaveLength(1);
  expect(ts.filter((t) => hasTags(t, []))).toHaveLength(4);
  expect(boardTags(ts)).toEqual([{ name: "post", count: 2 }, { name: "website", count: 1 }, { name: "xhs", count: 1 }]);
});

test("tagHue: the same name always gets the same color", () => {
  expect(tagHue("post")).toBe(tagHue("post"));
  expect(tagHue("post")).not.toBe(tagHue("website"));
  for (const n of ["post", "xhs", "a", "kitchen-reno"]) expect(tagHue(n)).toBeGreaterThanOrEqual(0);
});

// ---- Board and schedules -------------------------------------------------------------------------

let store: Store;
let board: Board;
beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  board = new Board(store, new Bus(), { claudeBin: "/bin/false" });
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
});
afterEach(() => board.whenIdle());

test("tickets store normalized tags; keeping a suggestion moves it to tags", async () => {
  const t = await board.createTicket("p", { title: "Post 5", body: "", status: "backlog", tags: ["Post", "#XHS", "post"] });
  expect(t.tags).toEqual(["post", "xhs"]);
  const plain = await board.createTicket("p", { title: "No tags", body: "", status: "backlog" });
  expect(plain.tags).toBeUndefined();

  let u = await board.updateTicket("p", t.id, { suggestedTags: ["Video", "post"] });
  // A suggestion it already has is dropped.
  expect(u.suggestedTags).toEqual(["video"]);
  u = await board.updateTicket("p", t.id, { tags: [...u.tags!, "video"] });
  expect(u.tags).toEqual(["post", "xhs", "video"]);
  expect(u.suggestedTags).toEqual([]);
  u = await board.updateTicket("p", t.id, { tags: [] });
  expect(u.tags).toEqual([]);
});

test("a schedule's tags go on every ticket it creates, and edits to them are logged", async () => {
  let now = new Date(2026, 9, 1, 8, 30);
  const scheduler = new Scheduler(board, store, new Bus(), () => now);
  const s = scheduler.create("p", { name: "Post interview", title: "Post {date}", body: "interview me", cron: "0 9 * * *", tags: ["Post", "#xhs"] });
  expect(s.tags).toEqual(["post", "xhs"]);
  now = new Date(2026, 9, 1, 9, 0, 10);
  await scheduler.tick();
  const t = store.listTickets("p").find((x) => x.scheduleId === s.id)!;
  expect(t.tags).toEqual(["post", "xhs"]);

  // Same tags: no edit; new tags: an "updated" entry naming them.
  scheduler.update("p", s.id, { tags: ["post", "xhs"] });
  scheduler.update("p", s.id, { tags: ["post"] });
  const edits = scheduler.history("p", s.id).filter((e) => e.kind === "edited" && e.action === "updated");
  expect(edits.map((e) => (e as { fields: string[] }).fields)).toEqual([["tags"]]);
  // Older schedules without tags still fire.
  const old = scheduler.create("p", { name: "Old", title: "Old", body: "", cron: "0 10 * * *" });
  expect(old.tags).toEqual([]);
});

test("proposed tickets keep their tags", () => {
  expect(parseNewTickets([{ title: "A", description: "d", tags: ["Post", 3, ""] }, { title: "B", description: "d" }]))
    .toEqual([{ title: "A", description: "d", tags: ["post"] }, { title: "B", description: "d" }]);
});

// ---- MCP tools ------------------------------------------------------------------------------------

function fake(ticket: Record<string, unknown> = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const t = (over: object = {}) => ({
    id: "t_1", title: "Post 5", status: "backlog", mode: "interview", body: "", outcome: null, prUrl: null, branch: null,
    lastActivity: null, error: null, createdAt: "", updatedAt: "", running: false, ...ticket, ...over,
  });
  const rec = (fn: string, result: (...a: any[]) => unknown) => async (...args: unknown[]) => {
    calls.push({ fn, args });
    return result(...args);
  };
  const client = {
    listProfiles: rec("listProfiles", () => [{ name: "kanban", slug: "kanban", path: "/repos/kanban", baseBranch: "main" }]),
    getTicket: rec("getTicket", () => t()),
    createTicket: rec("createTicket", (_s, input) => t(input)),
    updateTicket: rec("updateTicket", (_s, _id, patch) => t(patch)),
    createSchedule: rec("createSchedule", (_s, input) => ({ id: "s1", name: "x", summary: "", cron: "0 9 * * *", mode: "auto", ...input })),
    cronPreview: rec("cronPreview", () => ({ valid: true, error: null, summary: "", next: [] })),
  };
  return { calls, ctx: (env: Record<string, string> = {}) => ({ client: client as unknown as ToolContext["client"], cwd: "/repos/kanban", env, main: () => null }) as ToolContext };
}

test("create_ticket, update_ticket and create_schedule take normalized tags", async () => {
  const { calls, ctx } = fake();
  await callTool("create_ticket", { title: "Post 5", tags: ["Post", "#XHS"] }, ctx());
  expect(calls.at(-1)!.args[1]).toMatchObject({ title: "Post 5", tags: ["post", "xhs"] });
  await callTool("update_ticket", { id: "t_1", tags: [] }, ctx());
  expect(calls.at(-1)).toEqual({ fn: "updateTicket", args: ["kanban", "t_1", { tags: [] }, undefined] });
  const bad = await callTool("update_ticket", { id: "t_1", tags: "post" }, ctx());
  expect(bad.isError).toBe(true);
  expect(bad.content[0].text).toContain("tags must be a list");
  await callTool("create_schedule", { name: "Interview", title: "Post {date}", body: "b", cron: "0 9 * * 1", tags: ["#Post"] }, ctx({ CKANBAN_TICKET: "kanban/t_9" }));
  expect(calls.find((c) => c.fn === "createSchedule")!.args[1]).toMatchObject({ tags: ["post"] });
});

test("propose_tickets validates tags", () => {
  const t = (tags: unknown) => ({ key: "a", title: "A ticket", description: "d", tags });
  expect(ticketsError({ tickets: [t(["post"])] })).toBeNull();
  expect(ticketsError({ tickets: [t("post")] })).toContain("tags must be a list");
});

test("suggest_tags adds new suggestions to the run's own ticket", async () => {
  const { calls, ctx } = fake({ tags: ["post"], suggestedTags: ["xhs"] });
  const r = await callTool("suggest_tags", { tags: ["Post", "Video"] }, ctx({ CKANBAN_TICKET: "kanban/t_1" }));
  expect(r.isError).toBeUndefined();
  expect(r.content[0].text).toContain("#video");
  expect(calls.at(-1)).toEqual({ fn: "updateTicket", args: ["kanban", "t_1", { suggestedTags: ["xhs", "video"] }, "kanban/t_1"] });
  // Only tags it already has: nothing to send.
  const same = await callTool("suggest_tags", { tags: ["post"] }, ctx({ CKANBAN_TICKET: "kanban/t_1" }));
  expect(same.content[0].text).toContain("nothing to suggest");
  expect((await callTool("suggest_tags", { tags: ["x"] }, ctx())).content[0].text).toBe("id is required outside a board run");
});

test("the first run's prompt offers suggest_tags only while the ticket has no tags", async () => {
  const { firstRunPrompt } = await import("../src/server/prompts");
  const t = await board.createTicket("p", { title: "Post 5", body: "b", status: "backlog" });
  expect(firstRunPrompt(t, { repo: "remote", outputDir: "/out" })).toContain("suggest_tags");
  expect(firstRunPrompt({ ...t, tags: ["post"] }, { repo: "remote", outputDir: "/out" })).not.toContain("suggest_tags");
});
