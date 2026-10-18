// Board: branching tickets, background tasks, worktree setup/cleanup and slash commands.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/server/git";
import { tempDir } from "./helpers";
import { store, board, setup, readArgs, untilSpawned, replays, useBoardEnv } from "./board-env";

useBoardEnv();

// ---- Branching ----

/** A Claude session transcript for `sid` that ran in `cwd`, under a temp CLAUDE_CONFIG_DIR. */
function fakeSession(configDir: string, cwd: string, sid: string, text: string): string {
  const dir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, [
    { type: "user", uuid: "u1", sessionId: sid, cwd, timestamp: "2026-10-06T01:00:00Z", message: { role: "user", content: text } },
    { type: "assistant", uuid: "a1", sessionId: sid, cwd: `${cwd}/src`, timestamp: "2026-10-06T01:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

test("branchTicket copies the conversation, committed code, outputs and images into a new Planning ticket", async () => {
  const configDir = tempDir("ck-claude-");
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    await setup();
    const src = await board.createTicket("p", { title: "Add export", body: "", status: "ready", mode: "auto" });
    await board.whenIdle();
    let s = store.getTicket("p", src.id)!;
    // Committed work on the source branch, plus one uncommitted file.
    writeFileSync(join(s.worktree!, "export.ts"), "x\n");
    await run(["git", "add", "."], s.worktree!);
    await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "export"], s.worktree!);
    writeFileSync(join(s.worktree!, "wip.txt"), "wip\n");
    const img = "a".repeat(32) + ".png";
    mkdirSync(store.attachmentsDir, { recursive: true });
    writeFileSync(join(store.attachmentsDir, img), "png");
    s = store.updateTicket("p", src.id, { body: `See ![x](/api/attachments/${img})` });
    fakeSession(configDir, s.worktree!, s.sessionId!, `look at /api/attachments/${img}`);
    writeFileSync(join(store.outputsDir("p", src.id), "report.md"), "# r\n");

    const { ticket: b, warning } = await board.branchTicket("p", src.id);
    expect(warning).toBe("Uncommitted changes in the source were not copied.");
    expect(b).toMatchObject({ title: "Branch: Add export", status: "planning", mode: "auto", branchedFrom: src.id, sessionStarted: true, runCount: 0 });
    expect(b.branchPoint?.sourceTitle).toBe("Add export");
    expect(b.sessionId).not.toBe(s.sessionId);
    expect(b.branch).toBe(`ck/${b.id}-branch-add-export`);
    expect(existsSync(join(b.worktree!, "export.ts"))).toBe(true);
    expect(existsSync(join(b.worktree!, "wip.txt"))).toBe(false);
    // Images: the branch has its own copies.
    const newImg = b.body.match(/attachments\/([0-9a-f]{32}\.png)/)![1];
    expect(newImg).not.toBe(img);
    // The session now lives in the branch's folder under the new id, with ids, cwd and images rewritten.
    const file = join(configDir, "projects", b.worktree!.replace(/[^a-zA-Z0-9]/g, "-"), `${b.sessionId}.jsonl`);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.sessionId)).toEqual([b.sessionId, b.sessionId]);
    expect(lines.map((l) => l.cwd)).toEqual([b.worktree, `${b.worktree}/src`]);
    expect(lines[0].message.content).toBe(`look at /api/attachments/${newImg}`);
    expect(readFileSync(join(store.outputsDir("p", b.id), "report.md"), "utf8")).toBe("# r\n");
    // The source is untouched.
    expect(store.getTicket("p", src.id)).toEqual(s);

    // The next chat resumes the copied session in the branch's worktree; no interview starts on its own.
    expect(board.isRunning("p", b.id)).toBe(false);
    await board.chat("p", b.id, "try another way");
    await board.whenIdle();
    const call = readArgs().at(-1)!;
    expect(call.args).toContain("--resume");
    expect(call.args).toContain(b.sessionId!);
    expect(call.cwd).toBe(b.worktree!);

    // Deleting the source keeps the branch's images.
    await board.deleteTicket("p", src.id);
    expect(existsSync(join(store.attachmentsDir, newImg))).toBe(true);
    expect(existsSync(join(store.attachmentsDir, img))).toBe(false);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test("branchTicket refuses while Claude works, and without a conversation", async () => {
  const configDir = tempDir("ck-claude-");
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    await setup({ git: false });
    const fresh = await board.createTicket("p", { title: "New", body: "", status: "backlog" });
    await expect(board.branchTicket("p", fresh.id)).rejects.toThrow("no Claude conversation");
    process.env.FAKE_MODE = "slow";
    const t = await board.createTicket("p", { title: "Busy", body: "", status: "ready" });
    await untilSpawned();
    const sid = store.getTicket("p", t.id)!.sessionId!;
    fakeSession(configDir, store.getProfile("p")!.path, sid, "hi");
    await expect(board.branchTicket("p", t.id)).rejects.toThrow("branch it once Claude is done");
    expect(store.listTickets("p")).toHaveLength(2);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test("branchTicket of a ticket that ran in place stays in the project folder", async () => {
  const configDir = tempDir("ck-claude-");
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const p = await setup({ git: false });
    const src = await board.createTicket("p", { title: "Notes", body: "", status: "ready" });
    await board.whenIdle();
    const s = store.getTicket("p", src.id)!;
    fakeSession(configDir, p.path, s.sessionId!, "hi");
    const { ticket: b, warning } = await board.branchTicket("p", src.id);
    expect(warning).toContain("no version history");
    expect(b.worktree).toBeNull();
    expect(b.branch).toBeNull();
    expect(existsSync(join(configDir, "projects", p.path.replace(/[^a-zA-Z0-9]/g, "-"), `${b.sessionId}.jsonl`))).toBe(true);
    await board.chat("p", b.id, "go on");
    await board.whenIdle();
    expect(readArgs().at(-1)!.cwd).toBe(p.path);
    expect(readArgs().at(-1)!.args).toContain("--resume");
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test("a run waiting on a background task shows it on the ticket, then finishes with Claude's later turn", async () => {
  await setup();
  process.env.FAKE_MODE = "background";
  process.env.FAKE_BG_MS = "400";
  try {
    const t = await board.createTicket("p", { title: "Scan logs", body: "desc", status: "ready" });
    let seen: any = null;
    for (let i = 0; i < 200 && !seen; i++) {
      seen = store.getTicket("p", t.id)?.waitingOn ?? null;
      await Bun.sleep(10);
    }
    expect(seen?.map((x: any) => x.description)).toEqual(["Count timeouts"]);
    expect(store.getTicket("p", t.id)!.lastActivity).toBe("Waiting for background task: Count timeouts");
    await board.whenIdle();
    const got = store.getTicket("p", t.id)!;
    expect(got.waitingOn ?? null).toBeNull();
    expect(got.outcome).toBe("done");
    expect(store.listComments("p", t.id).at(-1)!.text).toBe("bg done");
  } finally {
    delete process.env.FAKE_BG_MS;
  }
});

test("cleanup command runs in the worktree before it is removed", async () => {
  const p = await setup();
  const marker = join(tempDir("ck-marker-"), "cleaned.txt");
  store.saveProfile({ ...p, cleanupCommand: `pwd > ${marker}` });
  const t = await board.createTicket("p", { title: "Clean", body: "", status: "ready" });
  await board.whenIdle();
  const wt = store.getTicket("p", t.id)!.worktree!;
  await board.updateTicket("p", t.id, { status: "done" });
  expect(existsSync(wt)).toBe(false);
  expect(readFileSync(marker, "utf8").trim()).toBe(wt);
});

/** A user skill in the fake Claude config dir: `/echoargs` then runs as a slash command. */
function userSkill(name: string) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Echo\n---\nSay $ARGUMENTS`);
}

test("a slash command is sent alone; the board's instructions go in the system prompt", async () => {
  await setup();
  userSkill("echoargs");
  const t = await board.createTicket("p", { title: "Idea", body: "", status: "backlog" });
  await board.chat("p", t.id, "/echoargs hello world");
  await board.whenIdle();
  const call = readArgs()[0];
  expect(call.prompt).toBe("/echoargs hello world");
  const system = call.args[call.args.indexOf("--append-system-prompt") + 1];
  expect(system).toContain("slash command");
  expect(system).toContain("<ckanban-context");
  expect(system).toContain("propose_ticket");
  expect(store.getTicket("p", t.id)!.queued ?? []).toEqual([]);

  // Unknown names and paths stay plain messages with the board's note.
  await board.chat("p", t.id, "/notacommand hi");
  await board.whenIdle();
  await board.chat("p", t.id, "/Users/leo/x.ts looks wrong");
  await board.whenIdle();
  for (const c of readArgs().slice(1)) {
    expect(c.args).not.toContain("--append-system-prompt");
    expect(c.prompt).toContain("<ckanban-context");
  }
});

test("a slash command sent while Claude works goes alone too", async () => {
  await setup();
  userSkill("echoargs");
  process.env.FAKE_STEP_MS = "200";
  try {
    const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
    await untilSpawned();
    expect(board.isRunning("p", t.id)).toBe(true);
    await board.chat("p", t.id, "/echoargs steer");
    await board.whenIdle();
    expect(readArgs().length).toBe(1);
    expect(replays(t.id).slice(1)).toEqual(["/echoargs steer"]);
    expect(store.getTicket("p", t.id)!.queued ?? []).toEqual([]);
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
});

test("/compact runs natively without moving the card; /model is the board's; /clear and /resume are refused", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const before = store.getTicket("p", t.id)!;
  expect(before.status).toBe("review");

  await board.chat("p", t.id, "/compact");
  await board.whenIdle();
  let got = store.getTicket("p", t.id)!;
  expect(readArgs()[1].prompt).toBe("/compact");
  expect(got.status).toBe("review");
  expect(got.runCount).toBe(before.runCount);
  expect(got.queued ?? []).toEqual([]);

  await board.chat("p", t.id, "/model sonnet");
  got = store.getTicket("p", t.id)!;
  expect(got.model).toBe("sonnet");
  expect(got.notice).toContain("sonnet");
  expect(readArgs().length).toBe(2);
  await board.chat("p", t.id, "go on");
  await board.whenIdle();
  const call = readArgs()[2];
  expect(call.args[call.args.indexOf("--model") + 1]).toBe("sonnet");
  await board.chat("p", t.id, "/model default");
  expect(store.getTicket("p", t.id)!.model).toBeNull();
  await expect(board.chat("p", t.id, "/model $(rm -rf)")).rejects.toThrow("not a model name");
  // A typo is refused and leaves the model alone.
  await board.chat("p", t.id, "/model claude-opus-5-5");
  await expect(board.chat("p", t.id, "/model sonet")).rejects.toThrow("not a model name");
  expect(store.getTicket("p", t.id)!.model).toBe("claude-opus-5-5");

  // Claude Code's own /clear or /resume would switch sessions behind the board's back.
  for (const cmd of ["/clear", "/resume abc", "/exit"]) {
    await expect(board.chat("p", t.id, cmd)).rejects.toThrow("start a new ticket");
  }
  expect(board.isRunning("p", t.id)).toBe(false);
  expect(store.getTicket("p", t.id)!.sessionId).toBe(before.sessionId);
  expect(readArgs().length).toBe(3);
});

test("bundled Claude Code skills from a run's init event are kept for every ticket", async () => {
  await setup();
  process.env.FAKE_INIT_SKILLS = "simplify,code-review";
  try {
    await board.createTicket("p", { title: "x", body: "", status: "ready" });
    await board.whenIdle();
    const other = await board.createTicket("p", { title: "y", body: "", status: "backlog" });
    expect(board.commands("p", other.id).find((c) => c.name === "simplify")).toMatchObject({ kind: "skill", source: "claude" });
    // Saved, so a new board (a daemon restart) still has them.
    expect(JSON.parse(readFileSync(join(store.root, "claude-commands.json"), "utf8")).bundledSkills).toEqual(["code-review", "simplify"]);
  } finally {
    delete process.env.FAKE_INIT_SKILLS;
  }
});
