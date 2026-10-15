import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board, ConflictError, recoveryFor, SESSION_OPEN_MSG } from "../src/server/board";
import { Bus } from "../src/server/events";
import { run, worktreeDir } from "../src/server/git";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";
import { makeRepo, tempDir } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");

let store: Store;
let bus: Bus;
let board: Board;
let argsFile: string;
let liveSessions: Set<string>;

async function setup(opts: { git?: boolean; maxParallel?: number } = {}): Promise<Profile> {
  const path = opts.git === false ? tempDir("ck-plain-") : await makeRepo();
  const p: Profile = {
    name: "P", slug: "p", path, baseBranch: "main", maxParallel: opts.maxParallel ?? 1,
    model: null, createdAt: new Date().toISOString(),
  };
  store.saveProfile(p);
  return p;
}

function readArgs(): { args: string[]; cwd: string; prompt: string }[] {
  if (!existsSync(argsFile)) return [];
  return readFileSync(argsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  liveSessions = new Set();
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async (id) => liveSessions.has(id) });
  argsFile = join(tempDir("ck-args-"), "args.jsonl");
  process.env.FAKE_ARGS_FILE = argsFile;
  // Fake claude saves its sessions here, so runs can resume them.
  process.env.CLAUDE_CONFIG_DIR = tempDir("ck-claude-");
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_PR = "https://github.com/x/y/pull/7";
});

afterEach(async () => {
  // shutdown(), not stopAll(): stopping frees a slot and would start the next queued (slow) ticket.
  await board.shutdown();
  delete process.env.FAKE_MODE;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.FAKE_PR;
  delete process.env.FAKE_ARGS_FILE;
}, 10000);

test("ready ticket runs to review with PR and AI comment", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Add thing", body: "desc", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("done");
  expect(got.prUrl).toBe("https://github.com/x/y/pull/7");
  expect(got.runCount).toBe(1);
  expect(got.worktree).not.toBeNull();
  expect(existsSync(got.worktree!)).toBe(true);
  expect(got.branch).toStartWith(`ck/${t.id}-add-thing`);
  expect(got.lastActivity).toBe("Finished");
  const comments = store.listComments("p", t.id);
  expect(comments.at(-1)).toMatchObject({ author: "ai", text: "fake done" });
  const call = readArgs()[0];
  expect(call.args).toContain("--session-id");
  expect(call.args).toContain(got.sessionId!);
  expect(call.cwd).toBe(got.worktree!);
  const activity = store.readActivity("p", t.id);
  // The run marker, then the fake claude's events.
  expect(activity[0].event).toEqual({ type: "ckanban_run", kind: "work" });
  expect(activity.length).toBe(6);
});

test("maxParallel limits concurrent runs", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  await Bun.sleep(500);
  expect(board.running("p")).toBe(1);
  expect(store.getTicket("p", b.id)!.status).toBe("ready");
}, 15000);

test("failed run marks outcome failed with stderr", async () => {
  await setup();
  process.env.FAKE_MODE = "fail";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("failed");
  expect(got.error).toContain("boom");
});

test("blocked result marks outcome blocked", async () => {
  await setup();
  process.env.FAKE_MODE = "blocked";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.outcome).toBe("blocked");
});

test("no result line still done with final text comment", async () => {
  await setup();
  process.env.FAKE_MODE = "noresult";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.outcome).toBe("done");
  expect(store.listComments("p", t.id).at(-1)!.text).toBe("All done, no result line.");
});

test("rework resumes session with new user comments", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  await Bun.sleep(5);
  board.addComment("p", t.id, "please use blue");
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(2);
  expect(calls[1].args).toContain("--resume");
  const prompt = calls[1].prompt;
  expect(prompt).toContain("please use blue");
  expect(calls[1].cwd).toBe(calls[0].cwd);
  expect(store.getTicket("p", t.id)!.runCount).toBe(2);
});

test("moving running ticket out of in_progress stops the run", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(500);
  expect(board.running("p")).toBe(1);
  await board.updateTicket("p", t.id, { status: "backlog" });
  await board.whenIdle();
  expect(board.running("p")).toBe(0);
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("backlog");
  expect(got.outcome).toBe("stopped");
}, 15000);

test("stop moves to review with stopped outcome", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(500);
  board.stop("p", t.id);
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("stopped");
}, 15000);

test("stop during worktree setup shows Stopping… and never spawns claude", async () => {
  await setup();
  const seen: (string | null)[] = [];
  bus.on((e) => { if (e.type === "ticket.updated") seen.push(e.ticket.lastActivity); });
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  expect(board.stop("p", t.id)).toBe(true);
  expect(store.getTicket("p", t.id)!.lastActivity).toBe("Stopping…");
  await board.whenIdle();
  expect(readArgs().length).toBe(0);
  expect(seen).toContain("Stopping…");
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("stopped");
  expect(got.lastActivity).toBeNull();
});

test("stop keeps Stopping… on the card while the process shuts down", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(500);
  board.stop("p", t.id);
  expect(store.getTicket("p", t.id)!.lastActivity).toBe("Stopping…");
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.lastActivity).toBeNull();
}, 15000);

test("stop on an in_progress ticket with no live run clears it", async () => {
  await setup();
  const t = store.createTicket("p", { title: "x", body: "", status: "in_progress" });
  expect(board.stop("p", t.id)).toBe(true);
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("stopped");
  expect(store.listComments("p", t.id).some((c) => c.text === "Run stopped by user.")).toBe(true);
});

test("a run stopped before its session was saved doesn't break the next runs", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  process.env.FAKE_NO_SAVE = "1";
  try {
    const t = await board.createTicket("p", { title: "x", body: "", status: "ready", mode: "interview" });
    await Bun.sleep(500);
    board.stop("p", t.id);
    await board.whenIdle();
  } finally {
    delete process.env.FAKE_NO_SAVE;
  }
  process.env.FAKE_MODE = "ok";
  const t = store.listTickets("p")[0];
  // Moving the card to Planning starts the interview, in a new session.
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(2);
  expect(calls[1].args).toContain("--session-id");
  expect(calls[1].args).not.toContain("--resume");
  expect(calls[1].args[calls[1].args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  expect(calls[1].args[calls[1].args.indexOf("--disallowedTools") + 1]).toStartWith("Edit,Write,NotebookEdit,");
  const got = store.getTicket("p", t.id)!;
  expect(got.error).toBeNull();
  expect(got.status).toBe("planning");
  // That session was saved, so the next message resumes it.
  await board.chat("p", t.id, "more");
  await board.whenIdle();
  expect(readArgs()[2].args).toContain("--resume");
}, 15000);

test("a ticket stuck on a missing session heals: the next run starts a new session", async () => {
  await setup();
  const t = store.createTicket("p", { title: "x", body: "", status: "review" });
  // Saved by an older version: marked started, but Claude never saved the session.
  store.updateTicket("p", t.id, { sessionId: crypto.randomUUID(), sessionStarted: true, runCount: 1, error: "No conversation found with session ID: x", outcome: "failed" });
  await board.chat("p", t.id, "go on");
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(1);
  expect(calls[0].args).toContain("--session-id");
  expect(calls[0].args).not.toContain("--resume");
  const got = store.getTicket("p", t.id)!;
  expect(got.error).toBeNull();
  expect(store.listComments("p", t.id).some((c) => c.text.startsWith("Run failed"))).toBe(false);
});

test("Claude not finding a session it should have: retried once in a new session", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const old = store.getTicket("p", t.id)!.sessionId;
  process.env.FAKE_MODE = "nosession";
  await board.chat("p", t.id, "go on");
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(3);
  expect(calls[1].args).toContain("--resume");
  expect(calls[2].args).toContain("--session-id");
  const got = store.getTicket("p", t.id)!;
  expect(got.sessionId).not.toBe(old);
  expect(calls[2].args).toContain(got.sessionId!);
  expect(got.error).toBeNull();
  expect(store.listComments("p", t.id).some((c) => c.text.startsWith("Run failed"))).toBe(false);
});

test("stop with nothing running is a no-op", async () => {
  await setup();
  const t = store.createTicket("p", { title: "x", body: "", status: "backlog" });
  expect(board.stop("p", t.id)).toBe(false);
  expect(store.getTicket("p", t.id)!.status).toBe("backlog");
});

test("recover moves in_progress back to ready and runs", async () => {
  await setup();
  const t = store.createTicket("p", { title: "x", body: "", status: "in_progress" });
  board.recover();
  await Bun.sleep(50);
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(store.listComments("p", t.id)[0].text).toContain("Interrupted by daemon restart");
});

test("non-git profile runs in profile path without worktree", async () => {
  const p = await setup({ git: false });
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBeNull();
  expect(readArgs()[0].cwd).toBe(p.path);
  const prompt = readArgs()[0].prompt;
  expect(prompt).toContain("no version history");
  expect(prompt).not.toContain('report status "blocked"');
});

test("tickets that edit the folder in place run one at a time; a waiting card says why", async () => {
  await setup({ git: false, maxParallel: 3 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  for (let i = 0; i < 100 && readArgs().length < 1; i++) await Bun.sleep(50);
  await Bun.sleep(300);
  expect(board.isRunning("p", a.id)).toBe(true);
  expect(board.isRunning("p", b.id)).toBe(false);
  expect(board.folderWait("p", store.getTicket("p", b.id)!)).toBe(true);
  expect(board.folderWait("p", store.getTicket("p", a.id)!)).toBe(false);
  process.env.FAKE_MODE = "ok";
  board.stop("p", a.id);
  await board.whenIdle();
  expect(store.getTicket("p", b.id)!.outcome).toBe("done");
  const calls = readArgs();
  expect(calls.length).toBe(2);
  expect(calls[1].cwd).toBe(calls[0].cwd);
}, 20000);

test("a reply that would edit the folder while another ticket does waits for it", async () => {
  await setup({ git: false, maxParallel: 3 });
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  await board.whenIdle();
  process.env.FAKE_MODE = "slow";
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  await Bun.sleep(500);
  expect(board.isRunning("p", b.id)).toBe(true);
  const waiting = await board.chat("p", a.id, "one more change");
  expect(board.isRunning("p", a.id)).toBe(false);
  expect(waiting.lastActivity).toBe("waiting: another ticket is using the folder");
  expect(board.folderWait("p", waiting)).toBe(true);
  process.env.FAKE_MODE = "ok";
  board.stop("p", b.id);
  await board.whenIdle();
  expect(readArgs().at(-1)!.prompt).toContain("one more change");
}, 20000);

test("a reply to another session (a huddle) also waits for the folder, without moving the card", async () => {
  await setup({ git: false, maxParallel: 3 });
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  await board.whenIdle();
  process.env.FAKE_MODE = "slow";
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  await Bun.sleep(500);
  expect(board.isRunning("p", b.id)).toBe(true);
  const waiting = await board.chat("p", a.id, "message from a huddle", { peer: true });
  expect(board.isRunning("p", a.id)).toBe(false);
  expect(waiting.status).toBe("review");
  expect(board.folderWait("p", waiting)).toBe(true);
  process.env.FAKE_MODE = "ok";
  board.stop("p", b.id);
  await board.whenIdle();
  expect(readArgs().at(-1)!.prompt).toContain("message from a huddle");
  expect(store.getTicket("p", a.id)!.status).toBe("review");
  expect(store.getTicket("p", a.id)!.slotWait ?? null).toBeNull();
}, 20000);

test("a board with no Workspace setting gives each ticket a worktree", async () => {
  const p = await setup();
  expect(p.workspace).toBeUndefined();
  const t = await board.createTicket("p", { title: "Default", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBe(worktreeDir(p, t.id));
  expect(got.branch).toStartWith(`ck/${t.id}-`);
  expect(readArgs()[0].cwd).toBe(got.worktree!);
});

test("Work in the project folder: no worktree or branch, the folder's HEAD is recorded, no branch or PR instructions", async () => {
  const p = await setup();
  store.saveProfile({ ...p, workspace: "folder" });
  const head = (await run(["git", "rev-parse", "HEAD"], p.path)).stdout.trim();
  const t = await board.createTicket("p", { title: "In folder", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBeNull();
  expect(got.branch).toBeNull();
  expect(got.baseSha).toBe(head);
  expect(existsSync(worktreeDir(p, t.id))).toBe(false);
  expect((await run(["git", "branch", "--list", "ck/*"], p.path)).stdout.trim()).toBe("");
  const { cwd, prompt } = readArgs()[0];
  expect(cwd).toBe(p.path);
  expect(prompt).toContain("Don't create or switch branches");
  expect(prompt).toContain("to the current branch");
  expect(prompt).toContain("uncommitted changes you didn't make");
  expect(prompt).not.toContain("gh pr create");
  expect(prompt).not.toContain("push the branch");
  expect(prompt).not.toContain("feature branch");
  expect(prompt).not.toContain("merge --no-edit");
});

test("Work in the project folder runs tickets one at a time", async () => {
  const p = await setup({ maxParallel: 3 });
  store.saveProfile({ ...p, workspace: "folder" });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  for (let i = 0; i < 100 && readArgs().length < 1; i++) await Bun.sleep(50);
  await Bun.sleep(300);
  expect(board.isRunning("p", a.id)).toBe(true);
  expect(board.isRunning("p", b.id)).toBe(false);
  expect(board.folderWait("p", store.getTicket("p", b.id)!)).toBe(true);
  process.env.FAKE_MODE = "ok";
  board.stop("p", a.id);
  await board.whenIdle();
  expect(store.getTicket("p", b.id)!.outcome).toBe("done");
  expect(readArgs().map((c) => c.cwd)).toEqual([p.path, p.path]);
}, 20000);

test("switching Workspace affects new tickets only: existing worktrees stay, switching back brings worktrees back", async () => {
  const p = await setup({ maxParallel: 3 });
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  await board.whenIdle();
  const wt = store.getTicket("p", a.id)!.worktree!;
  expect(wt).toBe(worktreeDir(p, a.id));
  store.saveProfile({ ...p, workspace: "folder" });
  // The worktree ticket isn't one that edits the folder, so it doesn't hold folder tickets back.
  expect(board.runsInFolder("p", store.getTicket("p", a.id)!)).toBe(false);
  await board.chat("p", a.id, "one more change");
  await board.whenIdle();
  expect(readArgs().at(-1)!.cwd).toBe(wt);
  expect(store.getTicket("p", a.id)!.worktree).toBe(wt);
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  await board.whenIdle();
  expect(store.getTicket("p", b.id)!.worktree).toBeNull();
  expect(readArgs().at(-1)!.cwd).toBe(p.path);
  store.saveProfile({ ...p, workspace: "worktree" });
  const c = await board.createTicket("p", { title: "c", body: "", status: "ready" });
  await board.whenIdle();
  expect(store.getTicket("p", c.id)!.worktree).toBe(worktreeDir(p, c.id));
  // b already worked in the folder: its session belongs there, so it stays.
  await board.chat("p", b.id, "again");
  await board.whenIdle();
  expect(readArgs().at(-1)!.cwd).toBe(p.path);
  expect(store.getTicket("p", b.id)!.worktree).toBeNull();
}, 20000);

test("tickets with worktrees of their own still run side by side", async () => {
  await setup({ maxParallel: 3 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  await Bun.sleep(1500);
  expect(board.isRunning("p", a.id) && board.isRunning("p", b.id)).toBe(true);
  expect(board.folderWait("p", store.getTicket("p", b.id)!)).toBe(false);
}, 20000);

test("repo with no commits runs in the folder with a notice, then worktrees once it has a commit", async () => {
  const p = await setup({ git: false });
  await run(["git", "init", "-q", "-b", "main"], p.path);
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("done");
  expect(got.worktree).toBeNull();
  expect(got.notice).toContain("no commits yet");
  expect(readArgs()[0].cwd).toBe(p.path);

  // A follow-up run stays in the folder: its Claude session lives there.
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  expect(readArgs()[1].cwd).toBe(p.path);

  writeFileSync(join(p.path, "a.txt"), "a\n");
  await run(["git", "add", "."], p.path);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], p.path);
  const t2 = await board.createTicket("p", { title: "y", body: "", status: "ready" });
  await board.whenIdle();
  const got2 = store.getTicket("p", t2.id)!;
  expect(got2.worktree).toBeTruthy();
  expect(readArgs()[2].cwd).toBe(got2.worktree!);
  expect(got2.notice ?? null).toBeNull();
});

test("wrong saved base branch is corrected from the repo", async () => {
  const p = await setup();
  await run(["git", "branch", "-m", "main", "master"], p.path);
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("done");
  expect(got.worktree).toBeTruthy();
  expect(store.getProfile("p")!.baseBranch).toBe("master");
  expect(got.notice).toContain('"master"');
  await board.updateTicket("p", t.id, { notice: null });
  expect(store.getTicket("p", t.id)!.notice).toBeNull();
});

test("refine that cannot start can be retried by moving into Planning again", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  // Make worktree creation fail: a branch nested under the ticket's branch name blocks creating it.
  const blocker = `ck/${t.id}-x/blocker`;
  await run(["git", "branch", blocker], p.path);
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  let got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("failed");
  expect(got.refineStarted).toBe(false);
  expect(store.listComments("p", t.id).at(-1)!.text).toContain("Could not start");
  await run(["git", "branch", "-D", blocker], p.path);
  await board.updateTicket("p", t.id, { status: "backlog" });
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBeTruthy();
  expect(got.refineStarted).toBe(true);
});

test("moving to done removes clean worktree", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const wt = store.getTicket("p", t.id)!.worktree!;
  await board.updateTicket("p", t.id, { status: "done" });
  expect(existsSync(wt)).toBe(false);
  expect(store.getTicket("p", t.id)!.worktree).toBeNull();
});

async function doneAndBack(id: string) {
  await board.updateTicket("p", id, { status: "done" });
  expect(store.getTicket("p", id)!.worktree).toBeNull();
  await board.updateTicket("p", id, { status: "ready" });
  await board.whenIdle();
}

test("a ticket moved back from done gets its worktree back on its branch and resumes its session", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "Reopen", body: "", status: "ready" });
  await board.whenIdle();
  const first = store.getTicket("p", t.id)!;
  await doneAndBack(t.id);
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBe(worktreeDir(p, t.id));
  expect(existsSync(got.worktree!)).toBe(true);
  expect(got.branch).toBe(first.branch);
  expect((await run(["git", "branch", "--show-current"], got.worktree!)).stdout.trim()).toBe(first.branch!);
  const call = readArgs().at(-1)!;
  expect(call.cwd).toBe(got.worktree!);
  expect(call.args).toContain("--resume");
  expect(call.args).toContain(first.sessionId!);
  expect(got.outcome).toBe("done");
});

test("a reopened ticket whose branch was renamed takes the renamed branch", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "Rename", body: "", status: "ready" });
  await board.whenIdle();
  const first = store.getTicket("p", t.id)!;
  await board.updateTicket("p", t.id, { status: "done" });
  await run(["git", "branch", "-m", first.branch!, `ck/${t.id}-renamed`], p.path);
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.branch).toBe(`ck/${t.id}-renamed`);
  expect(got.worktree).toBe(worktreeDir(p, t.id));
  expect(got.notice ?? null).toBeNull();
});

test("a reopened ticket whose branch is gone starts again from base with a notice", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "Gone", body: "", status: "ready" });
  await board.whenIdle();
  const first = store.getTicket("p", t.id)!;
  await board.updateTicket("p", t.id, { status: "done" });
  await run(["git", "branch", "-D", first.branch!], p.path);
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBe(worktreeDir(p, t.id));
  expect(got.branch).toBe(first.branch);
  expect(got.notice).toContain("was not found");
  expect(readArgs().at(-1)!.cwd).toBe(got.worktree!);
});

test("a ticket that ran in the project folder keeps running there", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "In place", body: "", status: "backlog" });
  store.updateTicket("p", t.id, { runCount: 1, sessionStarted: true });
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBeNull();
  expect(readArgs().at(-1)!.cwd).toBe(p.path);
});

test("startup sweep removes worktrees of done and deleted tickets, keeps dirty and active ones", async () => {
  const p = await setup({ maxParallel: 4 });
  const mk = async (title: string) => {
    const t = await board.createTicket("p", { title, body: "", status: "ready" });
    await board.whenIdle();
    return store.getTicket("p", t.id)!;
  };
  const done = await mk("Done");
  const dirty = await mk("Dirty");
  const review = await mk("Review");
  const deleted = await mk("Deleted");
  // Orphans: Done tickets whose folder outlived the cleanup, and a folder whose ticket is gone.
  store.updateTicket("p", done.id, { status: "done", worktree: null });
  writeFileSync(join(dirty.worktree!, "wip.txt"), "wip\n");
  store.updateTicket("p", dirty.id, { status: "done" });
  store.deleteTicket("p", deleted.id);
  // A worktree outside the board's folder is never touched.
  const outside = join(tempDir("ck-outside-"), "wt");
  await run(["git", "worktree", "add", "-q", "-b", "other", outside, "main"], p.path);

  await board.sweepWorktrees();
  expect(existsSync(done.worktree!)).toBe(false);
  expect(existsSync(deleted.worktree!)).toBe(false);
  expect(existsSync(dirty.worktree!)).toBe(true);
  expect(store.getTicket("p", dirty.id)!.worktree).toBe(dirty.worktree);
  expect(existsSync(review.worktree!)).toBe(true);
  expect(existsSync(outside)).toBe(true);
  // Branches stay: they are the undo.
  expect((await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${done.branch}`], p.path)).code).toBe(0);
  expect((await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${deleted.branch}`], p.path)).code).toBe(0);
}, 20000);

test("startup sweep clears the worktree of a done ticket once it is clean", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Later", body: "", status: "ready" });
  await board.whenIdle();
  const wt = store.getTicket("p", t.id)!.worktree!;
  store.updateTicket("p", t.id, { status: "done" });
  await board.sweepWorktrees();
  expect(existsSync(wt)).toBe(false);
  expect(store.getTicket("p", t.id)!.worktree).toBeNull();
});

test("planningCommand creates session + worktree", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Plan me", body: "", status: "planning" });
  const cmd = await board.planningCommand("p", t.id);
  const got = store.getTicket("p", t.id)!;
  expect(got.sessionId).not.toBeNull();
  expect(existsSync(got.worktree!)).toBe(true);
  expect(cmd).toContain(`--session-id ${got.sessionId}`);
  expect(cmd).toContain(store.ticketPath("p", t.id));
});

test("emits ticket.updated events", async () => {
  await setup();
  const seen: string[] = [];
  bus.on((e) => { if (e.type === "ticket.updated") seen.push(e.ticket.status); });
  await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  expect(seen).toContain("in_progress");
  expect(seen.at(-1)).toBe("review");
});

test("shutdown leaves running ticket in_progress for recovery", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(500);
  await board.shutdown();
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
}, 15000);

test("moving a running ticket to ready restarts it and keeps in_progress", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(500);
  await board.updateTicket("p", t.id, { status: "ready" });
  await Bun.sleep(200);
  expect(board.isRunning("p", t.id)).toBe(true);
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
}, 15000);

test("shutdown during worktree setup never spawns claude", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.shutdown();
  await Bun.sleep(300);
  expect(readArgs().length).toBe(0);
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
});

test("body update with stale expectedBody is rejected", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "old", status: "planning" });
  store.updateTicket("p", t.id, { body: "plan from claude" });
  await expect(board.updateTicket("p", t.id, { body: "mine", expectedBody: "old" })).rejects.toThrow(/changed/);
  expect(store.getTicket("p", t.id)!.body).toBe("plan from claude");
  await board.updateTicket("p", t.id, { body: "mine", expectedBody: "plan from claude" });
  expect(store.getTicket("p", t.id)!.body).toBe("mine");
});

test("linked session runs in profile folder with --resume and no worktree", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "OS status", body: "", status: "review" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  const linked = store.getTicket("p", t.id)!;
  expect(linked.sessionId).toBe("11111111-2222-3333-4444-555555555555");
  expect(linked.workdir).toBe(p.path);
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const call = readArgs()[0];
  expect(call.cwd).toBe(p.path);
  expect(call.args).toContain("--resume");
  expect(call.args).toContain("11111111-2222-3333-4444-555555555555");
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBeNull();
  expect(got.status).toBe("review");
});

test("run refuses when the linked session is still open in a terminal", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "review" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  liveSessions.add("11111111-2222-3333-4444-555555555555");
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  expect(readArgs().length).toBe(0);
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("blocked");
  expect(store.listComments("p", t.id).at(-1)!.text).toContain("still open in a terminal");
});

test("done on linked ticket never removes the profile folder", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "review" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  await board.updateTicket("p", t.id, { status: "done" });
  expect(existsSync(p.path)).toBe(true);
});

test("cannot link while running", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(300);
  await expect(board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555")).rejects.toThrow(/running/);
}, 15000);

test("interview ticket asking questions lands in review as needs_input", async () => {
  await setup();
  process.env.FAKE_MODE = "questions";
  const t = await board.createTicket("p", { title: "explore", body: "", status: "ready", mode: "interview" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.mode).toBe("interview");
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("needs_input");
  expect(got.interviewed).toBe(true);
  expect(readArgs()[0].prompt).toContain("interview first");
  const c = store.listComments("p", t.id).at(-1)!;
  expect(c.text).toContain("Work complete.");
  expect(c.text).not.toContain("CKANBAN_RESULT");
});

test("runs get an outputs folder and deliverables are listed", async () => {
  await setup();
  process.env.FAKE_OUTPUT = "# Report\nTL;DR";
  try {
    const t = await board.createTicket("p", { title: "research", body: "", status: "ready" });
    await board.whenIdle();
    const outs = store.listOutputs("p", t.id);
    expect(outs.map((o) => o.name)).toEqual(["report.md"]);
    expect(store.outputPath("p", t.id, "report.md")).not.toBeNull();
    expect(store.outputPath("p", t.id, "../ticket.md")).toBeNull();
  } finally {
    delete process.env.FAKE_OUTPUT;
  }
});

test("chat in Planning refines read-only and keeps the card in place", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "App idea", body: "habit tracker", status: "backlog" });
  await board.chat("p", t.id, "Help me shape this idea");
  expect(board.isRunning("p", t.id)).toBe(true);
  expect(board.running("p")).toBe(0);
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("backlog");
  expect(got.runCount).toBe(0);
  expect(got.sessionStarted).toBe(true);
  const call = readArgs()[0];
  expect(call.args[call.args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  expect(call.args[call.args.indexOf("--disallowedTools") + 1]).toStartWith("Edit,Write,NotebookEdit,");
  // The planning tools come from the board's own MCP server, whatever the user registered.
  expect(JSON.parse(call.args[call.args.indexOf("--mcp-config") + 1]).mcpServers.ckanban.args.at(-1)).toBe("mcp");
  const prompt = call.prompt;
  expect(prompt.startsWith("Help me shape this idea")).toBe(true);
  expect(prompt).toContain("<ckanban-context");
  expect(prompt).toContain("propose_ticket");
  expect(prompt).toContain("<ckanban-ticket>");
  // second message resumes the same session
  await board.chat("p", t.id, "Just for me");
  await board.whenIdle();
  expect(readArgs()[1].args).toContain("--resume");
});

test("planning replies save their mockup blocks to outputs/mockups; work runs don't", async () => {
  await setup();
  process.env.FAKE_EXTRA = '\n<ckanban-mockup name="a-compact.html"><!doctype html><p>A</p></ckanban-mockup>';
  try {
    const t = await board.createTicket("p", { title: "New sidebar", body: "d", status: "backlog" });
    await board.chat("p", t.id, "Show me options");
    await board.whenIdle();
    const file = join(store.outputsDir("p", t.id), "mockups", "a-compact.html");
    expect(readFileSync(file, "utf8")).toBe("<!doctype html><p>A</p>\n");
    const w = await board.createTicket("p", { title: "Work", body: "d", status: "review" });
    await board.chat("p", w.id, "tweak it");
    await board.whenIdle();
    expect(existsSync(join(store.outputsDir("p", w.id), "mockups"))).toBe(false);
  } finally {
    delete process.env.FAKE_EXTRA;
  }
});

test("runStartedAt is set while Claude works and cleared after, for runs and chat replies", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Timed", body: "d", status: "backlog" });
  const started: (string | null | undefined)[] = [];
  bus.on((e) => { if (e.type === "ticket.updated" && e.ticket.id === t.id) started.push(e.ticket.runStartedAt); });
  await board.chat("p", t.id, "Shape it");
  expect(store.getTicket("p", t.id)!.runStartedAt).toBeString();
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.runStartedAt).toBeNull();
  expect(started.at(-1)).toBeNull();
  const r = await board.createTicket("p", { title: "Queued", body: "d", status: "ready" });
  expect(store.getTicket("p", r.id)!.runStartedAt).toBeString();
  await board.whenIdle();
  const got = store.getTicket("p", r.id)!;
  expect(got.status).toBe("review");
  expect(got.runStartedAt).toBeNull();
});

test("chat in Review acts right away: In Progress then back to Review", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  await board.chat("p", t.id, "Please also add tests");
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.runCount).toBe(2);
  const call = readArgs()[1];
  expect(call.args).toContain("--resume");
  expect(call.args[call.args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  expect(call.args).not.toContain("--disallowedTools");
  expect(call.prompt.startsWith("Please also add tests")).toBe(true);
});

const replays = (id: string) =>
  store.readActivity("p", id).map((a: any) => a.event ?? a).filter((e: any) => e.type === "user" && e.isReplay)
    .map((e: any) => e.message.content[0].text as string);

test("chat while Claude works steers the run instead of restarting it", async () => {
  await setup();
  process.env.FAKE_STEP_MS = "200";
  try {
    const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
    await Bun.sleep(400);
    expect(board.isRunning("p", t.id)).toBe(true);
    await board.chat("p", t.id, "also add a test for X");
    await board.chat("p", t.id, "and Y");
    await board.whenIdle();
    expect(readArgs().length).toBe(1);
    const steered = replays(t.id).slice(1);
    expect(steered.map((m) => m.split("\n")[0])).toEqual(["also add a test for X", "and Y"]);
    expect(steered[0]).toContain("<ckanban-context");
    const got = store.getTicket("p", t.id)!;
    expect(got.status).toBe("review");
    expect(got.outcome).toBe("done");
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
}, 15000);

test("chat sent while the run is still starting is delivered once claude is up", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  // Worktree setup is still running: there is no claude process yet.
  await board.chat("p", t.id, "early note");
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
  expect(replays(t.id).slice(1).map((m) => m.split("\n")[0])).toEqual(["early note"]);
});

test("chat that arrives as the run finishes gets a follow-up reply", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  let sent = false;
  bus.on((e) => {
    if (e.type === "activity" && e.id === t.id && (e.event as any)?.type === "result" && !sent) {
      sent = true;
      board.chat("p", t.id, "late thought");
    }
  });
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(2);
  expect(calls[1].args).toContain("--resume");
  expect(calls[1].prompt.startsWith("late thought")).toBe(true);
  expect(store.getTicket("p", t.id)!.status).toBe("review");
});

test("chat is rejected while Claude is stopping", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.chat("p", t.id, "hi");
  await Bun.sleep(300);
  board.stop("p", t.id);
  await expect(board.chat("p", t.id, "again")).rejects.toThrow(/stopping/);
}, 15000);

test("steering messages are saved on the ticket until Claude reads them", async () => {
  await setup();
  process.env.FAKE_STEP_MS = "300";
  try {
    const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
    await Bun.sleep(400);
    const after = await board.chat("p", t.id, "also X");
    expect(after.queued).toMatchObject([{ text: "also X", state: "queued" }]);
    expect(store.getTicket("p", t.id)!.queued).toHaveLength(1);
    await board.whenIdle();
    expect(store.getTicket("p", t.id)!.queued).toEqual([]);
    expect(replays(t.id).slice(1).map((m) => m.split("\n")[0])).toEqual(["also X"]);
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
}, 15000);

test("Stop keeps unread messages as unsent; send or discard them later", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(400);
  await board.chat("p", t.id, "first");
  await board.chat("p", t.id, "second");
  board.stop("p", t.id);
  await board.whenIdle();
  const q = store.getTicket("p", t.id)!.queued!;
  expect(q.map((m) => [m.text, m.state])).toEqual([["first", "unsent"], ["second", "unsent"]]);

  board.discardQueued("p", t.id, q[1].id);
  expect(store.getTicket("p", t.id)!.queued!.map((m) => m.text)).toEqual(["first"]);

  process.env.FAKE_MODE = "ok";
  await board.sendQueued("p", t.id, q[0].id);
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.queued).toEqual([]);
  const calls = readArgs();
  expect(calls.at(-1)!.prompt.startsWith("first")).toBe(true);
  expect(() => board.discardQueued("p", t.id, q[0].id)).toThrow(/not found/);
}, 15000);

test("daemon restart keeps unread messages and delivers them after recovery", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const work = await board.createTicket("p", { title: "work", body: "", status: "ready" });
  await Bun.sleep(400);
  await board.chat("p", work.id, "keep going with Y");
  await board.shutdown();
  expect(store.getTicket("p", work.id)!.queued).toMatchObject([{ text: "keep going with Y", state: "queued" }]);
  // A chat reply that was cut off too, on a ticket recover() does not resume.
  const chatTicket = await board.createTicket("p", { title: "chat", body: "", status: "review" });
  store.updateTicket("p", chatTicket.id, { queued: [{ id: "m1", text: "what about Z?", at: new Date().toISOString(), state: "queued" }] });

  process.env.FAKE_MODE = "ok";
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  board.recover();
  await board.whenIdle();
  expect(store.getTicket("p", work.id)!.queued).toEqual([]);
  expect(replays(work.id).some((m) => m.startsWith("keep going with Y"))).toBe(true);
  expect(store.getTicket("p", chatTicket.id)!.queued).toEqual([]);
  expect(readArgs().some((c) => c.prompt?.startsWith("what about Z?"))).toBe(true);
}, 20000);

test("a chat reply that resumes work waits for a free slot, then starts before Ready tickets", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const r = await board.createTicket("p", { title: "r", body: "", status: "review" });
  await Bun.sleep(300);
  await board.chat("p", r.id, "go on with it");
  const waiting = store.getTicket("p", r.id)!;
  expect(board.isRunning("p", r.id)).toBe(false);
  expect(waiting.status).toBe("in_progress");
  expect(waiting.slotWait?.from).toEqual({ status: "review", outcome: null });
  expect(waiting.queued).toMatchObject([{ text: "go on with it", state: "queued" }]);
  expect(board.running("p")).toBe(1);
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });

  board.stop("p", a.id);
  await Bun.sleep(1000);
  expect(board.isRunning("p", r.id)).toBe(true);
  expect(board.holdsSlot("p", r.id)).toBe(true);
  expect(store.getTicket("p", r.id)!.slotWait).toBeNull();
  expect(store.getTicket("p", b.id)!.status).toBe("ready");
  expect(board.running("p")).toBe(1);
  expect(readArgs().at(-1)!.prompt.startsWith("go on with it")).toBe(true);
}, 15000);

test("steering a running ticket takes no extra slot", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  await Bun.sleep(300);
  await board.chat("p", a.id, "also do X");
  expect(board.running("p")).toBe(1);
  expect(store.getTicket("p", a.id)!.slotWait).toBeFalsy();
}, 15000);

test("Stop on a reply waiting for a slot puts the card back and keeps the message unsent", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const r = await board.createTicket("p", { title: "r", body: "", status: "review" });
  await Bun.sleep(300);
  await board.chat("p", r.id, "go on with it");
  expect(board.stop("p", r.id)).toBe(true);
  const got = store.getTicket("p", r.id)!;
  expect(got.status).toBe("review");
  expect(got.slotWait).toBeNull();
  expect(got.queued).toMatchObject([{ text: "go on with it", state: "unsent" }]);

  board.stop("p", a.id);
  await board.whenIdle();
  expect(board.isRunning("p", r.id)).toBe(false);
  expect(readArgs().some((c) => c.prompt?.startsWith("go on with it"))).toBe(false);
}, 15000);

test("a reply waiting for a slot can be edited; Claude gets the edited text", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const r = await board.createTicket("p", { title: "r", body: "", status: "review" });
  await Bun.sleep(300);
  await board.chat("p", r.id, "go on with it");
  const [msg] = store.getTicket("p", r.id)!.queued!;
  expect(() => board.editQueued("p", r.id, msg.id, "  ")).toThrow(/empty/);
  board.editQueued("p", r.id, msg.id, "go on, and add a test");
  expect(store.getTicket("p", r.id)!.queued).toMatchObject([{ id: msg.id, text: "go on, and add a test", state: "queued" }]);

  board.stop("p", a.id);
  await Bun.sleep(1000);
  expect(board.isRunning("p", r.id)).toBe(true);
  expect(readArgs().at(-1)!.prompt.startsWith("go on, and add a test")).toBe(true);
  // Now it is Claude's prompt: too late to change it.
  expect(() => board.editQueued("p", r.id, msg.id, "other")).toThrow();
}, 15000);

test("discarding the only reply waiting for a slot puts the card back", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const r = await board.createTicket("p", { title: "r", body: "", status: "review" });
  await Bun.sleep(300);
  await board.chat("p", r.id, "go on with it");
  const [msg] = store.getTicket("p", r.id)!.queued!;
  const got = board.discardQueued("p", r.id, msg.id);
  expect(got).toMatchObject({ status: "review", slotWait: null, queued: [] });
}, 15000);

test("a message steered into a running Claude can't be edited; an unsent one can", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(400);
  await board.chat("p", t.id, "first");
  const [msg] = store.getTicket("p", t.id)!.queued!;
  expect(() => board.editQueued("p", t.id, msg.id, "changed")).toThrow(ConflictError);
  expect(() => board.discardQueued("p", t.id, msg.id)).toThrow(ConflictError);
  board.stop("p", t.id);
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.queued).toMatchObject([{ id: msg.id, state: "unsent" }]);
  board.editQueued("p", t.id, msg.id, "first, fixed");
  process.env.FAKE_MODE = "ok";
  await board.sendQueued("p", t.id, msg.id);
  await board.whenIdle();
  expect(readArgs().at(-1)!.prompt.startsWith("first, fixed")).toBe(true);
  expect(() => board.editQueued("p", t.id, "nope", "x")).toThrow(/not found/);
}, 15000);

test("a peer message waiting for a slot can't be edited", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "review" });
  store.updateTicket("p", t.id, { queued: [{ id: "m1", text: "from a peer", at: new Date().toISOString(), state: "queued", peer: true }] });
  expect(() => board.editQueued("p", t.id, "m1", "changed")).toThrow(ConflictError);
});

test("after a restart, waiting replies still respect maxParallel", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const r = await board.createTicket("p", { title: "r", body: "", status: "review" });
  await Bun.sleep(300);
  await board.chat("p", r.id, "go on with it");
  await board.shutdown();
  // A message a restart left undelivered on another Review card.
  const c = await board.createTicket("p", { title: "c", body: "", status: "review" });
  store.updateTicket("p", c.id, { queued: [{ id: "m1", text: "what about Z?", at: new Date().toISOString(), state: "queued" }] });

  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  board.recover();
  await Bun.sleep(300);
  expect(board.running("p")).toBe(1);
  // The waiting reply goes first; the interrupted work run and the other reply wait.
  expect(board.isRunning("p", r.id)).toBe(true);
  expect(store.getTicket("p", a.id)!.status).toBe("ready");
  expect(board.isRunning("p", c.id)).toBe(false);
  expect(store.getTicket("p", c.id)!).toMatchObject({ status: "in_progress", slotWait: { from: { status: "review" } } });
}, 20000);

test("refine chat does not take a queue slot", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "plan", body: "", status: "backlog" });
  await board.chat("p", a.id, "hi");
  const b = await board.createTicket("p", { title: "work", body: "", status: "ready" });
  await Bun.sleep(300);
  expect(store.getTicket("p", b.id)!.status).toBe("in_progress");
}, 15000);

test("last ticket event after a chat reply reports it idle", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  const seen: boolean[] = [];
  bus.on((e) => { if (e.type === "ticket.updated" && e.ticket.id === t.id) seen.push(board.isRunning("p", t.id)); });
  await board.chat("p", t.id, "hi");
  await board.whenIdle();
  expect(seen[0]).toBe(true);
  expect(seen.at(-1)).toBe(false);
});

test("creating a ticket in Planning starts the refine interview automatically", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "app idea", body: "gym tracker", status: "planning" });
  expect(board.isRunning("p", t.id)).toBe(true);
  await board.whenIdle();
  const call = readArgs()[0];
  expect(call.args[call.args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  expect(call.args[call.args.indexOf("--disallowedTools") + 1]).toStartWith("Edit,Write,NotebookEdit,");
  expect(call.prompt.startsWith("<ckanban-context")).toBe(true);
  expect(call.prompt).toContain("gym tracker");
  const got = store.getTicket("p", t.id)!;
  expect(got.refineStarted).toBe(true);
  expect(got.status).toBe("planning");
});

test("moving into Planning auto-starts only the first time; Backlog never does", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.whenIdle();
  expect(readArgs().length).toBe(0);
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
  await board.updateTicket("p", t.id, { status: "backlog" });
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
});

test("a manual refine chat also counts as started", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.chat("p", t.id, "thoughts?");
  await board.whenIdle();
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
});

test("linking a session moves the card to Review", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  const linked = await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  expect(linked.status).toBe("review");
});

test("linked ticket moved into Planning does not auto-start an interview", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  expect(readArgs().length).toBe(0);
});

test("chat still works while the linked session is open in a terminal", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  liveSessions.add("11111111-2222-3333-4444-555555555555");
  await board.chat("p", t.id, "what's the status?");
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
  expect(store.getTicket("p", t.id)!.outcome).not.toBe("blocked");
});

test("planning-only message in Review: Claude marks it and the card moves to Planning", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  process.env.FAKE_EXTRA = '\n1. idea\n<ckanban-move to="planning"/>';
  try {
    await board.chat("p", t.id, "Audit the UI and list 5 improvements. Don't change anything yet.");
    await board.whenIdle();
  } finally {
    delete process.env.FAKE_EXTRA;
  }
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("planning");
  expect(got.outcome).toBeNull();
  // The reply's summary is still recorded, like any other reply.
  expect(store.listComments("p", t.id).at(-1)).toMatchObject({ author: "ai", text: "fake done" });
  const prompt = readArgs()[1].prompt;
  expect(prompt).toContain('<ckanban-move to="planning"/>');
});

test("tickets-only message in Done: Claude marks it and the card stays in Done", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  await board.updateTicket("p", t.id, { status: "done" });
  process.env.FAKE_EXTRA = "\nProposed a follow-up.\n<ckanban-stay/>";
  try {
    await board.chat("p", t.id, "create a follow-up ticket for the docs");
    await board.whenIdle();
  } finally {
    delete process.env.FAKE_EXTRA;
  }
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("done");
  expect(got.outcome).toBe("done");
  expect(readArgs().at(-1)!.prompt).toContain("<ckanban-stay/>");
});

test("normal Review chat still lands back in Review", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  await board.chat("p", t.id, "make the button blue");
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.status).toBe("review");
});

test("streams Claude's text as draft events without persisting them", async () => {
  await setup();
  const drafts: string[] = [];
  bus.on((e) => { if (e.type === "draft") drafts.push(e.text); });
  process.env.FAKE_STREAM_DELAY = "200";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  delete process.env.FAKE_STREAM_DELAY;
  expect(drafts.length).toBeGreaterThan(0);
  expect(drafts.some((d) => d.startsWith("Work "))).toBe(true);
  expect(drafts.at(-1)).toBe("");
  expect(store.readActivity("p", t.id).some((a) => a.event?.type === "stream_event")).toBe(false);
});

test("prompts get image file paths; deleting the ticket deletes its images", async () => {
  await setup({ git: false });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  const { saveAttachment } = await import("../src/server/attachments");
  const inBody = saveAttachment(store.attachmentsDir, "image/png", png);
  const inComment = saveAttachment(store.attachmentsDir, "image/png", png);
  const other = saveAttachment(store.attachmentsDir, "image/png", png);
  const t = await board.createTicket("p", { title: "x", body: `see ![image](/api/attachments/${inBody})`, status: "ready" });
  await board.whenIdle();
  const prompt = readArgs()[0].prompt;
  expect(prompt).toContain(join(store.attachmentsDir, inBody));
  expect(prompt).toContain("Read tool");
  store.addComment("p", t.id, "user", `![image](/api/attachments/${inComment})`);
  await board.deleteTicket("p", t.id);
  expect(existsSync(join(store.attachmentsDir, inBody))).toBe(false);
  expect(existsSync(join(store.attachmentsDir, inComment))).toBe(false);
  expect(existsSync(join(store.attachmentsDir, other))).toBe(true);
});

test("a finished run lands on top of Review; dragging to Ready keeps the drop slot", async () => {
  await setup();
  const old = await board.createTicket("p", { title: "old", body: "", status: "review" });
  await board.createTicket("p", { title: "older", body: "", status: "review" });
  const t = await board.createTicket("p", { title: "new", body: "", status: "ready" });
  await board.whenIdle();
  const review = store.listTickets("p").filter((x) => x.status === "review").map((x) => x.title);
  expect(review).toEqual(["new", "older", "old"]);
  await board.updateTicket("p", old.id, { order: 100 });
  expect(store.getTicket("p", old.id)!.order).toBe(100);
  await board.updateTicket("p", t.id, { status: "backlog", order: 7 });
  expect(store.getTicket("p", t.id)!.order).toBe(7);
});

test("restart mid-reply: planning chat keeps its partial text and recover() resumes it in plan mode", async () => {
  await setup();
  process.env.FAKE_MODE = "partial";
  const t = await board.createTicket("p", { title: "plan", body: "", status: "backlog" });
  await board.chat("p", t.id, "what next?");
  await Bun.sleep(600);
  await board.shutdown();
  const cut = store.getTicket("p", t.id)!;
  expect(cut.status).toBe("backlog");
  expect(cut.interrupted).toMatchObject({ mode: "refine", partial: "Half a repl" });
  expect(cut.interrupted!.prompt).toBeUndefined();
  expect(cut.lastActivity).toBeNull();
  expect(cut.runStartedAt).toBeNull();

  process.env.FAKE_MODE = "ok";
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  board.recover();
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(2);
  expect(calls[1].prompt).toContain("Reply interrupted by daemon restart");
  expect(calls[1].args.join(" ")).toContain("--disallowedTools Edit,Write,NotebookEdit,");
  expect(calls[1].args).toContain(cut.sessionId!);
  expect(store.listComments("p", t.id).map((c) => c.text)).toContain("Reply interrupted by daemon restart; resuming.");
  const after = store.getTicket("p", t.id)!;
  expect(after.interrupted ?? null).toBeNull();
  expect(after.status).toBe("backlog");
}, 20000);

test("recover() starts nothing when no reply was cut off", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "plan", body: "", status: "backlog" });
  await board.chat("p", t.id, "hi");
  await board.whenIdle();
  await board.shutdown();
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  board.recover();
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
  expect(store.listComments("p", t.id).some((c) => c.text.includes("interrupted"))).toBe(false);
});

test("cut-off reply with a queued message: one reply that answers the message", async () => {
  await setup();
  process.env.FAKE_MODE = "partial";
  const t = await board.createTicket("p", { title: "plan", body: "", status: "backlog" });
  await board.chat("p", t.id, "first");
  await Bun.sleep(600);
  await board.shutdown();
  store.updateTicket("p", t.id, { queued: [{ id: "m1", text: "and also this", at: new Date().toISOString(), state: "queued" }] });

  process.env.FAKE_MODE = "ok";
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  board.recover();
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(2);
  expect(calls[1].prompt!.startsWith("and also this")).toBe(true);
  expect(store.getTicket("p", t.id)!.queued).toEqual([]);
  expect(store.getTicket("p", t.id)!.interrupted ?? null).toBeNull();
}, 20000);

test("a chat cut off before claude started gets its message again, not a 'continue'", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "plan", body: "", status: "backlog" });
  await board.chat("p", t.id, "my question");
  await board.shutdown(); // still setting up the worktree: claude never spawned
  expect(store.getTicket("p", t.id)!.interrupted?.prompt).toEqual({ text: "my question" });
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  board.recover();
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(1);
  expect(calls[0].prompt!.startsWith("my question")).toBe(true);
});

test("requested restart waits for active runs and holds new ones until recover()", async () => {
  await setup();
  process.env.FAKE_STEP_MS = "300";
  try {
    const work = await board.createTicket("p", { title: "work", body: "", status: "ready" });
    await Bun.sleep(300);
    let restarted = false;
    const restartEvents: { pending: boolean; waiting: number }[] = [];
    const off = bus.on((e) => { if (e.type === "restart.updated") restartEvents.push({ pending: e.pending, waiting: e.waiting }); });
    expect(board.restartState()).toEqual({ pending: false, waiting: 1 });
    expect(board.requestRestart(() => { restarted = true; }).running).toBe(1);
    expect(board.restartState()).toEqual({ pending: true, waiting: 1 });
    expect(restartEvents).toEqual([{ pending: true, waiting: 1 }]);
    expect(board.requestRestart(() => {}).alreadyPending).toBe(true);
    // Nothing new starts while the restart waits.
    const next = await board.createTicket("p", { title: "next", body: "", status: "ready" });
    const plan = await board.createTicket("p", { title: "plan", body: "", status: "planning" });
    const chat = await board.createTicket("p", { title: "chat", body: "", status: "backlog" });
    await board.chat("p", chat.id, "hello?");
    expect(board.isRunning("p", next.id) || board.isRunning("p", plan.id) || board.isRunning("p", chat.id)).toBe(false);
    expect(store.getTicket("p", chat.id)!.queued).toMatchObject([{ text: "hello?", state: "queued" }]);
    expect(store.getTicket("p", plan.id)!.interrupted).toMatchObject({ held: true });
    expect(restarted).toBe(false);
    await board.whenIdle();
    await Bun.sleep(400);
    expect(restarted).toBe(true);
    expect(store.getTicket("p", work.id)!.status).toBe("review");
    // The UI hears when the last run it waited for is gone.
    expect(restartEvents.at(-1)).toEqual({ pending: true, waiting: 0 });
    off();

    await board.shutdown();
    const before = readArgs().length;
    board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
    board.recover();
    await Bun.sleep(50);
    await board.whenIdle();
    const prompts = readArgs().slice(before).map((c) => c.prompt ?? "");
    expect(prompts.length).toBe(3);
    expect(prompts.some((p) => p.startsWith("hello?"))).toBe(true);
    expect(prompts.some((p) => p.includes("Board asked Claude to help refine"))).toBe(true);
    expect(store.getTicket("p", next.id)!.status).toBe("review");
    expect(store.listComments("p", plan.id).some((c) => c.text.includes("interrupted"))).toBe(false);
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
}, 30000);

test("requested restart gives up waiting after the timeout", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  await board.createTicket("p", { title: "work", body: "", status: "ready" });
  await Bun.sleep(300);
  let restarted = false;
  board.requestRestart(() => { restarted = true; }, 500);
  await Bun.sleep(1000);
  expect(restarted).toBe(true);
}, 15000);

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
    await Bun.sleep(300);
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

test("worktree setup copies files and runs the setup command before Claude starts", async () => {
  const p = await setup();
  writeFileSync(join(p.path, ".gitignore"), ".env\n");
  await run(["git", "add", "-A"], p.path);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore"], p.path);
  writeFileSync(join(p.path, ".env"), "SECRET=1\n");
  store.saveProfile({ ...p, copyFiles: [".env", "missing.env"], setupCommand: "cat .env > installed.txt && echo deps ok" });
  const t = await board.createTicket("p", { title: "Setup", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(readFileSync(join(got.worktree!, ".env"), "utf8")).toBe("SECRET=1\n");
  expect(readFileSync(join(got.worktree!, "installed.txt"), "utf8")).toBe("SECRET=1\n");
  const prompt = readArgs()[0].prompt;
  expect(prompt).toContain("<ckanban-setup>");
  expect(prompt).toContain('"copied":[".env"]');
  expect(prompt).toContain('"missing":["missing.env"]');
  expect(prompt).toContain("deps ok");
});

test("a failing setup command doesn't block the run: Claude starts and sees the output", async () => {
  const p = await setup();
  store.saveProfile({ ...p, setupCommand: "echo cannot install; exit 7" });
  const t = await board.createTicket("p", { title: "Fails", body: "", status: "ready" });
  await board.whenIdle();
  expect(store.getTicket("p", t.id)).toMatchObject({ status: "review", outcome: "done" });
  const prompt = readArgs()[0].prompt;
  expect(prompt).toContain("failed (exit 7)");
  expect(prompt).toContain("cannot install");
  // Told once: the next run's prompt has no setup block.
  await board.chat("p", t.id, "again");
  await board.whenIdle();
  expect(readArgs().at(-1)!.prompt).not.toContain("<ckanban-setup>");
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
    await Bun.sleep(400);
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

// ---- One-click recovery: Start fresh session / Take over here ----

test("recoveryFor: lost session and open-in-terminal errors get a fix, others don't", () => {
  expect(recoveryFor("No conversation found with session ID: abc")).toBe("session_missing");
  expect(recoveryFor(SESSION_OPEN_MSG)).toBe("session_open");
  expect(recoveryFor("claude exited with code 1")).toBeNull();
  expect(recoveryFor(null)).toBeNull();
});

test("a linked ticket's lost session shows Start fresh session, which runs a new session in the same folder", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "x", body: "the task", status: "review" });
  const old = "11111111-2222-3333-4444-555555555555";
  await board.linkSession("p", t.id, old);
  store.addComment("p", t.id, "user", "please also do Y");
  process.env.FAKE_MODE = "nosession";
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  let got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("failed");
  expect(recoveryFor(got.error)).toBe("session_missing");

  process.env.FAKE_MODE = "ok";
  board.startFresh("p", t.id);
  await board.whenIdle();
  got = store.getTicket("p", t.id)!;
  expect(got.sessionId).not.toBe(old);
  expect(got.workdir).toBe(p.path);
  expect(got.freshSession).toBe(false);
  expect(got.outcome).toBe("done");
  expect(got.error).toBeNull();
  const call = readArgs().at(-1)!;
  expect(call.args).toContain("--session-id");
  expect(call.args).toContain(got.sessionId!);
  expect(call.cwd).toBe(p.path);
  expect(call.prompt).toContain("new Claude session");
  expect(call.prompt).toContain("the task");
  expect(call.prompt).toContain("please also do Y");
  expect(call.prompt).toContain("git log --oneline main..HEAD");
  expect(store.listComments("p", t.id).some((c) => c.author === "ai" && c.text.startsWith("Started a fresh session"))).toBe(true);
});

test("Start fresh session keeps the worktree and branch and hands Claude the last result", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const before = store.getTicket("p", t.id)!;
  store.updateTicket("p", t.id, { error: "No conversation found with session ID: x", outcome: "failed" });
  board.startFresh("p", t.id);
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBe(before.worktree);
  expect(got.branch).toBe(before.branch);
  expect(got.sessionId).not.toBe(before.sessionId);
  const call = readArgs().at(-1)!;
  expect(call.cwd).toBe(before.worktree!);
  expect(call.args).toContain("--session-id");
  expect(call.prompt).toContain("# Last result\nfake done");
  // The next run resumes the new session like any other.
  await board.chat("p", t.id, "more");
  await board.whenIdle();
  expect(readArgs().at(-1)!.args).toContain("--resume");
}, 15000);

test("Take over here closes the session in the board's terminal and the run resumes", async () => {
  let closed = 0;
  board = new Board(store, bus, {
    claudeBin: FAKE,
    isSessionLive: async (s) => liveSessions.has(s),
    findOwnedSession: async (s) => (liveSessions.has(s) ? { pid: 1, close: async () => (closed++, liveSessions.delete(s), true) } : null),
  });
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const id = store.getTicket("p", t.id)!.sessionId!;
  liveSessions.add(id);
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  expect(recoveryFor(store.getTicket("p", t.id)!.error)).toBe("session_open");
  expect(readArgs().length).toBe(1);

  const r = await board.takeOver("p", t.id);
  expect(r.external).toBe(false);
  await board.whenIdle();
  expect(closed).toBe(1);
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("done");
  expect(got.sessionId).toBe(id);
  expect(readArgs().at(-1)!.args).toContain("--resume");
  expect(store.listComments("p", t.id).some((c) => c.text.startsWith("Took over the session: closed it"))).toBe(true);
});

test("Take over here can't close an external terminal: nothing changes and the UI offers a fresh session", async () => {
  const id = "11111111-2222-3333-4444-555555555555";
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async (s) => liveSessions.has(s), findOwnedSession: async () => null });
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "review" });
  await board.linkSession("p", t.id, id);
  liveSessions.add(id);
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const r = await board.takeOver("p", t.id);
  expect(r.external).toBe(true);
  await board.whenIdle();
  expect(readArgs().length).toBe(0);
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(recoveryFor(got.error)).toBe("session_open");
  // Start fresh session works around it: a new session, so the open terminal doesn't block the run.
  board.startFresh("p", t.id);
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.outcome).toBe("done");
  expect(readArgs().at(-1)!.args).toContain("--session-id");
});

test("recovery actions refuse while Claude is working on the ticket", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(50);
  expect(() => board.startFresh("p", t.id)).toThrow(ConflictError);
  await expect(board.takeOver("p", t.id)).rejects.toThrow(ConflictError);
});

test("a run stops at its spending cap, waits blocked, and Continue with +$Y resumes it with that cap", async () => {
  const p = await setup();
  store.saveProfile({ ...p, runCapUsd: 0.05 });
  process.env.FAKE_MODE = "budget";
  const t = await board.createTicket("p", { title: "Capped", body: "desc", status: "ready" });
  await board.whenIdle();
  let got = store.getTicket("p", t.id)!;
  expect(readArgs()[0].args.join(" ")).toContain("--max-budget-usd 0.05");
  expect(got).toMatchObject({ status: "review", outcome: "blocked", error: "Stopped at $0.05 cap", capHit: { capUsd: 0.05 } });
  expect(store.listComments("p", t.id).at(-1)!.text).toStartWith("Stopped at $0.05 cap");

  process.env.FAKE_MODE = "ok";
  await board.continueAfterCap("p", t.id, 0.5);
  await board.whenIdle();
  got = store.getTicket("p", t.id)!;
  const call = readArgs().at(-1)!;
  expect(call.args).toContain("--resume");
  expect(call.args.join(" ")).toContain("--max-budget-usd 0.5");
  expect(got).toMatchObject({ outcome: "done", capHit: null, capNextUsd: null });
  await expect(board.continueAfterCap("p", t.id, 0)).rejects.toThrow("positive");
});

test("a ticket's own cap overrides the board's; 0 runs without one", async () => {
  const p = await setup();
  store.saveProfile({ ...p, runCapUsd: 5 });
  const a = await board.createTicket("p", { title: "Own cap", body: "desc", status: "backlog" });
  await board.updateTicket("p", a.id, { runCapUsd: 2 });
  await board.updateTicket("p", a.id, { status: "ready" });
  await board.whenIdle();
  expect(readArgs().at(-1)!.args.join(" ")).toContain("--max-budget-usd 2");
  const b = await board.createTicket("p", { title: "No cap", body: "desc", status: "backlog" });
  await board.updateTicket("p", b.id, { runCapUsd: 0 });
  await board.updateTicket("p", b.id, { status: "ready" });
  await board.whenIdle();
  expect(readArgs().at(-1)!.args).not.toContain("--max-budget-usd");
});
