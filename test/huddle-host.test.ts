// Huddle host: a lead runs the room, so the board's watchdog, notes and warnings wake it instead of @main.
import { expect, test } from "bun:test";
import { callTool } from "../src/mcp-server";
import { HUDDLE_IDLE_MS } from "../src/server/huddle";
import { activeHost, rosterError } from "../src/server/huddle-roster";
import { BUILTIN_TEMPLATES } from "../src/server/huddle-templates";
import { huddleAgentSystemPrompt, huddleMainPrompt } from "../src/server/prompts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentCtx, heardBy, host, huddles, idle, messages, participant, store, until, useHuddleEnv, you } from "./huddle-env";

useHuddleEnv();

const mainHeard = (ticketId: string) => {
  const t = store.getTicket("p", ticketId)!;
  return t.sessionId ? heardBy(t.sessionId) : [];
};
const ROSTER = [{ preset: "reviewer", handle: "a" }, { preset: "reviewer", handle: "b" }, { preset: "qa-lead", handle: "lead", host: true }];

test("a roster names one host (count 1); it is a lead in monitor mode; templates name theirs", () => {
  expect(rosterError([{ preset: "reviewer", host: true }, { preset: "qa", host: true }])).toContain("one host");
  expect(rosterError([{ preset: "reviewer", host: true, count: 2 }])).toContain("count must be 1");
  expect(rosterError([{ preset: "reviewer", host: "yes" }])).toContain("host must be true or false");
  for (const name of ["design-review", "plan-review", "auto-review", "auto-review-important"]) {
    expect(BUILTIN_TEMPLATES.find((t) => t.name === name)!.roster.filter((e) => e.host).length).toBe(1);
  }
});

test("with a host: the 'wasn't woken' note and the idle watchdog wake the host, not @main; a direct tag and the final report wake @main", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, ROSTER);
  expect(store.getHuddle("p", h.id)!.host).toBe("lead");
  expect(participant(h, "lead")).toMatchObject({ lead: true, mode: "monitor" });
  expect(messages(h)[0].text).toContain("@lead hosts");
  await idle();
  await callTool("huddle_status", { status: "done" }, agentCtx(h, "a"));
  await idle();
  // b tags a, who is done: the note goes to the host.
  const lead0 = heardBy("lead").length;
  huddles.post("p", h.id, participant(h, "b"), "@a did you check logout?");
  await idle();
  const note = messages(h).find((m) => m.text.includes("wasn't woken"))!;
  expect(note.text).toBe("@a is done and wasn't woken by @b's tag; @lead or a lead can wake it.");
  expect(note.mentions).toEqual(["lead"]);
  expect(heardBy("lead").length).toBeGreaterThan(lead0);
  expect(store.getTicket("p", t.id)!.sessionStarted).toBeFalsy();
  // A worker speaks last, then nothing happens: the watchdog wakes the host.
  await callTool("huddle_post", { text: "still looks fine" }, agentCtx(h, "b"));
  await idle();
  huddles.idleSweep(Date.now() + HUDDLE_IDLE_MS + 1000);
  const nudge = messages(h).find((m) => m.kind === "system" && m.text.startsWith("Huddle idle"))!;
  expect(nudge.mentions).toEqual(["lead"]);
  await idle();
  expect(store.getTicket("p", t.id)!.sessionStarted).toBeFalsy();
  // The host's own last word doesn't nudge it again.
  await callTool("huddle_post", { text: "waiting on nobody" }, agentCtx(h, "lead"));
  await idle();
  huddles.idleSweep(Date.now() + HUDDLE_IDLE_MS * 3);
  expect(messages(h).filter((m) => m.text.startsWith("Huddle idle")).length).toBe(1);
  // The final report tags @main: @main wakes, and its prompt says the host runs the huddle.
  await callTool("huddle_post", { text: "@main final report: no MUST findings", status: "done" }, agentCtx(h, "lead"));
  await until(() => mainHeard(t.id).length > 0);
  await idle();
  expect(mainHeard(t.id).join("\n")).toContain("final report");
  expect(mainHeard(t.id).join("\n")).toContain("@lead hosts this huddle");
  // The host turning done hands the huddle back to @main quietly (its report already tagged @main); a worker's message
  // waking the done host makes it the host again, without a note either.
  expect(activeHost(store.getHuddle("p", h.id)!)).toBe("main");
  expect(messages(h).some((m) => m.text.includes("(the host) is done"))).toBe(false);
  await callTool("huddle_post", { text: "one more thing I noticed" }, agentCtx(h, "b"));
  await idle();
  expect(activeHost(store.getHuddle("p", h.id)!)).toBe("lead");
  expect(messages(h).some((m) => m.text.includes("is back"))).toBe(false);
}, 40000);

test("with a host: budget warnings go to the host and hand-ins ask the host to decide", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "engineer", handle: "eng" }, { preset: "qa-lead", handle: "lead", host: true }], { maxCostUsd: 0.024 });
  await until(() => messages(h).some((m) => m.text.includes("budget (")));
  await idle();
  const warn = messages(h).find((m) => m.text.includes("budget ("))!;
  expect(warn.mentions).toEqual(["lead"]);
  expect(mainHeard(t.id).join("\n")).not.toContain("budget (");
  huddles.close("p", h.id);
  // A hand-in asks the host to decide; the host accepting it doesn't wake @main.
  const t2 = await host();
  const h2 = huddles.create("p", t2.id, [{ preset: "engineer", handle: "eng" }, { preset: "qa-lead", handle: "lead", host: true }]);
  await idle();
  writeFileSync(join(participant(h2, "eng").copy!.dir, "new.txt"), "hi\n");
  await callTool("huddle_hand_in", { summary: "Add new.txt" }, agentCtx(h2, "eng"));
  await idle();
  const card = messages(h2).find((m) => m.kind === "handin")!;
  expect(card.text).toContain("@lead: accept or reject it");
  expect(card.mentions).toEqual(["lead"]);
  await callTool("huddle_review_changes", { id: "c1", accept: true }, agentCtx(h2, "lead"));
  await idle();
  const accepted = messages(h2).find((m) => m.text.includes("accepted @eng's changes"))!;
  expect(accepted.mentions).toEqual([]);
  expect(store.getTicket("p", t2.id)!.sessionStarted).toBeFalsy();
  huddles.close("p", h2.id);
}, 40000);

test("if the host stops, @main gets the wakes again and a note says so; once it is back, the host gets them", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, ROSTER);
  await idle();
  huddles.stopParticipant("p", h.id, "lead");
  await until(() => messages(h).some((m) => m.text.includes("(the host) is stopped")));
  const note = messages(h).find((m) => m.text.includes("(the host) is stopped"))!;
  expect(note.text).toContain("@main runs the huddle again");
  expect(note.mentions).toEqual(["main"]);
  expect(activeHost(store.getHuddle("p", h.id)!)).toBe("main");
  await until(() => mainHeard(t.id).join("\n").includes("(the host) is stopped"));
  await idle();
  // Notes and the watchdog go to @main now.
  await callTool("huddle_status", { status: "done" }, agentCtx(h, "a"));
  huddles.post("p", h.id, participant(h, "b"), "@a ping");
  await idle();
  expect(messages(h).find((m) => m.text.includes("wasn't woken by @b"))!.mentions).toEqual(["main"]);
  await callTool("huddle_post", { text: "nothing else from me" }, agentCtx(h, "b"));
  await idle();
  huddles.idleSweep(Date.now() + HUDDLE_IDLE_MS + 1000);
  expect(messages(h).findLast((m) => m.text.startsWith("Huddle idle"))!.mentions).toEqual(["main"]);
  await idle();
  // The user restarts the host: it runs the huddle again.
  huddles.restartParticipant("p", h.id, "lead");
  await until(() => messages(h).some((m) => m.text.includes("@lead is back")));
  expect(activeHost(store.getHuddle("p", h.id)!)).toBe("lead");
  await idle();
}, 40000);

test("a blocked host hands the huddle to @main in one note; without a host nothing changes", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, ROSTER);
  await idle();
  await callTool("huddle_status", { status: "blocked", reason: "needs the API key" }, agentCtx(h, "lead"));
  await idle();
  const notes = messages(h).filter((m) => m.text.includes("needs the API key"));
  expect(notes.length).toBe(1);
  expect(notes[0].text).toContain("@lead (the host) is blocked: needs the API key. @main runs the huddle again");
  expect(notes[0].mentions).toEqual(["main"]);
  // A helper blocked while the host runs the room: the host is told, not @main.
  huddles.close("p", h.id);
  const t2 = await host();
  const h2 = huddles.create("p", t2.id, ROSTER);
  await idle();
  await callTool("huddle_status", { status: "blocked", reason: "can't run the tests" }, agentCtx(h2, "a"));
  expect(messages(h2).find((m) => m.text.includes("can't run the tests"))!.mentions).toEqual(["lead"]);
  // No host (a roster the user built without one): @main is tagged as before.
  const t3 = await host();
  const h3 = huddles.create("p", t3.id, [{ preset: "reviewer", handle: "a" }, { preset: "qa-lead", handle: "lead" }]);
  expect(store.getHuddle("p", h3.id)!.host).toBeFalsy();
  await idle();
  await callTool("huddle_status", { status: "blocked", reason: "no access" }, agentCtx(h3, "a"));
  expect(messages(h3).find((m) => m.text.includes("no access"))!.mentions).toEqual(["main"]);
  huddles.close("p", h2.id);
  huddles.close("p", h3.id);
}, 40000);

test("templates and auto huddles start with their first lead as host; a hand-edited file can't change the host", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [], { template: "auto-review" });
  expect(store.getHuddle("p", h.id)!.host).toBe("qa-lead");
  await idle();
  store.saveHuddle("p", { ...store.getHuddle("p", h.id)!, host: "reviewer" });
  expect(huddles.get("p", h.id).host).toBe("qa-lead");
  huddles.close("p", h.id);
  // A custom auto roster with a lead: the lead hosts.
  const t2 = await host();
  const h2 = huddles.create("p", t2.id, [{ preset: "reviewer" }, { preset: "qa" }, { preset: "qa-lead" }], { auto: { reason: "risky", trigger: "security" } });
  expect(store.getHuddle("p", h2.id)!.host).toBe("qa-lead");
  // Agents added later never become the host.
  huddles.addParticipants("p", h2.id, you(h2), { preset: "security", host: true });
  expect(store.getHuddle("p", h2.id)!.host).toBe("qa-lead");
  huddles.close("p", h2.id);
}, 30000);

test("prompts: the host gets the host's job, helpers report to it, @main is told to brief, answer and otherwise end its turn", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, ROSTER);
  await idle();
  const cur = store.getHuddle("p", h.id)!;
  const ticket = store.getTicket("p", t.id)!;
  const lead = huddleAgentSystemPrompt(cur, participant(h, "lead"), ticket, "/out/lead", "/w", "main", "", "/out/huddles/x/summary.md");
  expect(lead).toContain("## You host this huddle");
  expect(lead).toContain("/out/huddles/x/summary.md");
  expect(lead).toContain("pin one consolidated report");
  const helper = huddleAgentSystemPrompt(cur, participant(h, "a"), ticket, "/out/a", "/w");
  expect(helper).not.toContain("## You host this huddle");
  expect(helper).toContain("@lead hosts this huddle: take your tasks from it and report to it, not to @main");
  const main = huddleMainPrompt(cur, participant(h, "main"), "digest");
  expect(main).toContain("@lead hosts this huddle");
  expect(main).toContain("otherwise end your turn without posting");
  expect(main).not.toContain("Your role as coordinator");
  // Back to @main while the host is stopped.
  huddles.stopParticipant("p", h.id, "lead");
  await idle();
  expect(huddleMainPrompt(store.getHuddle("p", h.id)!, participant(h, "main"), "digest")).toContain("so you run the huddle until it is back");
}, 30000);
