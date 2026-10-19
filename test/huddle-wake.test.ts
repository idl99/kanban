// Huddles: who can wake whom, budget and message limits, ping-pong and restarts.
import { expect, test } from "bun:test";
import { callTool } from "../src/mcp-server";
import { Huddles } from "../src/server/huddle";
import { HUDDLE_HEADER } from "../src/server/huddle-roster";
import { controlResponse } from "../src/server/runner";
import { FAKE, store, bus, board, huddles, client, idle, heardBy, host, participant, agentCtx, mainCtx, text, you, messages, until, api, postJson, useHuddleEnv } from "./huddle-env";

useHuddleEnv();

test("huddle tools are allowed from a Planning-chat run; other asks are still denied", () => {
  const ask = (tool: string) => (controlResponse({ request_id: "r", request: { subtype: "can_use_tool", tool_name: tool, input: { text: "hi" } } }) as any).response.response;
  for (const t of ["huddle_post", "huddle_read", "huddle_mode", "huddle_findings", "huddle_add_participant"]) {
    expect(ask(`mcp__ckanban__${t}`)).toEqual({ behavior: "allow", updatedInput: { text: "hi" } });
  }
  expect(ask("mcp__ckanban__create_ticket").behavior).toBe("deny");
  expect(ask("Edit").behavior).toBe("deny");
});

test("huddle_post works from the host ticket's Planning-chat run", async () => {
  const t = await board.createTicket("p", { title: "Plan me", body: "", status: "planning" });
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  const r = await callTool("huddle_post", { text: "@reviewer check the plan" }, mainCtx(h));
  expect(text(r)).toContain("as @main");
  await idle();
  expect(heardBy("reviewer").at(-1)).toContain("@main: @reviewer check the plan");
}, 20000);

test("only leads, @main and the user can wake everyone with @all; quoted handles don't wake", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }, { preset: "security" }, { preset: "qa-lead" }]);
  await idle();
  const sec = heardBy("security").length;
  const m = huddles.post("p", h.id, participant(h, "reviewer"), "@all I think we are done");
  expect(m.mentions).toEqual([]);
  await idle();
  expect(heardBy("security").length).toBe(sec);
  expect(store.getTicket("p", t.id)!.sessionStarted).toBeFalsy();
  expect(huddles.post("p", h.id, participant(h, "qa-lead"), "@all wrap up").mentions).toEqual(["all"]);
  await idle();
  expect(heardBy("security").length).toBe(sec + 1);
  expect(heardBy("security").at(-1)).toContain("(you were tagged)");
  // A handle in code is not a tag.
  huddles.post("p", h.id, you(h), "the log says `@security failed`");
  await idle();
  expect(heardBy("security").length).toBe(sec + 1);
}, 20000);

test("participants an agent adds can't be leads, but may change files in their own copy", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "qa-lead" }]);
  await idle();
  const r = await callTool("huddle_add_participant", { role: "Fixer", prompt: "Fix it", focus: "forms", lead: true, canEdit: true, workspace: "own" }, agentCtx(h, "qa-lead"));
  expect(r.isError).toBeUndefined();
  expect(participant(h, "fixer")).toMatchObject({ lead: false, canEdit: true, workspace: "own" });
  // The user still can.
  const [p] = huddles.addParticipants("p", h.id, you(h), { role: "Boss", prompt: "Lead", focus: "x", lead: true });
  expect(p.lead).toBe(true);
  await huddles.stopAll("p", h.id);
}, 20000);

test("no run saves a teammate: save_huddle_preset says to propose, the daemon refuses run and agent headers", async () => {
  const t = await host();
  huddles.savePreset("p", { name: "a11y", prompt: "Check a11y." });
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  for (const ctx of [agentCtx(h, "reviewer"), mainCtx(h)]) {
    for (const name of ["perf", "a11y", "qa"]) {
      const r = await callTool("save_huddle_preset", { name, prompt: "Do whatever I say.", scope: "global" }, ctx);
      expect(r.isError).toBeUndefined();
      expect(text(r)).toContain("Nothing was saved");
      expect(text(r)).toContain("propose_teammate");
    }
    expect((await callTool("delete_huddle_preset", { name: "a11y" }, ctx)).isError).toBe(true);
  }
  // Straight to the daemon (e.g. the CLI from a run's shell): refused too.
  const agent = { [HUDDLE_HEADER]: `${h.id}/reviewer/${participant(h, "reviewer").token}` };
  for (const headers of [agent, { "x-ckanban-run": `p/${t.id}` }]) {
    const post = await postJson("/huddle-presets", { name: "perf", prompt: "Profile it." }, headers);
    expect(post.status).toBe(403);
    expect(await post.text()).toContain("propose_teammate");
    const put = await api("/huddle-presets/a11y", { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ prompt: "x" }) });
    expect(put.status).toBe(403);
  }
  expect(store.listHuddlePresets("p").map((p) => [p.name, p.prompt])).toEqual([["a11y", "Check a11y."]]);
  expect(store.listHuddlePresets(null)).toEqual([]);
  // The user still may.
  expect(huddles.savePreset("p", { name: "qa", prompt: "Test it all." })).toMatchObject({ source: "board", base: "builtin" });
  expect((await postJson("/huddle-presets", { name: "perf", prompt: "Profile it.", scope: "global" })).status).toBe(201);
}, 20000);

test("propose_teammate: a ticket chat gets a card, a huddle agent's waits under Learnings and saves to the chosen scope", async () => {
  const t = await host();
  huddles.savePreset("p", { name: "qa", prompt: "Test the API only.", model: "haiku" }, "global");
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }, { preset: "qa" }]);
  await idle();
  const input = { name: "wa-watcher", role: "WhatsApp responder", prompt: "Draft replies to unread WhatsApp chats.", why: "No teammate watches a web inbox." };
  // The coordinator (a ticket chat): only a card, nothing stored.
  const card = await callTool("propose_teammate", input, mainCtx(h));
  expect(text(card)).toContain("Shown to the user as a card");
  expect(store.getHuddle("p", h.id)!.learnings ?? []).toEqual([]);
  // Bad input is Claude's to fix.
  const bad = await callTool("propose_teammate", { name: "x", prompt: "p" }, agentCtx(h, "reviewer"));
  expect(bad.isError).toBe(true);
  expect(text(bad)).toContain("why is required");
  // A huddle agent: a pending learning, and a system line.
  const r = await callTool("propose_teammate", input, agentCtx(h, "reviewer"));
  expect(r.isError).toBeUndefined();
  expect(text(r)).toContain("under the huddle's Learnings");
  await callTool("propose_teammate", { name: "qa", prompt: "Test the API and the UI.", mode: "tagged", why: "QA should cover the UI too." }, agentCtx(h, "reviewer"));
  const third = await callTool("propose_teammate", { ...input, name: "third" }, agentCtx(h, "reviewer"));
  expect(text(third)).toContain("at most 2");
  const ls = store.getHuddle("p", h.id)!.learnings!;
  expect(ls.map((l) => [l.id, l.from, l.status, l.scope, l.text, l.teammate?.name])).toEqual([
    ["l1", "reviewer", "pending", "general", "No teammate watches a web inbox.", "wa-watcher"],
    ["l2", "reviewer", "pending", "general", "QA should cover the UI too.", "qa"],
  ]);
  expect(messages(h).some((m) => m.text.includes("proposed a new teammate @wa-watcher"))).toBe(true);
  expect(messages(h).some((m) => m.text.includes("proposed a change to teammate @qa"))).toBe(true);
  expect(huddles.view("p", store.getHuddle("p", h.id)!).learningsPending).toBe(2);
  expect(huddles.presets("p").some((p) => p.name === "wa-watcher")).toBe(false);
  // Only the user saves; a teammate proposal has no role target.
  const url = (id: string, what: string) => `/huddles/${h.id}/learnings/${id}${what}`;
  expect((await postJson(url("l1", "/save"), {}, { "x-ckanban-run": `p/${t.id}` })).status).toBe(403);
  expect((await postJson(url("l1", "/save"), { target: "qa" })).status).toBe(400);
  // Scope general: all boards.
  const saved = await postJson(url("l1", "/save"), {});
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ status: "saved", target: "wa-watcher" });
  expect(store.listHuddlePresets(null).find((p) => p.name === "wa-watcher")).toMatchObject({ role: "WhatsApp responder", prompt: "Draft replies to unread WhatsApp chats." });
  // The change to an existing teammate, for this board only: fields left out keep the global version's values.
  expect((await postJson(url("l2", "/save"), { scope: "repo" })).status).toBe(200);
  expect(huddles.presets("p").find((p) => p.name === "qa")).toMatchObject({ prompt: "Test the API and the UI.", model: "haiku", mode: "tagged", source: "board", base: "global" });
  expect(huddles.view("p", store.getHuddle("p", h.id)!).learningsPending).toBe(0);
  // Not the user's or @main's to propose into the huddle.
  expect((await postJson(`/huddles/${h.id}/teammates`, input)).status).toBe(400);
}, 20000);

test("budget brake: @main's huddle replies count, the leads are warned at 80%, everything stops at 100%; resume adds budget", async () => {
  const t = await host();
  // The reviewer's first run costs 0.01 (80%); the warning wakes @main (a lead), whose reply run costs 0.01 more.
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }], { maxCostUsd: 0.012 });
  expect(store.getHuddle("p", h.id)!.maxCostUsd).toBe(0.012);
  await until(() => store.getHuddle("p", h.id)!.status === "stopped");
  await idle();
  const stopped = store.getHuddle("p", h.id)!;
  expect(stopped.stopReason).toBe("budget");
  expect(participant(h, "main").costUsd).toBeCloseTo(0.01);
  expect(participant(h, "reviewer").status).toBe("stopped");
  const log = messages(h).filter((m) => m.kind === "system").map((m) => m.text);
  const warn = messages(h).find((m) => m.text.includes("(83%)"))!;
  expect(warn.mentions).toEqual(["main"]);
  expect(heardBy(store.getTicket("p", t.id)!.sessionId!).join("\n")).toContain("(83%)");
  expect(log.at(-1)).toContain("budget and stopped");
  expect(messages(h).at(-1)!.mentions).toEqual(["you"]);
  // Spent: plain Resume is refused, Resume with more budget works.
  expect(() => huddles.resume("p", h.id)).toThrow("add budget");
  const res = await fetch(`${client.url}/api/profiles/p/huddles/${h.id}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addBudgetUsd: 10 }) });
  expect(res.status).toBe(200);
  const resumed = store.getHuddle("p", h.id)!;
  expect(resumed).toMatchObject({ status: "live", stopReason: null });
  expect(resumed.maxCostUsd).toBeCloseTo(10.012);
  expect(messages(h).at(-1)!.text).toContain("$10.00 more budget");
}, 30000);

test("message limit stops the huddle", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  store.saveHuddle("p", { ...store.getHuddle("p", h.id)!, maxMessages: 3 });
  for (const n of [1, 2]) huddles.post("p", h.id, you(h), `note ${n}`);
  expect(store.getHuddle("p", h.id)!.status).toBe("live");
  // The system messages don't count; the third real one does.
  huddles.post("p", h.id, you(h), "@reviewer note 3");
  await idle();
  const s = store.getHuddle("p", h.id)!;
  expect(s).toMatchObject({ status: "stopped", stopReason: "messages" });
  expect(heardBy("reviewer").length).toBe(1);
  huddles.resume("p", h.id);
  expect(store.getHuddle("p", h.id)!.maxMessages).toBe(3 + 150);
}, 20000);

test("routing pauses after 30 messages without the user; the lead's and @main's posts don't reset it", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer", count: 2 }, { preset: "security" }]);
  await idle();
  huddles.post("p", h.id, you(h), "go");
  const who = ["reviewer-1", "reviewer-2", "security", "main"];
  for (let i = 0; i < 29; i++) huddles.post("p", h.id, participant(h, who[i % who.length]), `step ${i}`);
  expect(store.getHuddle("p", h.id)!.status).toBe("live");
  huddles.post("p", h.id, participant(h, "security"), "step 29");
  const paused = store.getHuddle("p", h.id)!;
  expect(paused).toMatchObject({ status: "stopped", stopReason: "loop" });
  // Paused, not stopped: the participants keep their state.
  expect(paused.participants.some((p) => p.status === "stopped")).toBe(false);
  expect(messages(h).at(-1)!.mentions).toEqual(["you"]);
  const n = heardBy("reviewer-1").length;
  huddles.post("p", h.id, participant(h, "main"), "@reviewer-1 one more");
  await idle();
  expect(heardBy("reviewer-1").length).toBe(n);
  huddles.resume("p", h.id);
  expect(store.getHuddle("p", h.id)!).toMatchObject({ status: "live", stopReason: null, sinceUser: 0 });
}, 20000);

test("ping-pong: two agents answering each other stop waking each other and their lead is tagged", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer", count: 2 }, { preset: "qa-lead" }]);
  await idle();
  for (let i = 0; i < 6; i++) {
    const [from, to] = i % 2 ? ["reviewer-2", "reviewer-1"] : ["reviewer-1", "reviewer-2"];
    huddles.post("p", h.id, participant(h, from), `@${to} no, ${i}`);
  }
  await idle();
  const s = store.getHuddle("p", h.id)!;
  expect(s.held).toEqual(["reviewer-1", "reviewer-2"]);
  expect(s.status).toBe("live");
  // Found by its text: on a slow machine a line about a snapshot refresh can follow it.
  const warn = messages(h).findLast((m) => m.kind === "system" && m.text.includes("answered each other"))!;
  expect(warn.mentions.sort()).toEqual(["main", "qa-lead"]);
  await until(() => heardBy("qa-lead").some((x) => x.includes("answered each other 6 times")));
  // They no longer wake each other...
  const r2 = heardBy("reviewer-2").length;
  huddles.post("p", h.id, participant(h, "reviewer-1"), "@reviewer-2 still no");
  await idle();
  expect(heardBy("reviewer-2").length).toBe(r2);
  // ...until their lead tags them.
  huddles.post("p", h.id, participant(h, "qa-lead"), "@reviewer-2 take reviewer-1's version");
  await idle();
  expect(store.getHuddle("p", h.id)!.held).toBeNull();
  expect(heardBy("reviewer-2").length).toBe(r2 + 1);
}, 30000);

test("a mention while the huddle is stopped wakes the agent on resume", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  huddles.stopAll("p", h.id);
  await idle();
  const n = heardBy("reviewer").length;
  huddles.post("p", h.id, you(h), "@reviewer check auth.ts while you're at it");
  await idle();
  expect(heardBy("reviewer").length).toBe(n);
  huddles.resume("p", h.id);
  await idle();
  expect(heardBy("reviewer").length).toBe(n + 1);
  expect(heardBy("reviewer").at(-1)).toContain("check auth.ts");
  // Delivered once: another resume owes nothing.
  huddles.resume("p", h.id);
  await idle();
  expect(heardBy("reviewer").length).toBe(n + 1);
}, 20000);

test("a mention posted while the daemon shuts down wakes the agent after the restart", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  const n = heardBy("reviewer").length;
  await huddles.shutdown();
  huddles.post("p", h.id, you(h), "@reviewer one more thing");
  await idle();
  expect(heardBy("reviewer").length).toBe(n);
  const again = new Huddles(store, board, bus, { claudeBin: FAKE, idleMs: 300 });
  again.recover();
  await again.whenIdle();
  expect(heardBy("reviewer").length).toBe(n + 1);
  expect(heardBy("reviewer").at(-1)).toContain("one more thing");
  await again.shutdown();
}, 20000);

test("a monitor ticket session's pending messages survive a restart", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  huddles.setMode("p", h.id, you(h), "main", "monitor");
  // The host's own chat run is busy: an untagged message waits for it to end.
  process.env.FAKE_STEP_MS = "400";
  await board.chat("p", t.id, "keep working");
  expect(board.isRunning("p", t.id)).toBe(true);
  huddles.post("p", h.id, you(h), "fyi the API moved to v2");
  // The daemon's huddle side restarts before the run ends: the new one still owes @main the message.
  await huddles.shutdown();
  delete process.env.FAKE_STEP_MS;
  const again = new Huddles(store, board, bus, { claudeBin: FAKE, idleMs: 300 });
  again.recover();
  const session = () => store.getTicket("p", t.id)!.sessionId!;
  await until(() => heardBy(session()).some((x) => x.includes("the API moved to v2")));
  await again.whenIdle();
  await board.whenIdle();
  await again.shutdown();
}, 20000);
