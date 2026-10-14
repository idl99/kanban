import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus, type BusEvent } from "../src/server/events";
import { describeAt, JobRunner, MAX_CHAIN, parseAt, runCommand } from "../src/server/jobs";
import { DEFAULT_NOTIFY, NOTIFY_KINDS } from "../src/server/notify";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

let store: Store;
let board: Board;
let bus: Bus;
let now: Date;
let jobs: JobRunner;
let events: BusEvent[];
let folder: string;

const at = (d: number, h: number, mi = 0) => new Date(2026, 9, d, h, mi);
const local = (d: Date) => `${d.getFullYear()}-10-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const jobTickets = () => store.listTickets("p").filter((t) => t.jobId);

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  events = [];
  bus.on((e) => events.push(e));
  board = new Board(store, bus, { claudeBin: "/bin/false" });
  folder = tempDir();
  store.saveProfile({ name: "P", slug: "p", path: folder, baseBranch: "main", maxParallel: 1, createdAt: "" });
  now = at(14, 9);
  jobs = new JobRunner(board, store, bus, { now: () => now });
});

afterEach(async () => {
  await jobs.whenIdle();
  await board.whenIdle();
});

const source = () => store.createTicket("p", { title: "Weekly posts", body: "", status: "review" });
const ticketJob = (name: string, when: Date, src: string | null = null) =>
  jobs.create("p", { name, at: local(when), action: { kind: "ticket", title: name, body: `Post ${name} now.` } }, src);

test("parseAt reads local times and ISO times, and refuses anything else", () => {
  expect(parseAt("2026-10-20 22:00")).toEqual(new Date(2026, 9, 20, 22, 0));
  expect(parseAt("2026-10-20T22:00:30")).toEqual(new Date(2026, 9, 20, 22, 0, 30));
  expect(parseAt("2026-10-20T20:00:00Z").toISOString()).toBe("2026-10-20T20:00:00.000Z");
  expect(() => parseAt("tomorrow")).toThrow("like \"2026-10-20 22:00\"");
  expect(() => parseAt("2026-02-31 10:00")).toThrow();
  expect(() => parseAt("2026-10-20 25:00")).toThrow();
});

test("describeAt says when, in words", () => {
  expect(describeAt(at(20, 22).toISOString(), at(18, 22))).toBe("Tue 20 Oct 22:00 (in 2 days)");
  expect(describeAt(at(14, 9, 30).toISOString(), at(14, 9))).toBe("Wed 14 Oct 09:30 (in 30 minutes)");
});

test("create validates and refuses a time in the past", () => {
  const j = ticketJob("A", at(14, 10));
  expect(j).toMatchObject({ state: "scheduled", sourceTicketId: null, firedAt: null, result: null });
  expect(j.action).toEqual({ kind: "ticket", title: "A", body: "Post A now.", mode: "auto" });
  expect(store.getJob("p", j.id)).toEqual(j);
  expect(events.some((e) => e.type === "job.updated" && e.id === j.id)).toBe(true);
  expect(() => ticketJob("old", at(14, 8))).toThrow("is in the past");
  expect(() => jobs.create("p", { name: "x", at: local(at(15, 9)), action: { kind: "ticket", title: "t", body: " " } })).toThrow("needs a body");
  expect(() => jobs.create("p", { name: "x", at: local(at(15, 9)), action: { kind: "shell" } })).toThrow("must be \"ticket\" or \"command\"");
  expect(() => jobs.create("p", { name: " ", at: local(at(15, 9)), action: { kind: "command", command: "true" } })).toThrow("name is required");
});

test("3 ticket jobs and 1 command job each fire once at their time", async () => {
  const src = source();
  const a = ticketJob("A", at(14, 10), src.id);
  const b = ticketJob("B", at(14, 11), src.id);
  const c = ticketJob("C", at(15, 9), src.id);
  const cmd = jobs.create("p", { name: "Ping", at: local(at(14, 10)), action: { kind: "command", command: "echo hi $CKANBAN_JOB $CKANBAN_SOURCE_TICKET; pwd" } }, src.id);

  await jobs.tick();
  expect(jobTickets()).toHaveLength(0);

  now = at(14, 10, 1);
  await jobs.tick();
  await jobs.tick();
  await jobs.whenIdle();
  expect(jobTickets()).toHaveLength(1);
  const ta = jobTickets()[0];
  expect(ta).toMatchObject({ title: "A", jobId: a.id, mode: "auto" });
  expect(ta.body).toStartWith(`Scheduled by ticket ${src.id} ("Weekly posts") as job 'A'.`);
  expect(ta.body).toContain("Post A now.");
  // Started right away, like a schedule's ticket.
  expect(["ready", "in_progress", "review"]).toContain(store.getTicket("p", ta.id)!.status);
  expect(store.getJob("p", a.id)).toMatchObject({ state: "done", result: { ticketId: ta.id } });

  const ran = store.getJob("p", cmd.id)!;
  expect(ran.state).toBe("done");
  expect(ran.result).toMatchObject({ exitCode: 0, timedOut: false });
  expect(ran.result!.output).toContain(`hi ${cmd.id} ${src.id}`);
  expect(ran.result!.output).toContain(folder.split("/").pop()!);

  now = at(14, 11, 2);
  await jobs.tick();
  now = at(15, 9, 5);
  await jobs.tick();
  await jobs.tick();
  expect(jobTickets().map((t) => t.title).sort()).toEqual(["A", "B", "C"]);
  expect(store.getJob("p", b.id)!.state).toBe("done");
  expect(store.getJob("p", c.id)!.state).toBe("done");
  // The command job made no ticket.
  expect(store.listTickets("p")).toHaveLength(4);
});

test("a failing command is failed with its exit code and output", async () => {
  const j = jobs.create("p", { name: "Bad", at: local(at(14, 10)), action: { kind: "command", command: "echo oops >&2; exit 3" } });
  now = at(14, 10);
  await jobs.tick();
  await jobs.whenIdle();
  expect(store.getJob("p", j.id)).toMatchObject({ state: "failed", result: { exitCode: 3, output: "oops\n", message: "exited with code 3" } });
});

test("a command that runs too long is stopped at its time limit", async () => {
  const r = await runCommand("echo start; sleep 5", folder, {}, 1);
  expect(r).toMatchObject({ exitCode: null, timedOut: true, message: "stopped after 1 s (time limit)" });
  // The shell may also report the killed sleep ("Terminated: 15"), depending on which process the signal reaches first.
  expect(r.output!.startsWith("start\n")).toBe(true);
  expect(r.durationMs!).toBeLessThan(4000);
});

test("only the last 4 KB of output is kept", async () => {
  const r = await runCommand("i=0; while [ $i -lt 300 ]; do echo line-$i-xxxxxxxxxxxxxxxx; i=$((i+1)); done", folder, {}, 10);
  expect(Buffer.byteLength(r.output!)).toBeLessThanOrEqual(4096);
  expect(r.output).toEndWith("line-299-xxxxxxxxxxxxxxxx\n");
});

test("a late ticket job still starts, told how late it is so its run decides", async () => {
  const src = source();
  const j = ticketJob("Post: new kitchen", at(14, 10), src.id);
  now = at(15, 8, 15);
  await jobs.tick();
  await jobs.tick();
  expect(jobTickets()).toHaveLength(1);
  const t = jobTickets()[0];
  expect(t.body).toStartWith("This was due Wed 14 Oct 10:00 but is running Thu 15 Oct 08:15 because the computer was off. " +
    "Decide if it still makes sense: do it, adapt it, or stop and say why.\n\n" +
    `Scheduled by ticket ${src.id} ("Weekly posts") as job 'Post: new kitchen'.`);
  expect(t.body).toContain("Post Post: new kitchen now.");
  expect(store.getJob("p", j.id)).toMatchObject({ state: "done", result: { ticketId: t.id } });
  // Nothing asks the user: no comment on the source ticket.
  expect(store.listComments("p", src.id)).toEqual([]);
});

test("a ticket job on time has no late line", async () => {
  ticketJob("A", at(14, 10));
  now = at(14, 10, 9);
  await jobs.tick();
  expect(jobTickets()[0].body).toBe("Post A now.");
});

test("a late command is skipped by default, and runs late with ifLate: run", async () => {
  const src = source();
  const skip = jobs.create("p", { name: "Post", at: local(at(14, 10)), action: { kind: "command", command: "echo posted > posted.txt" } }, src.id);
  const run = jobs.create("p", { name: "Backup", at: local(at(14, 10)), action: { kind: "command", command: "echo backed > backup.txt", ifLate: "run" } }, src.id);
  expect(run.action).toEqual({ kind: "command", command: "echo backed > backup.txt", ifLate: "run" });
  expect(skip.action).toEqual({ kind: "command", command: "echo posted > posted.txt" });
  now = at(14, 10, 11);
  await jobs.tick();
  await jobs.tick();
  await jobs.whenIdle();
  expect(store.getJob("p", skip.id)).toMatchObject({ state: "skipped", firedAt: null, result: { message: "skipped: the computer was off at Wed 14 Oct 10:00" } });
  expect(existsSync(join(folder, "posted.txt"))).toBe(false);
  expect(store.getJob("p", run.id)).toMatchObject({ state: "done", result: { exitCode: 0 } });
  expect(readFileSync(join(folder, "backup.txt"), "utf8")).toBe("backed\n");
  expect(store.listComments("p", src.id)).toEqual([]);
  expect(() => jobs.create("p", { name: "x", at: local(at(15, 9)), action: { kind: "command", command: "true", ifLate: "maybe" } })).toThrow("ifLate must be");
});

test("a late command waiting on a pending restart is still skipped, not run later", async () => {
  const j = jobs.create("p", { name: "Post", at: local(at(14, 10)), action: { kind: "command", command: "echo posted > posted.txt" } });
  board.isRestartPending = () => true;
  now = at(14, 11);
  await jobs.tick();
  expect(store.getJob("p", j.id)!.state).toBe("skipped");
  expect(existsSync(join(folder, "posted.txt"))).toBe(false);
});

test("a failed command leaves a quiet comment on its source ticket; a good one doesn't", async () => {
  const src = source();
  const bad = jobs.create("p", { name: "Post A", at: local(at(14, 10)), action: { kind: "command", command: "for i in 1 2 3 4 5 6 7 8 9 10; do echo line$i; done; exit 1" } }, src.id);
  jobs.create("p", { name: "Fine", at: local(at(14, 10)), action: { kind: "command", command: "echo ok" } }, src.id);
  now = at(14, 10);
  await jobs.tick();
  await jobs.whenIdle();
  expect(store.getJob("p", bad.id)!.state).toBe("failed");
  const comments = store.listComments("p", src.id);
  expect(comments).toHaveLength(1);
  expect(comments[0].text).toStartWith("Scheduled job 'Post A' failed: exited with code 1");
  expect(comments[0].text).toContain("line10");
  expect(comments[0].text).toContain("line3");
  expect(comments[0].text).not.toContain("line2\n");
  // Quiet: the ticket doesn't start needing the user.
  expect(store.getTicket("p", src.id)!.status).toBe("review");
});

test("a command cut off by a restart comments on its source ticket", () => {
  const src = source();
  const j = jobs.create("p", { name: "Long", at: local(at(14, 10)), action: { kind: "command", command: "sleep 100" } }, src.id);
  store.saveJob("p", { ...store.getJob("p", j.id)!, state: "running", firedAt: at(14, 10).toISOString() });
  jobs.recover();
  expect(store.getJob("p", j.id)!.state).toBe("failed");
  expect(store.listComments("p", src.id).at(-1)!.text).toStartWith("Scheduled job 'Long' failed: interrupted by restart");
});

test("a ticket job's intro shows the chain of jobs and tickets that led to it", async () => {
  const t1 = source();
  const a = ticketJob("A", at(14, 10), t1.id);
  now = at(14, 10);
  await jobs.tick();
  const t2 = store.getTicket("p", store.getJob("p", a.id)!.result!.ticketId!)!;
  const b = ticketJob("B", at(14, 11), t2.id);
  now = at(14, 11);
  await jobs.tick();
  const t3 = store.getTicket("p", store.getJob("p", b.id)!.result!.ticketId!)!;
  expect(t3.body).toStartWith(`Created by job 'B', scheduled by ticket ${t2.id} ("A"), which was created by job 'A', ` +
    `scheduled by ticket ${t1.id} ("Weekly posts") (chain of 2).`);
  expect(jobs.chain("p", t3.id).map((l) => l.job.name)).toEqual(["B", "A"]);
});

test("the chain walk stops on a loop, and a ticket job from a 10-deep chain is refused", () => {
  // Hand-made files: a job whose source ticket was created by that same job loops forever without the guard.
  const t = store.createTicket("p", { title: "loop", body: "", status: "review" });
  const j = ticketJob("L", at(15, 9), t.id);
  store.updateTicket("p", t.id, { jobId: j.id });
  expect(jobs.chain("p", t.id)).toHaveLength(1);

  let src = source().id;
  for (let i = 0; i < MAX_CHAIN; i++) {
    const job = ticketJob(`J${i}`, at(15, 9), src);
    src = store.createTicket("p", { title: `T${i}`, body: "", status: "review", jobId: job.id }).id;
  }
  expect(jobs.chain("p", src)).toHaveLength(MAX_CHAIN);
  expect(() => ticketJob("one more", at(15, 9), src)).toThrow("chain of 10 tickets");
  // A command job is still fine, and so is a ticket job one step earlier.
  expect(() => jobs.create("p", { name: "c", at: local(at(15, 9)), action: { kind: "command", command: "true" } }, src)).not.toThrow();
});

test("an old missed job file reads as skipped", () => {
  const j = ticketJob("Old", at(15, 9));
  store.saveJob("p", { ...j, state: "missed" as any });
  expect(store.getJob("p", j.id)).toMatchObject({ state: "skipped", result: { message: "was due while the computer was off" } });
  expect(jobs.list("p").find((x) => x.id === j.id)!.state).toBe("skipped");
});

test("cancel stops a job from ever running", async () => {
  const j = ticketJob("A", at(14, 10));
  await jobs.cancel("p", j.id);
  now = at(14, 10, 1);
  await jobs.tick();
  expect(store.getJob("p", j.id)!.state).toBe("cancelled");
  expect(jobTickets()).toHaveLength(0);
  await expect(jobs.cancel("p", j.id)).rejects.toThrow("is cancelled");
});

test("update changes a scheduled job and replaces its whole action", async () => {
  const j = ticketJob("A", at(14, 10));
  const u = await jobs.update("p", j.id, { name: "A2", at: local(at(14, 11)), action: { kind: "command", command: "true", timeoutSec: 5 } });
  expect(u).toMatchObject({ name: "A2", at: at(14, 11).toISOString(), action: { kind: "command", command: "true", timeoutSec: 5 } });
  await expect(jobs.update("p", j.id, { at: local(at(14, 8)) })).rejects.toThrow("in the past");
  await expect(jobs.update("p", j.id, { action: { kind: "ticket", title: "only the title" } as any }))
    .rejects.toThrow("send the whole action (kind and all its fields), not only the part you change");

  now = at(14, 11);
  await jobs.tick();
  await jobs.whenIdle();
  expect(store.getJob("p", j.id)!.state).toBe("done");
  await expect(jobs.update("p", j.id, { name: "late" })).rejects.toThrow("is done");
});

test("a run may only change the jobs it scheduled", async () => {
  const mine = source();
  const other = source();
  const j = ticketJob("A", at(14, 10), mine.id);
  await expect(jobs.cancel("p", j.id, other.id)).rejects.toThrow("was not scheduled by this ticket");
  await expect(jobs.update("p", j.id, { name: "x" }, other.id)).rejects.toThrow("was not scheduled by this ticket");
  expect((await jobs.update("p", j.id, { name: "x" }, mine.id)).name).toBe("x");
});

test("restart while running: commands fail, ticket jobs are checked against their ticket, nothing fires twice", async () => {
  const cmd = jobs.create("p", { name: "Cmd", at: local(at(14, 10)), action: { kind: "command", command: "true" } });
  const made = ticketJob("Made", at(14, 10));
  const notYet = ticketJob("NotYet", at(14, 10));
  // As the daemon left them: marked running, then cut off.
  for (const j of [cmd, made, notYet]) store.saveJob("p", { ...j, state: "running", firedAt: at(14, 10).toISOString() });
  const t = store.createTicket("p", { title: "Made", body: "", status: "in_progress", jobId: made.id });

  now = at(14, 10, 1);
  const after = new JobRunner(board, store, bus, { now: () => now });
  after.recover();
  expect(store.getJob("p", cmd.id)).toMatchObject({ state: "failed", result: { message: expect.stringContaining("interrupted by restart") } });
  expect(store.getJob("p", made.id)).toMatchObject({ state: "done", result: { ticketId: t.id } });
  expect(store.getJob("p", notYet.id)!.state).toBe("scheduled");

  await after.tick();
  await after.tick();
  await after.whenIdle();
  expect(jobTickets().map((x) => x.title).sort()).toEqual(["Made", "NotYet"]);
  expect(store.getJob("p", notYet.id)!.state).toBe("done");
});

test("jobs are stored as files in the board's jobs folder", () => {
  const j = ticketJob("A", at(14, 10));
  const file = join(store.root, "profiles", "p", "jobs", `${j.id}.json`);
  expect(JSON.parse(readFileSync(file, "utf8")).name).toBe("A");
  expect(jobs.list("p").map((x) => x.id)).toEqual([j.id]);
});

test("a timeout stops everything the command started, not just the shell", async () => {
  const marker = join(folder, "marker");
  const r = await runCommand(`echo start; (sleep 2; touch ${marker}) & sleep 5`, folder, {}, 1);
  expect(r.timedOut).toBe(true);
  await Bun.sleep(2500);
  expect(existsSync(marker)).toBe(false);
});

test("background leftovers of a finished command are stopped", async () => {
  const marker = join(folder, "left");
  const r = await runCommand(`(sleep 1; touch ${marker}) > /dev/null 2>&1 & echo done`, folder, {}, 10);
  expect(r.exitCode).toBe(0);
  await Bun.sleep(1500);
  expect(existsSync(marker)).toBe(false);
});

test("command jobs don't inherit a board run's identity", async () => {
  const saved = process.env.CKANBAN_TICKET;
  process.env.CKANBAN_TICKET = "p/t_20261001_spoof";
  try {
    const r = await runCommand("echo \"[$CKANBAN_TICKET]\"", folder, {}, 5);
    expect(r.output).toBe("[]\n");
  } finally {
    if (saved === undefined) delete process.env.CKANBAN_TICKET;
    else process.env.CKANBAN_TICKET = saved;
  }
});

test("a pending restart waits for a running command, and holds new ones", async () => {
  const j = jobs.create("p", { name: "Slow", at: local(at(14, 10)), action: { kind: "command", command: "sleep 0.5" } });
  const held = jobs.create("p", { name: "Held", at: local(at(14, 10)), action: { kind: "command", command: "true" } });
  now = at(14, 10);
  // Fire the first only: the second is due later.
  store.saveJob("p", { ...held, at: at(14, 10, 1).toISOString() });
  await jobs.tick();
  let restarted = false;
  board.requestRestart(() => (restarted = true), 5000);
  expect(board.restartState().waiting).toBe(1);
  now = at(14, 10, 2);
  await jobs.tick();
  expect(store.getJob("p", held.id)!.state).toBe("scheduled");
  await jobs.whenIdle();
  expect(store.getJob("p", j.id)!.state).toBe("done");
  for (let i = 0; i < 20 && !restarted; i++) await Bun.sleep(100);
  expect(restarted).toBe(true);
});

test("stopping the runner (daemon shutdown) stops running commands", async () => {
  const marker = join(folder, "after");
  jobs.create("p", { name: "Long", at: local(at(14, 10)), action: { kind: "command", command: `sleep 2; touch ${marker}` } });
  now = at(14, 10);
  const stop = jobs.start(60_000);
  await Bun.sleep(300);
  stop();
  await jobs.whenIdle();
  await Bun.sleep(2200);
  expect(existsSync(marker)).toBe(false);
});

test("deleting the source ticket cancels its jobs that haven't run", async () => {
  const src = source();
  const j = ticketJob("A", at(14, 10), src.id);
  await board.deleteTicket("p", src.id);
  await jobs.whenIdle();
  expect(store.getJob("p", j.id)).toMatchObject({ state: "cancelled", result: { message: "its ticket was deleted" } });
});

test("the board's list keeps every job finished in the last days; list_jobs keeps the last 20", async () => {
  const made = [];
  for (let i = 0; i < 22; i++) made.push(ticketJob(`J${i}`, at(14, 10)));
  for (const j of made) await jobs.cancel("p", j.id);
  // One finished 8 days ago: past the board's 7 days.
  const old = ticketJob("Old", at(14, 10));
  await jobs.cancel("p", old.id);
  store.saveJob("p", { ...store.getJob("p", old.id)!, updatedAt: new Date(at(6, 9).getTime()).toISOString() });
  const open = ticketJob("Open", at(15, 10));
  expect(jobs.list("p").length).toBe(21);
  const week = jobs.list("p", null, 7);
  expect(week.length).toBe(23);
  expect(week.map((j) => j.id)).toContain(open.id);
  expect(week.map((j) => j.id)).not.toContain(old.id);
});

test("nothing about jobs asks the user: no attention or notification kind for them", () => {
  expect(NOTIFY_KINDS as string[]).not.toContain("job");
  expect(Object.keys(DEFAULT_NOTIFY.kinds)).not.toContain("job");
});
