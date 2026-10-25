// Huddles: learnings and role notes, teammates, usage, leads and the idle watchdog.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { callTool, type ToolContext } from "../src/mcp-server";
import { HUDDLE_IDLE_MS, teammateSpend } from "../src/server/huddle";
import { BUILTIN_PRESETS, deletePreset, mergePresets, presetSourceText, savePreset } from "../src/server/huddle-presets";
import { huddleUsage } from "../src/server/huddle-usage";
import { cleanLessons, LESSON_MAX, noteRole, parseNotes, serializeNotes } from "../src/server/huddle-notes";
import { HUDDLE_HEADER, rosterError } from "../src/server/huddle-roster";
import { BUILTIN_TEMPLATES } from "../src/server/huddle-templates";
import { HUDDLE_DESCRIPTION_MAX, hostDescription } from "../src/server/prompts";
import type { Huddle, Profile } from "../src/server/types";
import { store, board, huddles, server, client, events, learned, idle, heardBy, processes, host, participant, agentCtx, text, you, messages, until, api, postJson, useHuddleEnv } from "./huddle-env";
import { makeRepo } from "./helpers";

useHuddleEnv();

// ---- Learnings and role notes ----

const lesson = (text: string, scope: "general" | "repo" = "general") => ({ text, evidence: "#3", scope });

test("role notes files: newest first, source kept, round trip; lessons are checked", () => {
  const notes = [
    { text: "Check light and dark mode.", by: "ux", date: "2026-10-10", huddle: "h_abc" },
    { text: "Repro command, not a description.", by: "you", date: null, huddle: null },
  ];
  const md = serializeNotes("qa", "general", notes);
  expect(md).toContain("- Check light and dark mode. <!-- from @ux, 2026-10-10, huddle h_abc -->");
  expect(md).toContain("- Repro command, not a description. <!-- by you -->");
  expect(parseNotes(md)).toEqual(notes);
  expect(() => cleanLessons([lesson("a"), lesson("b"), lesson("c"), lesson("d")])).toThrow("at most 3 lessons");
  expect(() => cleanLessons([lesson("x".repeat(LESSON_MAX + 1))])).toThrow(`limit of ${LESSON_MAX}`);
  expect(() => cleanLessons([{ text: "ok", scope: "board" }])).toThrow("scope must be general or repo");
  expect(cleanLessons([{ text: " Two\nlines <!-- x --> ", evidence: "#1", scope: "repo" }])).toEqual([{ text: "Two lines x", evidence: "#1", scope: "repo" }]);
  expect(noteRole("qa-lead")).toBe("qa-lead");
  expect(noteRole("_all")).toBe("_all");
  expect(noteRole("../etc")).toBeNull();
});

test("lessons: huddle_status done hands up to 3 to the board's pile, not to the user, and only with done", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "qa" }, { role: "Copy critic", prompt: "Critique the UI." }]);
  await idle();
  const view = () => huddles.view("p", store.getHuddle("p", h.id)!);
  const before = view().forYou;
  // Four is refused and nothing changes.
  const tooMany = await callTool("huddle_status", { status: "done", lessons: [lesson("a"), lesson("b"), lesson("c"), lesson("d")] }, agentCtx(h, "qa"));
  expect(tooMany.isError).toBe(true);
  expect(text(tooMany)).toContain("at most 3 lessons");
  expect(participant(h, "qa").status).not.toBe("done");
  // Only with done.
  expect((await callTool("huddle_status", { status: "blocked", reason: "x", lessons: [lesson("a")] }, agentCtx(h, "qa"))).isError).toBe(true);
  const r = await callTool("huddle_status", { status: "done", reason: "tested", lessons: [lesson("Clear CKANBAN_* before tests.", "repo"), lesson("Repro command for every bug.")] }, agentCtx(h, "qa"));
  expect(text(r)).toContain("2 lessons noted; the board saves them once they come up again");
  expect(participant(h, "qa").status).toBe("done");
  // huddle_post's status flag takes lessons too; an ad-hoc role's lessons are aimed at every role.
  await callTool("huddle_post", { text: "UI reviewed", status: "done", lessons: [lesson("Check light and dark mode.")] }, agentCtx(h, "copy-critic"));
  expect(learned.map((l) => [l.huddle, l.handle, l.role, l.lessons.map((x) => [x.text, x.scope])])).toEqual([
    [h.id, "qa", "qa", [["Clear CKANBAN_* before tests.", "repo"], ["Repro command for every bug.", "general"]]],
    [h.id, "copy-critic", "_all", [["Check light and dark mode.", "general"]]],
  ]);
  expect(messages(h).some((m) => m.text.includes("@qa is done: tested. It noted 2 lessons for future huddles"))).toBe(true);
  // Nothing waits for the user's review.
  expect(store.getHuddle("p", h.id)!.learnings ?? []).toEqual([]);
  expect(view()).toMatchObject({ learningsPending: 0 });
  expect(view().forYou).toBe(before);
}, 20000);

test("role notes: only the user changes them; anyone reads them", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "qa" }]);
  await idle();
  const agent = { [HUDDLE_HEADER]: `${h.id}/qa/${participant(h, "qa").token}` };
  const put = (headers: Record<string, string>) =>
    api("/huddle-notes/qa/general", { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ notes: [{ text: "Give every bug a repro command." }] }) });
  expect((await put(agent)).status).toBe(403);
  expect((await put({ "x-ckanban-run": `p/${t.id}` })).status).toBe(403);
  expect(store.readHuddleNotes("p", "qa", "general")).toEqual([]);
  expect((await put({})).status).toBe(200);
  expect(store.readHuddleNotes("p", "qa", "general").map((n) => n.text)).toEqual(["Give every bug a repro command."]);
  const all = (await (await api("/huddle-notes")).json()) as { cap: number; notes: Record<string, unknown> };
  expect(all.cap).toBe(30);
  expect(Object.keys(all.notes)).toEqual(["qa"]);
}, 20000);

test("a new agent's system prompt has the role's notes and All roles notes, newest first, capped, from its own board only", async () => {
  const day = "2026-10-10";
  const many = Array.from({ length: 35 }, (_, i) => ({ text: `qa rule ${i + 1}`, by: "you", date: day, huddle: null }));
  store.writeHuddleNotes("p", "qa", "general", many);
  store.writeHuddleNotes("p", "qa", "repo", [{ text: "qa repo rule", by: "qa", date: day, huddle: "h_x" }]);
  store.writeHuddleNotes("p", "_all", "general", [{ text: "all general rule", by: "you", date: day, huddle: null }]);
  store.writeHuddleNotes("p", "_all", "repo", [{ text: "all repo rule", by: "you", date: day, huddle: null }]);
  store.writeHuddleNotes("p", "reviewer", "general", [{ text: "reviewer rule", by: "you", date: day, huddle: null }]);
  // Another board's repo notes stay there.
  store.writeHuddleNotes("other", "qa", "repo", [{ text: "other board rule", by: "you", date: day, huddle: null }]);
  store.writeHuddleNotes("other", "_all", "repo", [{ text: "other board all rule", by: "you", date: day, huddle: null }]);
  const t = await host();
  huddles.create("p", t.id, [{ preset: "qa" }, { role: "Copy critic", prompt: "Critique the UI." }]);
  await idle();
  const sys = (handle: string) => {
    const r = processes().find((x) => x.args.join(" ").includes(`You are @${handle} `))!;
    return r.args.join(" ");
  };
  const qa = sys("qa");
  expect(qa).toContain("# Lessons from past huddles");
  for (const s of ["all general rule", "all repo rule", "qa rule 1\n", "qa rule 30\n", "qa repo rule"]) expect(qa).toContain(s);
  expect(qa).not.toContain("qa rule 31");
  expect(qa).not.toContain("reviewer rule");
  expect(qa).not.toContain("other board");
  // Order: All roles general, All roles repo, role general, role repo.
  const at = (s: string) => qa.indexOf(s);
  expect(at("all general rule") < at("all repo rule") && at("all repo rule") < at("qa rule 1\n") && at("qa rule 30\n") < at("qa repo rule")).toBe(true);
  // An ad-hoc agent gets All roles notes only.
  const ux = sys("copy-critic");
  expect(ux).toContain("all general rule");
  expect(ux).not.toContain("qa rule");
}, 20000);

test("session viewer: a participant's steps over HTTP, also after the huddle closed and its snapshot is gone; the user's alone", async () => {
  process.env.FAKE_TRANSCRIPT = "1";
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  const p = participant(h, "reviewer");
  const url = (handle: string, rest = "") => `${client.url}/api/profiles/p/huddles/${h.id}/participants/${handle}/session${rest}`;
  const get = async (handle = "reviewer", headers: Record<string, string> = {}, rest = "") => fetch(url(handle, rest), { headers });
  const check = async () => {
    const r = await get();
    expect(r.status).toBe(200);
    const s: any = await r.json();
    expect(s).toMatchObject({ handle: "reviewer", kind: "agent", role: p.role, sessionId: p.sessionId, snapshot: p.snapshot, live: false, current: null, hasMore: false });
    expect(s.file).toEndWith(`${p.sessionId}.jsonl`);
    const kinds = s.steps.map((x: any) => x.kind);
    expect(kinds[0]).toBe("wake");
    expect(s.steps.find((x: any) => x.kind === "text")?.text).toBe("Checking how rows are built.");
    expect(s.steps.find((x: any) => x.kind === "tool" && x.id === "tu_ls")).toMatchObject({ text: "Bash: ls src", out: "2 lines" });
    expect(s.steps.find((x: any) => x.kind === "post")).toMatchObject({ id: "tu_post", text: "@main found it", seq: 7 });
    expect(s.steps.some((x: any) => x.pending && x.id)).toBe(false);
    expect(s.total).toBe(s.steps.length);
    // Paging: newest last.
    const page: any = await (await get("reviewer", {}, "?limit=2")).json();
    expect(page.steps.map((x: any) => x.i)).toEqual([s.total - 2, s.total - 1]);
    expect(page.hasMore).toBe(true);
    const older: any = await (await get("reviewer", {}, `?before=${s.total - 2}&limit=2`)).json();
    expect(older.steps.at(-1).i).toBe(s.total - 3);
    // A tool call in full.
    const tool: any = await (await get("reviewer", {}, "/tool/tu_ls")).json();
    expect(tool).toMatchObject({ name: "Bash", input: { command: "ls src" }, output: "app.ts\nlib.ts" });
    expect((await get("reviewer", {}, "/tool/nope")).status).toBe(404);
  };
  await check();
  // @main's session is the ticket's chat: no steps, the ticket to link to.
  expect(await (await get("main")).json()).toMatchObject({ kind: "ticket-main", ticketId: t.id, steps: [], file: null });
  expect((await get("nobody")).status).toBe(404);
  expect((await get("you")).status).toBe(404);
  // Huddle agents (and runs) can't read anyone's session through the API.
  const agent = { [HUDDLE_HEADER]: `${h.id}/reviewer/${p.token}` };
  expect((await get("reviewer", agent)).status).toBe(403);
  expect((await get("main", agent)).status).toBe(403);
  expect((await get("reviewer", agent, "/tool/tu_ls")).status).toBe(403);
  expect((await get("reviewer", { "x-ckanban-run": `p/${t.id}` })).status).toBe(403);
  // Closed, snapshot removed: still readable.
  huddles.close("p", h.id);
  await idle();
  expect(existsSync(p.worktree!)).toBe(false);
  await check();
}, 30000);

test("teammates: built-in -> global -> board merge; deleting falls back one level", () => {
  const global = savePreset([], { name: "qa", prompt: "Global QA.", model: "sonnet" }).list;
  const withA11y = savePreset(global, { name: "a11y", prompt: "Check a11y." }).list;
  // A board edit of qa starts from the global version, not the built-in.
  const board = savePreset([], { name: "qa", prompt: "Board QA." }, mergePresets(withA11y)).list;
  expect(board[0]).toMatchObject({ name: "qa", prompt: "Board QA.", model: "sonnet", role: "QA tester" });
  const merged = mergePresets(withA11y, [...board, ...savePreset([], { name: "local", prompt: "Here only." }).list]);
  expect(merged.map((p) => p.name)).toEqual([...BUILTIN_PRESETS.map((p) => p.name), "a11y", "local"]);
  expect(merged.find((p) => p.name === "qa")).toMatchObject({ source: "board", base: "global", builtin: true, prompt: "Board QA." });
  expect(merged.find((p) => p.name === "a11y")).toMatchObject({ source: "global", base: null, builtin: false });
  expect(merged.find((p) => p.name === "local")).toMatchObject({ source: "board", base: null, builtin: false });
  expect(presetSourceText(merged.find((p) => p.name === "qa")!)).toBe("built-in, changed on this board");
  expect(presetSourceText(merged.find((p) => p.name === "a11y")!)).toBe("all boards");
  expect(presetSourceText(merged.find((p) => p.name === "local")!)).toBe("this board only");
  // Board reset: back to the global version; global reset: back to the built-in.
  const boardReset = deletePreset(board, "qa", mergePresets(withA11y));
  expect(boardReset.reset).toBe(true);
  expect(mergePresets(withA11y, boardReset.list).find((p) => p.name === "qa")).toMatchObject({ source: "global", base: "builtin", prompt: "Global QA." });
  const globalReset = deletePreset(withA11y, "qa");
  expect(mergePresets(globalReset.list, boardReset.list).find((p) => p.name === "qa")).toMatchObject({ source: "builtin", base: null, model: null });
  // The new built-ins, and the design-review template points at them.
  for (const n of ["researcher", "ux-critic", "facilitator"]) expect(BUILTIN_PRESETS.some((p) => p.name === n)).toBe(true);
  expect(BUILTIN_PRESETS.find((p) => p.name === "researcher")).toMatchObject({ model: "sonnet", mode: "tagged", workspace: "shared", canEdit: false });
  expect(BUILTIN_PRESETS.find((p) => p.name === "facilitator")!.lead).toBe(true);
  // It ranks every finding: top N first, the rest in an Appendix with a reason, none dropped.
  expect(BUILTIN_PRESETS.find((p) => p.name === "facilitator")!.prompt).toMatch(/every finding[\s\S]*Appendix[\s\S]*one-line reason[\s\S]*Never drop a finding silently/);
  const roster = BUILTIN_TEMPLATES[0].roster;
  expect(Object.fromEntries(roster.map((e) => [e.handle, e.preset ?? null]))).toMatchObject({ research: "researcher", ux: "ux-critic", facilitator: "facilitator" });
  expect(rosterError(roster, 32, BUILTIN_PRESETS.map((p) => p.name))).toBeNull();
});

test("teammates: saved for all boards show on another board; a board override shows and resets to it", async () => {
  const other: Profile = { name: "Q", slug: "q", path: await makeRepo(), baseBranch: "main", maxParallel: 3, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(other);
  expect((await postJson("/huddle-presets", { name: "a11y", prompt: "Check a11y.", scope: "global" })).status).toBe(201);
  expect(store.listHuddlePresets(null).map((p) => p.name)).toEqual(["a11y"]);
  expect(huddles.presets("q").find((p) => p.name === "a11y")).toMatchObject({ source: "global", base: null });
  // Board q changes it: only q sees the change.
  expect(huddles.savePreset("q", { name: "a11y", prompt: "Check a11y on mobile." })).toMatchObject({ source: "board", base: "global" });
  expect(huddles.presets("p").find((p) => p.name === "a11y")!.prompt).toBe("Check a11y.");
  // Reset (delete at the level in effect) falls back to the all-boards version.
  const r = huddles.deletePreset("q", "a11y");
  expect(r.reset).toBe(true);
  expect(r.presets.find((p) => p.name === "a11y")).toMatchObject({ source: "global", prompt: "Check a11y." });
  // A global change of a built-in; saving for all boards drops this board's own version.
  huddles.savePreset("p", { name: "qa", prompt: "Board QA." });
  huddles.savePreset("p", { name: "qa", prompt: "Everyone's QA." }, "global");
  expect(store.listHuddlePresets("p")).toEqual([]);
  expect(huddles.presets("q").find((p) => p.name === "qa")).toMatchObject({ source: "global", base: "builtin", prompt: "Everyone's QA." });
  expect((await api("/huddle-presets/qa?scope=global", { method: "DELETE" })).status).toBe(200);
  expect(huddles.presets("q").find((p) => p.name === "qa")!.source).toBe("builtin");
  // Deleting the global teammate removes it everywhere; a run can't save for all boards.
  expect((await api("/huddle-presets/a11y", { method: "DELETE" })).status).toBe(200);
  expect(huddles.presets("q").some((p) => p.name === "a11y")).toBe(false);
  expect((await postJson("/huddle-presets", { name: "perf", prompt: "Profile.", scope: "global" }, { "x-ckanban-run": "p/t_x" })).status).toBe(403);
  expect((await postJson("/huddle-presets", { name: "perf", prompt: "Profile.", scope: "everywhere" })).status).toBe(400);
  // Templates take the same levels.
  expect((await postJson("/huddle-templates", { name: "bug-bash", roster: [{ preset: "qa" }], scope: "global" })).status).toBe(201);
  expect(huddles.templates("q").find((t) => t.name === "bug-bash")).toMatchObject({ source: "global" });
});

test("teammates: rosters and propose_huddle resolve presets through all three levels", async () => {
  const t = await host();
  huddles.savePreset("p", { name: "a11y", prompt: "Check a11y.", model: "haiku" }, "global");
  huddles.savePreset("p", { name: "reviewer", prompt: "Review everywhere." }, "global");
  huddles.savePreset("p", { name: "reviewer", prompt: "Review this repo." });
  const ctx: ToolContext = { client, cwd: "/", env: { CKANBAN_TICKET: `p/${t.id}` } };
  expect((await callTool("propose_huddle", { roster: [{ preset: "a11y" }, { preset: "researcher" }] }, ctx)).isError).toBeUndefined();
  expect(text(await callTool("list_huddle_presets", {}, ctx))).toContain("- a11y: A11y (tagged, reads only, model haiku; all boards)");
  const h = huddles.create("p", t.id, [{ preset: "a11y" }, { preset: "reviewer" }]);
  expect(participant(h, "a11y")).toMatchObject({ preset: "a11y", model: "haiku", prompt: "Check a11y." });
  expect(participant(h, "reviewer").prompt).toBe("Review this repo.");
  await huddles.stopAll("p", h.id);
}, 20000);

test("usage stats: per teammate and template, from every board's huddles, closed ones included", async () => {
  const mk = (id: string, createdAt: string, template: string | null, ps: [string | null, string, number, string?][]): Huddle => ({
    id, hostTicket: "t_1", status: "closed", maxParticipants: 8, findings: [], invited: [], seq: 0, template, createdAt, updatedAt: createdAt,
    participants: ps.map(([preset, joinedAt, costUsd, kind]) => ({
      handle: `${preset}-${joinedAt}`, role: "r", preset, prompt: "", model: null, mode: "tagged", lead: false, canEdit: false, workspace: "shared",
      sessionId: null, status: "done", kind: (kind ?? "agent") as any, cursor: 0, joinedAt, costUsd,
    })),
  });
  const u = huddleUsage([
    { board: "p", title: "Login", huddle: mk("h_1", "2026-10-01T00:00:00Z", "design-review", [["qa", "2026-10-01T00:00:00Z", 0.5], ["qa", "2026-10-01T01:00:00Z", 0.25], ["reviewer", "2026-10-01T00:00:00Z", 1], [null, "2026-10-01T00:00:00Z", 2]]) },
    { board: "q", title: null, huddle: mk("h_2", "2026-10-05T00:00:00Z", null, [["qa", "2026-10-05T00:00:00Z", 1], [null, "2026-10-05T00:00:00Z", 0, "human"]]) },
  ]);
  expect(u.teammates.qa).toMatchObject({ huddles: 2, lastUsed: "2026-10-05T00:00:00Z", costUsd: 1.75 });
  expect(u.teammates.qa.recent.map((r) => [r.board, r.huddle, r.costUsd])).toEqual([["q", "h_2", 1], ["p", "h_1", 0.75]]);
  expect(u.teammates.reviewer).toMatchObject({ huddles: 1, costUsd: 1 });
  expect(u.teammates.researcher).toBeUndefined();
  expect(u.templates["design-review"]).toMatchObject({ huddles: 1, lastUsed: "2026-10-01T00:00:00Z", costUsd: 3.75 });
  // Over HTTP, from the files: a closed huddle still counts.
  const t = await host();
  store.saveHuddle("p", { ...mk("h_3", "2026-10-06T00:00:00Z", null, [["security", "2026-10-06T00:00:00Z", 0.3]]), hostTicket: t.id });
  const r = (await (await fetch(`http://127.0.0.1:${server.port}/api/team-usage`)).json()) as { teammates: Record<string, any> };
  expect(r.teammates.security).toMatchObject({ huddles: 1, costUsd: 0.3, recent: [{ board: "p", huddle: "h_3", title: "Login page" }] });
});

test("leads watch: the facilitator preset and a lead entry without a mode are monitor; an explicit mode wins", async () => {
  expect(BUILTIN_PRESETS.find((p) => p.name === "facilitator")!.mode).toBe("monitor");
  // A preset saved as a lead without a mode watches too.
  expect(savePreset([], { name: "boss", prompt: "Lead", lead: true }).preset.mode).toBe("monitor");
  expect(savePreset([], { name: "boss", prompt: "Lead", lead: true, mode: "tagged" }).preset.mode).toBe("tagged");
  const t = await host();
  const h = huddles.create("p", t.id, [
    { preset: "facilitator" }, { preset: "reviewer", handle: "lead-r", lead: true }, { preset: "reviewer", handle: "tagged-lead", lead: true, mode: "tagged" },
    { preset: "reviewer" },
  ]);
  expect(participant(h, "facilitator")).toMatchObject({ lead: true, mode: "monitor" });
  expect(participant(h, "lead-r")).toMatchObject({ lead: true, mode: "monitor" });
  expect(participant(h, "tagged-lead")).toMatchObject({ lead: true, mode: "tagged" });
  expect(participant(h, "reviewer")).toMatchObject({ lead: false, mode: "tagged" });
  await huddles.stopAll("p", h.id);
}, 20000);

test("a done lead wakes on a worker's tag (tagged) or report (monitor); @all from a worker doesn't wake it", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [
    { preset: "reviewer", handle: "lead", lead: true, mode: "tagged" }, { preset: "reviewer", handle: "mon", lead: true }, { preset: "reviewer", handle: "w" },
  ]);
  await idle();
  for (const l of ["lead", "mon"]) await callTool("huddle_status", { status: "done", reason: "waiting for findings" }, agentCtx(h, l));
  await idle();
  const [l0, m0] = [heardBy("lead").length, heardBy("mon").length];
  // @all from a worker reaches nobody: no tag, and the tagged lead stays done.
  expect(huddles.post("p", h.id, participant(h, "w"), "@all status update").mentions).toEqual([]);
  await idle();
  expect(heardBy("lead").length).toBe(l0);
  expect(participant(h, "lead").status).toBe("done");
  // ...but the monitor lead watches every worker report.
  expect(heardBy("mon").length).toBe(m0 + 1);
  expect(participant(h, "mon").status).not.toBe("done");
  // A worker's tag wakes the done tagged lead.
  huddles.post("p", h.id, participant(h, "w"), "@lead report ready");
  await idle();
  expect(heardBy("lead").length).toBe(l0 + 1);
  expect(heardBy("lead").at(-1)).toContain("@w: @lead report ready");
  expect(participant(h, "lead").status).not.toBe("done");
  // The monitor lead, done again, wakes on an untagged report.
  await callTool("huddle_status", { status: "done" }, agentCtx(h, "mon"));
  await idle();
  const m1 = heardBy("mon").length;
  huddles.post("p", h.id, participant(h, "w"), "found 3 issues, see outputs/report.md");
  await idle();
  expect(heardBy("mon").length).toBe(m1 + 1);
  expect(participant(h, "mon").status).not.toBe("done");
  // No "wasn't woken" note for any of it.
  expect(messages(h).some((m) => m.text.includes("wasn't woken"))).toBe(false);
}, 30000);

test("a tag that wakes nobody is never dropped: one note tags @main per target and sender until the target wakes", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer", handle: "a" }, { preset: "reviewer", handle: "b" }]);
  await idle();
  await callTool("huddle_status", { status: "done" }, agentCtx(h, "a"));
  await idle();
  const a0 = heardBy("a").length;
  const notes = () => messages(h).filter((m) => m.kind === "system" && m.text.includes("wasn't woken"));
  huddles.post("p", h.id, participant(h, "b"), "@a did you check logout?");
  await until(() => !!store.getTicket("p", t.id)!.sessionStarted);
  await idle();
  expect(heardBy("a").length).toBe(a0);
  expect(participant(h, "a").status).toBe("done");
  expect(notes().length).toBe(1);
  expect(notes()[0].text).toBe("@a is done and wasn't woken by @b's tag; @main or a lead can wake it.");
  expect(notes()[0].mentions).toEqual(["main"]);
  // @main was woken by the note.
  expect(heardBy(store.getTicket("p", t.id)!.sessionId!).join("\n")).toContain("wasn't woken by @b");
  // A second tag from b: no second note.
  huddles.post("p", h.id, participant(h, "b"), "@a ping");
  await idle();
  expect(notes().length).toBe(1);
  // Once a wakes, the next unwoken tag is noted again.
  huddles.post("p", h.id, you(h), "@a check logout");
  await idle();
  expect(heardBy("a").length).toBe(a0 + 1);
  await callTool("huddle_status", { status: "done" }, agentCtx(h, "a"));
  huddles.post("p", h.id, participant(h, "b"), "@a one more");
  await idle();
  expect(notes().length).toBe(2);
}, 30000);

test("idle watchdog: wakes @main once after 5 minutes of nobody working; not while working, not twice, not when stopped or closed", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer", handle: "w" }, { preset: "reviewer", handle: "lead", lead: true, mode: "tagged" }]);
  await idle();
  await callTool("huddle_status", { status: "done" }, agentCtx(h, "lead"));
  await callTool("huddle_post", { text: "my part is finished", status: "done" }, agentCtx(h, "w"));
  await idle();
  const nudges = () => messages(h).filter((m) => m.kind === "system" && m.text.startsWith("Huddle idle"));
  const last = messages(h).findLast((m) => m.kind !== "system")!;
  const at = Date.parse(store.getHuddle("p", h.id)!.updatedAt);
  // Not yet 5 minutes.
  huddles.idleSweep(at + HUDDLE_IDLE_MS - 1000);
  expect(nudges().length).toBe(0);
  // Someone working: no nudge.
  process.env.FAKE_STEP_MS = "400";
  huddles.post("p", h.id, you(h), "@w one more look please");
  await until(() => participant(h, "w").status === "working");
  const lastW = messages(h).findLast((m) => m.kind !== "system")!;
  huddles.idleSweep(Date.now() + HUDDLE_IDLE_MS * 2);
  expect(nudges().length).toBe(0);
  await idle();
  delete process.env.FAKE_STEP_MS;
  // @you had the last word: no nudge.
  huddles.idleSweep(Date.now() + HUDDLE_IDLE_MS * 2);
  expect(nudges().length).toBe(0);
  expect(lastW.from).toBe("you");
  // A worker speaks last, then nothing happens for 5 minutes: @main is woken once.
  await callTool("huddle_post", { text: "still looks fine" }, agentCtx(h, "w"));
  await idle();
  const report = messages(h).findLast((m) => m.kind !== "system")!;
  expect(report.seq).toBeGreaterThan(last.seq);
  huddles.idleSweep(Date.now() + HUDDLE_IDLE_MS + 1000);
  expect(nudges().length).toBe(1);
  expect(nudges()[0].text).toBe(`Huddle idle for 5 min since #${report.seq} (last: @w). Check who should act, or ask the user to close it.`);
  expect(nudges()[0].mentions).toEqual(["main"]);
  await until(() => !!store.getTicket("p", t.id)!.sessionStarted);
  await idle();
  // Not again without a new message.
  huddles.idleSweep(Date.now() + HUDDLE_IDLE_MS * 3);
  expect(nudges().length).toBe(1);
  // Stopped: no nudge even after a new worker message.
  await callTool("huddle_post", { text: "another note" }, agentCtx(h, "w"));
  await idle();
  huddles.stopAll("p", h.id);
  huddles.idleSweep(Date.now() + HUDDLE_IDLE_MS * 3);
  expect(nudges().length).toBe(1);
  // Closed: none either.
  huddles.close("p", h.id);
  huddles.idleSweep(Date.now() + HUDDLE_IDLE_MS * 3);
  expect(nudges().length).toBe(1);
}, 40000);

test("a teammate's system prompt carries the host ticket's description, cut with a pointer to get_ticket when long", async () => {
  expect(hostDescription("  ")).toBe("(no description)");
  expect(hostDescription("![shot](a.png) **Build** it")).toBe("![shot](a.png) **Build** it");
  const long = hostDescription("x".repeat(HUDDLE_DESCRIPTION_MAX + 500));
  expect(long).toEndWith("(truncated; use get_ticket for the full text)");
  expect(long.length).toBeLessThan(HUDDLE_DESCRIPTION_MAX + 60);

  const t = await board.createTicket("p", { title: "Login page", body: `Build the login form.\n${"y".repeat(9000)}TAIL`, status: "review" });
  huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  const args: string[] = processes().find((r) => r.env?.CKANBAN_HUDDLE_AGENT || r.args.includes("--disallowedTools"))!.args;
  const system = args[args.indexOf("--append-system-prompt") + 1];
  expect(system).toContain(`## The ticket (${t.id} "Login page")\nBuild the login form.`);
  expect(system).toContain("(truncated; use get_ticket for the full text)");
  expect(system).not.toContain("TAIL");
}, 20000);

test("context size: an agent's from its own session, @main's from the ticket session, saved with the participant", async () => {
  process.env.FAKE_CTX = "42000";
  try {
    const t = await host();
    const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
    await idle();
    expect(participant(h, "reviewer").contextTokens).toBe(42000);
    expect(events.some((e) => e.type === "huddle.updated" && e.huddle.participants.some((p) => p.handle === "reviewer" && p.contextTokens === 42000))).toBe(true);
    process.env.FAKE_CTX = "130000";
    huddles.post("p", h.id, you(h), "@main status?");
    await until(() => participant(h, "main").contextTokens === 130000);
    await idle();
    expect(participant(h, "reviewer").contextTokens).toBe(42000);
  } finally {
    delete process.env.FAKE_CTX;
  }
}, 20000);

test("teammate spend counts on the host ticket's card and Usage tab, @main and today's total aren't counted twice", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  huddles.post("p", h.id, you(h), "@main status?");
  await idle();
  const main = participant(h, "main").costUsd ?? 0;
  const reviewer = participant(h, "reviewer").costUsd ?? 0;
  expect(main).toBeGreaterThan(0);
  expect(reviewer).toBeCloseTo(0.01);
  const spend = teammateSpend(store.listHuddles("p"), t.id);
  expect(spend.costUsd).toBeCloseTo(reviewer);
  expect(spend.huddles).toEqual([{ id: h.id, status: "live", createdAt: h.createdAt, costUsd: reviewer, teammates: [{ handle: "reviewer", role: "Code reviewer", costUsd: reviewer }] }]);
  expect(teammateSpend(store.listHuddles("p"), "t_other").costUsd).toBe(0);

  const base = `http://127.0.0.1:${server.port}/api`;
  const runs = (await (await fetch(`${base}/profiles/p/tickets/${t.id}/usage`)).json()) as any;
  const ticketRunsCost = runs.runs.reduce((s: number, r: any) => s + r.costUsd, 0);
  // @main's reply is one of the ticket's own runs; only the reviewer is added on top.
  expect(ticketRunsCost).toBeGreaterThanOrEqual(main - 1e-9);
  expect(runs.totals.costUsd).toBeCloseTo(ticketRunsCost + reviewer);
  expect(runs.teammates.costUsd).toBeCloseTo(reviewer);
  expect(runs.teammates.huddles[0].teammates.map((x: any) => x.handle)).toEqual(["reviewer"]);
  const card = (await (await fetch(`${base}/profiles/p/tickets/${t.id}`)).json()) as any;
  expect(card.costUsd).toBeCloseTo(ticketRunsCost + reviewer);
  const today = (await (await fetch(`${base}/spend`)).json()) as any;
  expect(today.boards.find((b: any) => b.slug === "p").costUsd).toBeCloseTo(ticketRunsCost + reviewer);
}, 20000);
