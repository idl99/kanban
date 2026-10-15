// Huddles: roster checks, creation, message routing, modes and identity.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { callTool } from "../src/mcp-server";
import { BUILTIN_PRESETS } from "../src/server/huddle-presets";
import { parseMentions, rosterError } from "../src/server/huddle-roster";
import { store, board, huddles, server, client, events, setup, idle, heardBy, processes, host, participant, agentCtx, mainCtx, text, you, messages, until, useHuddleEnv } from "./huddle-env";

useHuddleEnv();

test("parseMentions and roster checks", () => {
  expect(parseMentions("@qa-1 and @Reviewer, cc @all. mail a@b.com, path src/@x")).toEqual(["qa-1", "reviewer", "all"]);
  expect(rosterError([{ preset: "qa", count: 3 }, { preset: "reviewer" }])).toBeNull();
  const names = BUILTIN_PRESETS.map((p) => p.name);
  expect(rosterError([{ preset: "nope" }], 8, names)).toContain("unknown preset");
  // Without the board's names only the shape is checked (the daemon checks names).
  expect(rosterError([{ preset: "nope" }])).toBeNull();
  expect(rosterError([{ preset: "main" }], 8, names)).toContain("coordinator");
  expect(rosterError([{ role: "Accessibility tester", prompt: "Check a11y" }], 8, names)).toBeNull();
  expect(rosterError([{ preset: "qa", count: 8 }])).toContain("over the limit of 8");
  expect(rosterError([{ role: "x", handle: "main" }])).toContain("reserved");
});

test("creating a huddle: @you and @main join, agents start on their job with stamped identity and read-only tools", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }, { preset: "qa", count: 2, focus: "login form" }]);
  expect(h.participants.map((p) => `${p.handle}:${p.kind}:${p.mode}`)).toEqual([
    "you:human:monitor", "main:ticket-main:tagged", "reviewer:agent:tagged", "qa-1:agent:monitor", "qa-2:agent:monitor",
  ]);
  expect(existsSync(store.ticketPath("p", t.id).replace("ticket.md", "")) && store.getHuddle("p", h.id)!.status).toBe("live");
  await idle();
  for (const a of ["reviewer", "qa-1", "qa-2"]) expect(heardBy(a)[0]).toContain(`You just joined the huddle as @${a}`);
  // Agents can't edit tracked files; each gets a snapshot of the host's worktree and its own session.
  const runs = processes();
  expect(runs.length).toBe(3);
  for (const r of runs) {
    expect(r.args).toContain("--disallowedTools");
    expect(r.args[r.args.indexOf("--disallowedTools") + 1]).toBe("Edit,Write,NotebookEdit");
    expect(r.args.join(" ")).toContain("You must NOT edit tracked files");
    expect(r.cwd).not.toBe(store.getTicket("p", t.id)!.worktree);
  }
  expect(new Set(runs.map((r) => r.cwd))).toEqual(new Set(["reviewer", "qa-1", "qa-2"].map((a) => participant(h, a).worktree)));
  expect(new Set(runs.map((r) => r.args[r.args.indexOf("--session-id") + 1])).size).toBe(3);
  // The host's main session was not woken.
  expect(board.isRunning("p", t.id)).toBe(false);
  expect(messages(h)[0]).toMatchObject({ from: "system", kind: "system" });
  expect(events.some((e) => e.type === "huddle.updated")).toBe(true);
  expect(events.some((e) => e.type === "huddle.message")).toBe(true);
  // Tokens never leave the daemon.
  const res = await fetch(`${client.url}/api/profiles/p/huddles/${h.id}`);
  expect(JSON.stringify(await res.json())).not.toContain(participant(h, "qa-1").token!);
}, 20000);

test("routing: tagged sleeps, a mention wakes it, monitors get everything, the sender gets nothing, @all wakes everyone", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }, { preset: "qa", count: 2 }]);
  await idle();
  const before = (who: string) => heardBy(who).length;
  const [r0, q10, q20] = [before("reviewer"), before("qa-1"), before("qa-2")];

  huddles.post("p", h.id, you(h), "hello team");
  await idle();
  expect(heardBy("reviewer").length).toBe(r0);
  expect(heardBy("qa-1").at(-1)).toContain("@you: hello team");
  expect(heardBy("qa-2").at(-1)).toContain("@you: hello team");
  expect(board.isRunning("p", t.id)).toBe(false);
  expect(store.getTicket("p", t.id)!.sessionStarted).toBeFalsy();

  // A mention wakes the tagged reviewer with everything it hasn't read, oldest first.
  huddles.post("p", h.id, you(h), "@reviewer please look at auth.ts");
  await idle();
  const woke = heardBy("reviewer").at(-1)!;
  expect(heardBy("reviewer").length).toBe(r0 + 1);
  expect(woke).toContain("you were tagged");
  expect(woke.indexOf("hello team")).toBeLessThan(woke.indexOf("@reviewer please look"));

  // An agent posts through its MCP tool: it never gets its own message back, the other monitor does.
  const q1 = heardBy("qa-1").length;
  expect(text(await callTool("huddle_post", { text: "found a bug in the form" }, agentCtx(h, "qa-1")))).toContain("as @qa-1");
  await idle();
  expect(heardBy("qa-1").length).toBe(q1);
  expect(heardBy("qa-2").at(-1)).toContain("@qa-1: found a bug in the form");
  expect(heardBy("qa-2").length).toBeGreaterThan(q20);
  expect(heardBy("qa-1").length).toBeGreaterThan(q10);

  // @all wakes the tagged ones too, including @main (the host ticket's own session, as a quiet reply run).
  const r1 = heardBy("reviewer").length;
  huddles.post("p", h.id, you(h), "@all wrap up");
  await until(() => !!store.getTicket("p", t.id)!.sessionStarted);
  await idle();
  expect(heardBy("reviewer").length).toBe(r1 + 1);
  const host1 = store.getTicket("p", t.id)!;
  const mainHeard = heardBy(host1.sessionId!).join("\n");
  expect(mainHeard).toContain("@you: @all wrap up");
  expect(mainHeard).toContain("@qa-1: found a bug in the form");
  // A huddle message leaves the card alone.
  expect(host1.status).toBe("review");
  expect(host1.runCount).toBe(0);
}, 30000);

test("monitor mode: a live session gets messages in its process; mid-turn ones arrive together at the turn boundary", async () => {
  await Promise.all([board.shutdown(), huddles.shutdown()]);
  server.stop(true);
  await setup(5000);
  const t = await host();
  process.env.FAKE_STEP_MS = "250";
  const h = huddles.create("p", t.id, [{ preset: "qa" }]);
  await until(() => heardBy("qa").length === 1);
  // Mid-turn: held back, then handed over as one message.
  huddles.post("p", h.id, you(h), "first note");
  huddles.post("p", h.id, you(h), "second note");
  await Bun.sleep(100);
  expect(heardBy("qa").length).toBe(1);
  await until(() => heardBy("qa").length === 2);
  const batch = heardBy("qa")[1];
  expect(batch).toContain("first note");
  expect(batch).toContain("second note");
  // Idle but still open: the next message goes into the same process.
  await until(() => participant(h, "qa").status === "idle");
  huddles.post("p", h.id, you(h), "third note");
  await until(() => heardBy("qa").length === 3);
  expect(processes().length).toBe(1);
  // Switching to tagged lets the idle session end.
  huddles.setMode("p", h.id, you(h), "qa", "tagged");
  await until(() => participant(h, "qa").status === "idle" && !huddles.isRunning("p", store.getHuddle("p", h.id)!, participant(h, "qa")));
  huddles.post("p", h.id, you(h), "nobody tagged");
  await idle();
  expect(heardBy("qa").length).toBe(3);
}, 30000);

test("sender identity comes from the run, never from tool input", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  await callTool("huddle_post", { text: "I am main", from: "main", sender: "main", handle: "main" }, agentCtx(h, "reviewer"));
  expect(messages(h).at(-1)).toMatchObject({ from: "reviewer", text: "I am main" });
  // A forged token is refused; so is another huddle's agent.
  const forged = agentCtx(h, "reviewer");
  forged.env.CKANBAN_HUDDLE_AGENT = `${h.id}/reviewer/forged`;
  const r = await callTool("huddle_post", { text: "x" }, forged);
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("unknown huddle agent");
  // The host ticket's own run is @main.
  await callTool("huddle_post", { text: "coordinating" }, mainCtx(h));
  expect(messages(h).at(-1)).toMatchObject({ from: "main" });
  // A ticket that isn't in the huddle can't post.
  const other = await board.createTicket("p", { title: "Other", body: "", status: "backlog" });
  const r2 = await callTool("huddle_post", { text: "hi", huddle: h.id }, { client, cwd: "/", env: { CKANBAN_TICKET: `p/${other.id}` } });
  expect(text(r2)).toContain("not in huddle");
  // HTTP without a run header is the user; the body can't pick a sender.
  const res = await fetch(`${client.url}/api/profiles/p/huddles/${h.id}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "from the board", from: "main" }),
  });
  expect(((await res.json()) as any).from).toBe("you");
}, 20000);

test("only leads and the coordinator add participants, and the cap is enforced", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }, { preset: "qa-lead" }], { maxParticipants: 4 });
  await idle();
  const denied = await callTool("huddle_add_participant", { preset: "qa", focus: "forms" }, agentCtx(h, "reviewer"));
  expect(denied.isError).toBe(true);
  expect(text(denied)).toContain("only a lead or @main");
  const ok = await callTool("huddle_add_participant", { preset: "qa", focus: "forms" }, agentCtx(h, "qa-lead"));
  expect(text(ok)).toContain("Added @qa");
  expect(text(ok)).toContain("4/4 participants");
  // Full: the coordinator is refused too, and told to ask the user.
  const full = await callTool("huddle_add_participant", { preset: "qa", focus: "more" }, mainCtx(h));
  expect(full.isError).toBe(true);
  expect(text(full)).toContain("the huddle is full: 4 of 4");
  expect(text(full)).toContain("ask the user");
  expect(() => huddles.invite("p", h.id, you(h), t.id)).toThrow();
  await idle();
  // The new agent started on its job.
  expect(heardBy("qa")[0]).toContain("You just joined the huddle as @qa");
  expect(participant(h, "qa").focus).toBe("forms");
  // A roster over the cap can't start.
  const t2 = await board.createTicket("p", { title: "Second", body: "", status: "review" });
  expect(() => huddles.create("p", t2.id, [{ preset: "qa", count: 4 }], { maxParticipants: 4 })).toThrow("over the limit of 4");
}, 20000);

test("findings: leads and @main manage the pinned list, others can only read it", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "qa" }, { preset: "qa-lead" }]);
  await idle();
  expect((await callTool("huddle_findings", { action: "add", text: "nope" }, agentCtx(h, "qa"))).isError).toBe(true);
  expect(text(await callTool("huddle_findings", { action: "add", text: "Submit button double-posts" }, agentCtx(h, "qa-lead")))).toContain("f1 [open]");
  expect(text(await callTool("huddle_findings", { action: "resolve", id: "f1" }, mainCtx(h)))).toContain("f1 [resolved by @main]");
  expect(text(await callTool("huddle_findings", { action: "list" }, agentCtx(h, "qa")))).toContain("Submit button double-posts");
  const read = text(await callTool("huddle_read", {}, agentCtx(h, "qa")));
  expect(read).toContain("You are @qa.");
  expect(read).toContain("@qa-lead: QA lead, lead, monitor");
  expect(read).toContain("pinned finding f1");
}, 20000);

test("huddle_mode switches your own mode only", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  expect(text(await callTool("huddle_mode", { mode: "monitor" }, agentCtx(h, "reviewer")))).toContain("@reviewer is now in monitor mode");
  expect(participant(h, "reviewer").mode).toBe("monitor");
  expect(() => huddles.setMode("p", h.id, participant(h, "reviewer"), "main", "monitor")).toThrow("your own mode");
  expect(messages(h).at(-1)!.text).toContain("@reviewer switched to monitor mode");
}, 20000);
