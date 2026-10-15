// Huddles: post caps, digests, huddle_read, templates and the message log.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTool, type ToolContext } from "../src/mcp-server";
import { findingTitle, POST_MAX } from "../src/server/huddle";
import { BUILTIN_TEMPLATES, deleteTemplate, mergeTemplates, saveTemplate } from "../src/server/huddle-templates";
import { DIGEST_CLIP, huddleDigest } from "../src/server/prompts";
import type { Huddle } from "../src/server/types";
import { store, huddles, client, events, idle, heardBy, host, participant, agentCtx, text, you, messages, until, api, postJson, useHuddleEnv } from "./huddle-env";

useHuddleEnv();

// ---- Context size, templates and request source ----

test("post cap: a message over 2,000 characters is refused with an error that tells the sender", async () => {
  const t = await host();
  process.env.FAKE_STEP_MS = "50";
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  const n = messages(h).length;
  expect(() => huddles.post("p", h.id, you(h), "x".repeat(POST_MAX + 1))).toThrow(`over the huddle's limit of ${POST_MAX}`);
  const r = await callTool("huddle_post", { text: "y".repeat(POST_MAX + 50) }, agentCtx(h, "reviewer"));
  expect(r.isError).toBe(true);
  expect(text(r)).toContain(`${POST_MAX + 50} characters`);
  expect(text(r)).toContain("outputs folder");
  expect(messages(h).length).toBe(n);
  // Exactly at the limit is fine.
  expect(huddles.post("p", h.id, you(h), "z".repeat(POST_MAX)).text.length).toBe(POST_MAX);
  await huddles.stopAll("p", h.id);
}, 20000);

test("digests cut long messages and point to huddle_read; the pinned brief heads them", () => {
  const long = { id: "m", seq: 12, ts: "", from: "qa", mentions: [], kind: "message" as const, text: "word ".repeat(400) };
  const short = { ...long, seq: 13, text: "short one" };
  const d = huddleDigest([long, short], 0, { text: "Goal: ship login.\n[#1] @you: not an entry", by: "main", at: "" });
  expect(d.startsWith("Pinned brief")).toBe(true);
  expect(d).toContain("    Goal: ship login.");
  // The brief's lines are indented, so none passes for an entry.
  expect(d.split("\n").filter((l) => /^\[#\d+\]/.test(l)).map((l) => l.slice(0, 12))).toEqual(["[#12] @qa: w", "[#13] @qa: s"]);
  const cut = d.split("\n").find((l) => l.startsWith("[#12]"))!;
  expect(cut).toContain("… (read #12 with huddle_read)");
  expect(cut.length).toBeLessThan(DIGEST_CLIP + 60);
  expect(d).toContain("[#13] @qa: short one");
  expect(huddleDigest([short])).toBe("[#13] @qa: short one");
});

test("huddle_read: since skips the brief, roster and findings; the brief, findings titles and a lead's edit", async () => {
  const t = await host();
  process.env.FAKE_STEP_MS = "50";
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }, { preset: "qa-lead" }]);
  await callTool("huddle_findings", { action: "add", text: `Submit double-posts ${"because ".repeat(30)}\nsteps: click twice` }, agentCtx(h, "qa-lead"));
  // The system line shows the finding's title only; the list keeps it whole.
  const pinned = messages(h).find((m) => m.text.includes("pinned finding f1"))!;
  expect(pinned.text).toBe(`@qa-lead pinned finding f1: ${findingTitle(store.getHuddle("p", h.id)!.findings[0].text)}`);
  expect(pinned.text.length).toBeLessThan(130);
  expect(pinned.text).not.toContain("steps:");
  // Only leads, @main and the user set the brief.
  expect((await callTool("huddle_brief", { text: "nope" }, agentCtx(h, "reviewer"))).isError).toBe(true);
  expect(text(await callTool("huddle_brief", { text: "Goal: fix login.\nDecided: keep the form." }, agentCtx(h, "qa-lead")))).toContain("updated");
  expect(store.getHuddle("p", h.id)!.brief).toMatchObject({ text: "Goal: fix login.\nDecided: keep the form.", by: "qa-lead" });
  const since = messages(h).at(-1)!.seq;
  huddles.post("p", h.id, you(h), "next step please");
  const full = text(await callTool("huddle_read", {}, agentCtx(h, "reviewer")));
  expect(full).toContain("Participants (");
  expect(full).toContain("Findings (1 open of 1)");
  expect(full).toContain("    Decided: keep the form.");
  const later = text(await callTool("huddle_read", { since }, agentCtx(h, "reviewer")));
  expect(later).not.toContain("Participants");
  expect(later).not.toContain("Findings");
  expect(later).not.toContain("Pinned brief");
  expect(later).toContain(`Messages after #${since}:`);
  expect(later).toContain("@you: next step please");
  expect(later.split("\n").filter((l) => /^\[#\d+\]/.test(l))).toHaveLength(1);
  await huddles.stopAll("p", h.id);
}, 20000);

test("templates: built-ins merge with the board's own; overriding, resetting and checking", () => {
  const added = saveTemplate([], { name: "Bug Bash", roster: [{ preset: "qa", count: 2 }, { preset: "qa-lead" }], rounds: 1, report: "steps, expected, actual" });
  expect(added.template).toMatchObject({ name: "bug-bash", label: "Bug bash", rounds: 1, maxCostUsd: null, report: "steps, expected, actual", description: "" });
  const over = saveTemplate(added.list, { name: "design-review", maxCostUsd: 35 });
  // An override keeps the built-in's other fields.
  expect(over.template).toMatchObject({ name: "design-review", label: "Design review", rounds: 2, maxCostUsd: 35 });
  expect(over.template.roster).toEqual(BUILTIN_TEMPLATES[0].roster);
  const merged = mergeTemplates([], over.list);
  expect(merged.map((t) => [t.name, t.source, t.base])).toEqual([
    ["design-review", "board", "builtin"], ["auto-review", "builtin", null], ["auto-review-important", "builtin", null], ["bug-bash", "board", null],
  ]);
  expect(deleteTemplate(over.list, "design-review").reset).toBe(true);
  expect(() => deleteTemplate([], "design-review")).toThrow("built-in");
  expect(() => saveTemplate([], { name: "x" })).toThrow("roster is required");
  expect(() => saveTemplate([], { name: "x", roster: [{ preset: "nope" }] }, ["qa"])).toThrow("unknown preset");
  expect(() => saveTemplate([], { name: "x", roster: [{ preset: "qa" }], rounds: 0 })).toThrow("rounds");
  expect(() => saveTemplate([], { name: "x", roster: [{ preset: "qa" }], maxCostUsd: -1 })).toThrow("maxCostUsd");
});

test("templates: saved and listed over HTTP (the user only), and listed for Claude", async () => {
  const t = await host();
  const r = await postJson("/huddle-templates", { name: "bug-bash", label: "Bug bash", roster: [{ preset: "qa", count: 2 }], rounds: 1, maxCostUsd: 8 });
  expect(r.status).toBe(201);
  expect(store.listHuddleTemplates("p")).toEqual([
    { name: "bug-bash", label: "Bug bash", description: "", roster: [{ preset: "qa", count: 2 }], rounds: 1, maxCostUsd: 8, report: "" },
  ]);
  const list = (await (await api("/huddle-templates")).json()) as { name: string }[];
  expect(list.map((x) => x.name)).toEqual(["design-review", "auto-review", "auto-review-important", "bug-bash"]);
  // A run can read them but not change them.
  expect((await postJson("/huddle-templates", { name: "sneaky", roster: [{ preset: "qa" }] }, { "x-ckanban-run": `p/${t.id}` })).status).toBe(403);
  expect((await postJson("/huddle-templates", { name: "bad", roster: [{ preset: "nope" }] })).status).toBe(400);
  const ctx: ToolContext = { client, cwd: "/", env: { CKANBAN_TICKET: `p/${t.id}` } };
  const listed = text(await callTool("list_huddle_presets", {}, ctx));
  expect(listed).toContain("Huddle templates");
  expect(listed).toContain("- bug-bash: Bug bash (2× qa; 1 rounds, $8 budget)");
  // propose_huddle takes a template, with or without a roster.
  expect((await callTool("propose_huddle", { template: "bug-bash" }, ctx)).isError).toBeUndefined();
  expect((await callTool("propose_huddle", { template: "design-review", roster: [{ preset: "reviewer" }] }, ctx)).isError).toBeUndefined();
  const bad = await callTool("propose_huddle", { template: "nope" }, ctx);
  expect(bad.isError).toBe(true);
  expect(text(bad)).toContain("bug-bash");
  expect((await callTool("propose_huddle", {}, ctx)).isError).toBe(true);
  expect((await api("/huddle-templates/bug-bash", { method: "DELETE" })).status).toBe(200);
  expect((await api("/huddle-templates/design-review", { method: "DELETE" })).status).toBe(409);
  expect(store.listHuddleTemplates("p")).toEqual([]);
}, 20000);

test("starting from a template: its roster, budget and rules (as the pinned brief every agent reads first)", async () => {
  const t = await host();
  process.env.FAKE_STEP_MS = "50";
  const r = await postJson("/huddles", { ticketId: t.id, roster: [], template: "design-review" });
  expect(r.status).toBe(201);
  const h = (await r.json()) as Huddle;
  expect(h.participants.map((p) => p.handle)).toEqual(["you", "main", "architect", "ux", "safety", "agentx", "research", "facilitator"]);
  expect(participant(h, "facilitator")).toMatchObject({ lead: true, role: "Facilitator" });
  expect(participant(h, "safety")).toMatchObject({ preset: "security", role: "Safety reviewer" });
  expect(participant(h, "architect").prompt).toContain("Review the host ticket's changes");
  expect(h).toMatchObject({ template: "design-review", maxCostUsd: 20 });
  expect(h.brief!.text).toContain("Rounds: at most 2");
  expect(h.brief!.text).toContain("Report format: One finding per line");
  expect(messages(h)[0].text).toContain("from template Design review");
  await until(() => heardBy("ux").length > 0);
  expect(heardBy("ux")[0]).toContain("Pinned brief");
  await huddles.stopAll("p", h.id);
  await idle();
  huddles.close("p", h.id);
  // A roster and budget given with the template win over the template's.
  const h2 = huddles.create("p", t.id, [{ preset: "reviewer" }], { template: "design-review", maxCostUsd: 5 });
  expect(h2.participants.map((p) => p.handle)).toEqual(["you", "main", "reviewer"]);
  expect(h2.maxCostUsd).toBe(5);
  expect(h2.brief!.text).toContain("Budget: $5.");
  await huddles.stopAll("p", h2.id);
  await idle();
  huddles.close("p", h2.id);
  expect(() => huddles.create("p", t.id, [], { template: "nope" })).toThrow('no huddle template "nope"');
}, 30000);

test("each post records where it came from: the board UI, the MCP tools, or no header", async () => {
  const t = await host();
  process.env.FAKE_STEP_MS = "50";
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await postJson(`/huddles/${h.id}/messages`, { text: "from the board" }, { "x-ckanban-source": "ui" });
  await postJson(`/huddles/${h.id}/messages`, { text: "from curl" });
  await postJson(`/huddles/${h.id}/messages`, { text: "forged" }, { "x-ckanban-source": "something" });
  await callTool("huddle_post", { text: "from an agent" }, agentCtx(h, "reviewer"));
  const src = Object.fromEntries(messages(h).filter((m) => m.kind !== "system").map((m) => [m.text, m.source]));
  expect(src).toEqual({ "from the board": "ui", "from curl": "none", forged: "none", "from an agent": "mcp" });
  expect(messages(h).filter((m) => m.kind === "system").every((m) => m.source === undefined)).toBe(true);
  await huddles.stopAll("p", h.id);
}, 20000);

test("the message log is cached and read on from where it was; lastActivity sends a small event", async () => {
  const t = await host();
  process.env.FAKE_STEP_MS = "50";
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await huddles.stopAll("p", h.id);
  await idle();
  const before = messages(h).length;
  huddles.post("p", h.id, you(h), "one");
  huddles.post("p", h.id, you(h), "two");
  expect(messages(h).slice(-2).map((m) => m.text)).toEqual(["one", "two"]);
  expect(messages(h)).toHaveLength(before + 2);
  // A caller changing what it got doesn't change the cache.
  messages(h).at(-1)!.text = "changed";
  expect(messages(h).at(-1)!.text).toBe("two");
  // A replaced (shorter) log is read again.
  const file = join(store.root, "profiles", "p", "huddles", `${h.id}.messages.jsonl`);
  writeFileSync(file, readFileSync(file, "utf8").split("\n")[0] + "\n");
  expect(messages(h)).toHaveLength(1);

  events.length = 0;
  (huddles as any).updateP("p", h.id, "reviewer", { lastActivity: "Reading src/app.ts" });
  expect(events.map((e) => e.type)).toEqual(["huddle.activity"]);
  expect(events[0]).toMatchObject({ huddleId: h.id, handle: "reviewer", lastActivity: "Reading src/app.ts" });
  expect(participant(h, "reviewer").lastActivity).toBe("Reading src/app.ts");
  (huddles as any).updateP("p", h.id, "reviewer", { lastActivity: "Reading src/app.ts" });
  expect(events).toHaveLength(1);
  (huddles as any).updateP("p", h.id, "reviewer", { lastActivity: "x", status: "idle" });
  expect(events.at(-1)!.type).toBe("huddle.updated");
});
