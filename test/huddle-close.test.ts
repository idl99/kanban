// Huddles: closing, summaries, pending restarts and the needs-you inbox.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTool } from "../src/mcp-server";
import { Board } from "../src/server/board";
import { fallbackSummary, Huddles, LEGACY_SUMMARY_FILE, summaryFile } from "../src/server/huddle";
import { HUDDLE_HEADER } from "../src/server/huddle-roster";
import type { Huddle } from "../src/server/types";
import { FAKE, git, store, bus, board, huddles, client, idle, heard, heardBy, host, participant, agentCtx, mainCtx, text, you, messages, until, useHuddleEnv } from "./huddle-env";

useHuddleEnv();

test("stop agents and close leave the host's own run and card status alone", async () => {
  const t = await board.createTicket("p", { title: "Implement", body: "do it", status: "backlog" });
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  process.env.FAKE_STEP_MS = "500";
  await board.updateTicket("p", t.id, { status: "ready" });
  await until(() => board.isRunning("p", t.id));
  delete process.env.FAKE_STEP_MS;
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
  huddles.stopAll("p", h.id);
  expect(board.isRunning("p", t.id)).toBe(true);
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
  huddles.resume("p", h.id);
  huddles.close("p", h.id);
  expect(board.isRunning("p", t.id)).toBe(true);
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
  expect(store.getTicket("p", t.id)!.outcome ?? null).not.toBe("stopped");
  await idle();
  expect(store.getTicket("p", t.id)!.status).toBe("review");
}, 30000);

test("the huddle closes when its host ticket moves to Done", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  await board.updateTicket("p", t.id, { status: "done" });
  await until(() => store.getHuddle("p", h.id)!.status === "closed");
  expect(messages(h).some((m) => m.text.includes("host ticket moved to Done"))).toBe(true);
  // A huddle still open on a Done host (the daemon missed the move) closes on recover.
  const t2 = await host();
  const h2 = huddles.create("p", t2.id, [{ preset: "reviewer" }]);
  await idle();
  store.updateTicket("p", t2.id, { status: "done" });
  huddles.recover();
  expect(store.getHuddle("p", h2.id)!.status).toBe("closed");
  await idle();
}, 20000);

test("a huddle started on a Done card survives later updates and restarts, until the card moves to Done again", async () => {
  const t = await host();
  await board.updateTicket("p", t.id, { status: "done" });
  await Bun.sleep(5);
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  // Comments, activity and other patches on the Done card don't close it.
  await board.updateTicket("p", t.id, { title: "Login page v2" });
  store.addComment("p", t.id, "user", "any news?");
  bus.emit({ type: "ticket.updated", profile: "p", ticket: store.getTicket("p", t.id)! });
  await idle();
  expect(store.getHuddle("p", h.id)!.status).not.toBe("closed");
  huddles.recover();
  expect(store.getHuddle("p", h.id)!.status).not.toBe("closed");
  // A real move into Done still closes it.
  await board.updateTicket("p", t.id, { status: "review" });
  await board.updateTicket("p", t.id, { status: "done" });
  await until(() => store.getHuddle("p", h.id)!.status === "closed");
  await idle();
}, 20000);

test("a chat on a Done card that leaves a huddle open lands in Review, even with the stay tag", async () => {
  const t = await host();
  await board.updateTicket("p", t.id, { status: "done" });
  await Bun.sleep(5);
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  process.env.FAKE_EXTRA = "\nStarted a huddle.\n<ckanban-stay/>";
  try {
    await board.chat("p", t.id, "start a huddle on the payment plan");
    await idle();
  } finally {
    delete process.env.FAKE_EXTRA;
  }
  expect(store.getTicket("p", t.id)!.status).toBe("review");
  expect(store.getHuddle("p", h.id)!.status).not.toBe("closed");
  huddles.close("p", h.id);
  await idle();
}, 20000);

test("closing removes helpers' copies whose changes were all handed in, and lists the ones kept", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "engineer", count: 4 }]);
  await idle();
  const repo = store.getProfile("p")!.path;
  const [a, b, c, d] = ["engineer-1", "engineer-2", "engineer-3", "engineer-4"].map((x) => participant(h, x).copy!);
  for (const x of [a, b, c, d]) expect(existsSync(x.dir)).toBe(true);
  // engineer-2 changed a file and never handed it in; engineer-3 handed its change in and it was rejected;
  // engineer-4's hand-in still waits for a decision.
  writeFileSync(join(b.dir, "wip.txt"), "wip");
  writeFileSync(join(c.dir, "done.txt"), "done");
  writeFileSync(join(d.dir, "later.txt"), "later");
  for (const x of ["engineer-3", "engineer-4"]) expect((await callTool("huddle_hand_in", { summary: "work" }, agentCtx(h, x))).isError).toBeUndefined();
  await huddles.reviewHandIn("p", h.id, you(h), "c1", false, "not needed");
  huddles.close("p", h.id);
  await idle();
  for (const x of [a, c]) {
    expect(existsSync(x.dir)).toBe(false);
    expect((await git(repo, "branch", "--list", x.branch!)).trim()).toBe("");
  }
  expect(participant(h, "engineer-1").copy).toBeNull();
  expect(existsSync(b.dir)).toBe(true);
  expect(existsSync(d.dir)).toBe(true);
  expect((await git(repo, "branch", "--list", b.branch!)).trim()).not.toBe("");
  const note = messages(h).at(-1)!.text;
  expect(note).toContain("Removed the copies of the folder of @engineer-1, @engineer-3");
  expect(note).toContain("so nothing is lost");
  expect(note).toContain(`@engineer-2: ${b.dir} (it has changes that were never handed in)`);
  expect(note).toContain(`@engineer-4: ${d.dir} (changes it handed in still wait for a decision)`);
  expect(note.replace(/\/\S+/g, "")).not.toMatch(/branch|worktree|commit|merge/i);
}, 30000);

test("done, blocked and quiet: a done agent only wakes for a lead, @main or the user", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer", count: 2 }]);
  await idle();
  // Everyone answered, nobody works, no open findings: quiet.
  const view = () => huddles.view("p", store.getHuddle("p", h.id)!);
  expect(view().quiet).toBe(true);
  expect(view().idleSince).toBeTruthy();
  // reviewer-1 is done with its last message; reviewer-2 is blocked.
  expect(text(await callTool("huddle_post", { text: "LGTM", status: "done", reason: "reviewed auth" }, agentCtx(h, "reviewer-1")))).toContain("now done");
  expect(participant(h, "reviewer-1")).toMatchObject({ status: "done", statusReason: "reviewed auth" });
  expect((await callTool("huddle_status", { status: "blocked" }, agentCtx(h, "reviewer-2"))).isError).toBe(true);
  expect(text(await callTool("huddle_status", { status: "blocked", reason: "need the API spec" }, agentCtx(h, "reviewer-2")))).toContain("blocked");
  const blocked = messages(h).at(-1)!;
  expect(blocked.text).toContain("@reviewer-2 is blocked: need the API spec");
  expect(blocked.mentions).toEqual(["main"]);
  await idle();
  // A non-lead's tag doesn't wake a done agent...
  const n = heardBy("reviewer-1").length;
  huddles.post("p", h.id, participant(h, "reviewer-2"), "@reviewer-1 did you check logout?");
  await idle();
  expect(heardBy("reviewer-1").length).toBe(n);
  expect(participant(h, "reviewer-1").status).toBe("done");
  // ...and isn't an unanswered tag that keeps the huddle from being quiet.
  expect(view().quiet).toBe(true);
  // An open finding does.
  huddles.findings("p", h.id, you(h), "add", { text: "logout leaks the session" });
  expect(view().quiet).toBe(false);
  huddles.findings("p", h.id, you(h), "resolve", { id: "f1" });
  expect(view().quiet).toBe(true);
  // The user's tag wakes it and ends done.
  huddles.post("p", h.id, you(h), "@reviewer-1 check logout too");
  await idle();
  expect(heardBy("reviewer-1").length).toBe(n + 1);
  expect(participant(h, "reviewer-1")).toMatchObject({ status: "idle", statusReason: null });
  const read = text(await callTool("huddle_read", {}, agentCtx(h, "reviewer-1")));
  expect(read).toContain("@reviewer-2: Code reviewer, tagged, blocked (need the API spec)");
  expect(read).toContain("The huddle is quiet");
}, 30000);

test("huddle_close: only @main and leads ask, after writing the summary; only the user closes", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  const r = await callTool("huddle_close", { reason: "all reviewed" }, agentCtx(h, "reviewer"));
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("only @main or a lead");
  const missing = await callTool("huddle_close", { reason: "all reviewed" }, mainCtx(h));
  expect(missing.isError).toBe(true);
  expect(text(missing)).toContain(summaryFile(h.id));
  mkdirSync(join(store.outputsDir("p", t.id), "huddles", h.id), { recursive: true });
  writeFileSync(join(store.outputsDir("p", t.id), summaryFile(h.id)), "# Summary\n");
  expect(text(await callTool("huddle_close", { reason: "all reviewed" }, mainCtx(h)))).toContain("Only they close it");
  const s = store.getHuddle("p", h.id)!;
  expect(s.status).toBe("live");
  expect(s.closeRequest).toMatchObject({ by: "main", reason: "all reviewed" });
  expect(messages(h).at(-1)!.mentions).toEqual(["you"]);
  // Closing itself stays with the user.
  const res = await fetch(`${client.url}/api/profiles/p/huddles/${h.id}/close`, {
    method: "POST", headers: { "content-type": "application/json", "x-ckanban-run": `p/${t.id}` }, body: "{}",
  });
  expect(res.status).toBe(403);
}, 20000);

test("fallbackSummary: brief, roster with costs, findings, each lead's last word, output files mentioned", () => {
  const h = {
    id: "h_1", hostTicket: "t1", status: "closed", maxParticipants: 8, invited: [], seq: 4, createdAt: "2026-10-10T11:20:00.000Z", updatedAt: "",
    closedAt: "2026-10-10T12:31:00.000Z", brief: { text: "Study the competitor", by: "you", at: "" },
    participants: [
      { handle: "main", kind: "ticket-main", role: "Coordinator", lead: false, status: "idle", costUsd: 1.5 },
      { handle: "research", kind: "agent", role: "Researcher", lead: true, status: "done", costUsd: 2.25 },
      { handle: "qa", kind: "agent", role: "QA", lead: false, status: "done", costUsd: 0.5 },
      { handle: "you", kind: "human", role: "You", lead: false, status: "idle" },
    ],
    findings: [
      { id: "f1", text: "pricing page is slow", by: "research", status: "resolved", resolvedBy: "main", at: "" },
      { id: "f2", text: "no dark mode", by: "main", status: "open", resolvedBy: null, at: "" },
    ],
  } as unknown as Huddle;
  const m = (seq: number, from: string, text: string, kind = "message") => ({ seq, from, text, kind, mentions: [], ts: "" }) as any;
  const msgs = [m(1, "research", "first pass"), m(2, "research", "Report in outputs/research/report.md"), m(3, "qa", "see notes.md"), m(4, "main", "wrapping up")];
  const md = fallbackSummary(h, msgs, ["notes.md", "other.md", summaryFile("h_1")]);
  expect(md).toContain("Study the competitor");
  expect(md).toContain("- @research: Researcher (lead) · done · $2.25");
  expect(md).toContain("$4.25 spent");
  expect(md).toContain("- [x] pricing page is slow (pinned by @research, resolved by @main)");
  expect(md).toContain("- [ ] no dark mode (pinned by @main)");
  expect(md).toContain("### @research (#2)\n\nReport in outputs/research/report.md");
  expect(md).toContain("### @main (#4)");
  expect(md).not.toContain("### @qa");
  expect(md).not.toContain("first pass");
  expect(md).toContain("- notes.md\n- research/report.md");
  expect(md).not.toContain("other.md");
});

test("a huddle closed without a summary gets the board's own when the host can't run; each round keeps its own", async () => {
  const t = await host();
  const h1 = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  huddles.findings("p", h1.id, you(h1), "add", { text: "logout leaks the session" });
  huddles.close("p", h1.id);
  await idle();
  const out = store.outputsDir("p", t.id);
  const first = readFileSync(join(out, summaryFile(h1.id)), "utf8");
  expect(first).toContain("Written by the board");
  expect(first).toContain("logout leaks the session");
  expect(huddles.list("p", t.id).find((x) => x.id === h1.id)!.summary).toBe(summaryFile(h1.id));
  const h2 = huddles.create("p", t.id, [{ preset: "qa" }]);
  await idle();
  expect(huddles.list("p", t.id).find((x) => x.id === h2.id)!.summary).toBeNull();
  huddles.close("p", h2.id);
  await idle();
  expect(existsSync(join(out, summaryFile(h2.id)))).toBe(true);
  expect(readFileSync(join(out, summaryFile(h1.id)), "utf8")).toBe(first);
}, 20000);

test("closing without a summary asks @main to write it; the board writes it if @main's run ends without", async () => {
  const t = await host();
  await board.chat("p", t.id, "hello");
  await idle();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  const before = heard().length;
  huddles.close("p", h.id);
  await until(() => heard().slice(before).some((x) => x.text.includes(`Huddle ${h.id} was closed without a summary`)));
  await idle();
  const file = join(store.outputsDir("p", t.id), summaryFile(h.id));
  await until(() => existsSync(file));
  expect(readFileSync(file, "utf8")).toContain("Written by the board");
}, 20000);

test("a summary in the older single file: a closed huddle reads it, and one written during the huddle becomes its own", async () => {
  const t = await host();
  const out = store.outputsDir("p", t.id);
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  writeFileSync(join(out, LEGACY_SUMMARY_FILE), "# Round summary\n");
  expect(huddles.list("p", t.id)[0].summary).toBeNull();
  huddles.close("p", h.id);
  await idle();
  expect(readFileSync(join(out, summaryFile(h.id)), "utf8")).toBe("# Round summary\n");
  // An old closed huddle with no summary of its own reads the single file.
  const old = { ...store.getHuddle("p", h.id)!, id: "h_old" };
  store.saveHuddle("p", old);
  expect(huddles.list("p", t.id).find((x) => x.id === "h_old")!.summary).toBe(LEGACY_SUMMARY_FILE);
}, 20000);

test("a pending restart waits for huddle agents mid-turn and holds new agent runs until recover", async () => {
  const t = await host();
  process.env.FAKE_STEP_MS = "300";
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }, { preset: "security" }]);
  await until(() => heardBy("reviewer").length === 1);
  let restarted = false;
  board.requestRestart(() => void (restarted = true), 20_000);
  expect(board.restartState()).toMatchObject({ pending: true });
  expect(board.restartState().waiting).toBeGreaterThan(0);
  expect(new Set(board.busyBoards())).toEqual(new Set(["p"]));
  await Bun.sleep(250);
  expect(restarted).toBe(false);
  await until(() => restarted, 10_000);
  delete process.env.FAKE_STEP_MS;
  // While the restart is pending a tag starts no run: the agent is marked so recover() wakes it.
  const n = heardBy("reviewer").length;
  huddles.post("p", h.id, you(h), "@reviewer and the logout flow?");
  await idle();
  expect(heardBy("reviewer").length).toBe(n);
  expect(participant(h, "reviewer").interrupted).toBe(true);
  await huddles.shutdown();
  const fresh = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  const again = new Huddles(store, fresh, bus, { claudeBin: FAKE, idleMs: 300 });
  again.recover();
  await again.whenIdle();
  expect(heardBy("reviewer").length).toBe(n + 1);
  expect(heardBy("reviewer").at(-1)).toContain("the logout flow?");
  expect(heardBy("reviewer").at(-1)).not.toContain("restarted while you were working");
  expect(participant(h, "reviewer").interrupted).toBe(false);
  await Promise.all([fresh.shutdown(), again.shutdown()]);
}, 30000);

test("for you: tags of @you since the user's last post or action, brake messages included", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  const view = () => huddles.view("p", store.getHuddle("p", h.id)!);
  expect(view().forYou).toBe(0);
  huddles.post("p", h.id, participant(h, "reviewer"), "@you is $20 ok?");
  huddles.post("p", h.id, participant(h, "reviewer"), "@main fyi");
  expect(view().forYou).toBe(1);
  // Posting answers it.
  huddles.post("p", h.id, you(h), "yes");
  await idle();
  expect(view()).toMatchObject({ forYou: 0, forYouSince: messages(h).find((m) => m.text === "yes")!.seq });
  // A brake tags @you; acting on it (Resume) clears it.
  store.saveHuddle("p", { ...store.getHuddle("p", h.id)!, maxMessages: 1 });
  huddles.post("p", h.id, participant(h, "reviewer"), "more");
  await idle();
  expect(view()).toMatchObject({ status: "stopped", stopReason: "messages", forYou: 1 });
  huddles.resume("p", h.id);
  expect(view().forYou).toBe(0);
  // Viewing the latest message (the Huddle tab, scrolled down) clears it too, up to the message seen; only the user can.
  huddles.post("p", h.id, participant(h, "reviewer"), "@you one");
  const one = messages(h).at(-1)!.seq;
  huddles.post("p", h.id, participant(h, "reviewer"), "@you two");
  expect(view().forYou).toBe(2);
  const seen = (seq: number, headers: Record<string, string> = {}) =>
    fetch(`${client.url}/api/profiles/p/huddles/${h.id}/seen`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ seq }) });
  expect((await seen(one, { [HUDDLE_HEADER]: `${h.id}/reviewer/${participant(h, "reviewer").token}` })).status).toBe(403);
  const r = await seen(one);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ forYou: 1, forYouSince: one });
  expect((await seen(one - 1)).status).toBe(200);
  expect(view().forYouSince).toBe(one);
  await seen(10_000);
  expect(view()).toMatchObject({ forYou: 0, forYouSince: store.getHuddle("p", h.id)!.seq });
}, 20000);

test("needs you: a working huddle hides its host from the Inbox until it tags @you", async () => {
  const t = await host();
  store.updateTicket("p", t.id, { outcome: "blocked" });
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  const inbox = async () => (await (await fetch(`${client.url}/api/inbox`)).json()) as { id: string; attention: { kind: string; label: string; since: string } }[];
  const card = async () => (await (await fetch(`${client.url}/api/profiles/p/tickets/${t.id}`)).json()) as { attention: { kind: string } | null; huddleBusy: boolean };
  // Idle huddle: the ticket's own state shows.
  expect(huddles.hostStates("p").get(t.id)).toMatchObject({ working: 0, queued: false, tagged: 0 });
  expect((await inbox()).find((i) => i.id === t.id)?.attention.kind).toBe("blocked");
  // Waking the reviewer: the huddle works, the host doesn't need the user and isn't Blocked.
  process.env.FAKE_STEP_MS = "400";
  huddles.post("p", h.id, you(h), "@reviewer look again");
  const busy = huddles.hostStates("p").get(t.id)!;
  expect(busy.working > 0 || busy.queued).toBe(true);
  expect((await inbox()).some((i) => i.id === t.id)).toBe(false);
  expect(await card()).toMatchObject({ attention: null, huddleBusy: true });
  expect(board.waitsOnUser("p", t.id)).toBe(false);
  await idle();
  delete process.env.FAKE_STEP_MS;
  // Tagging @you puts it back, waiting since that message.
  huddles.post("p", h.id, participant(h, "reviewer"), "@you which provider?");
  const row = (await inbox()).find((i) => i.id === t.id)!;
  expect(row.attention).toMatchObject({ kind: "huddle", label: "Huddle: 1 for you", since: messages(h).at(-1)!.ts });
  expect(await card()).toMatchObject({ attention: { kind: "huddle" }, huddleBusy: false });
}, 20000);

test("restart: a failed or stopped agent is idle again and wakes now on a live huddle", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  const n = heardBy("reviewer").length;
  const url = `${client.url}/api/profiles/p/huddles/${h.id}/participants/reviewer/restart`;
  const post = (headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
  // Only a failed or stopped agent restarts.
  expect((await post()).status).toBe(409);
  const x = store.getHuddle("p", h.id)!;
  store.saveHuddle("p", { ...x, participants: x.participants.map((p) => (p.handle === "reviewer" ? { ...p, status: "failed" as const, error: "boom" } : p)) });
  expect((await post()).status).toBe(200);
  await idle();
  expect(participant(h, "reviewer").error).toBeNull();
  expect(heardBy("reviewer").length).toBe(n + 1);
  expect(messages(h).some((m) => m.text === "@reviewer was restarted by @you.")).toBe(true);
  // A run can't restart anyone.
  const denied = await post({ [HUDDLE_HEADER]: `${h.id}/reviewer/${participant(h, "reviewer").token}` });
  expect(denied.status).toBe(403);
}, 20000);
