import { expect, test } from "bun:test";
import { type Job, commandResult, jobChip, jobDate, jobRelative, jobsToShow, jobWhen, localInput, upcoming } from "../web/src/jobText";

const NOW = new Date(2026, 9, 18, 22, 0).getTime(); // Sun 18 Oct 2026 22:00 local

type TestJob = Job & { id: string; action: Job["action"] & Record<string, unknown>; result: (Job["result"] & { ticketId?: string }) | null };

function job(id: string, over: Partial<TestJob> = {}): TestJob {
  const at = new Date(NOW + 3600_000).toISOString();
  return {
    id, name: `Job ${id}`, at, action: { kind: "ticket", title: "Post", body: "do it", mode: "auto" }, state: "scheduled",
    sourceTicketId: "t1", updatedAt: new Date(NOW).toISOString(), firedAt: null, result: null, ...over,
  };
}

test("jobWhen says the day, date, time and how far off it is", () => {
  const at = new Date(2026, 9, 20, 22, 0).toISOString();
  expect(jobDate(at)).toBe("Tue 20 Oct 22:00");
  expect(jobWhen(at, NOW)).toBe("Tue 20 Oct 22:00 · in 2 days");
  expect(jobRelative(new Date(NOW + 3 * 3600_000).toISOString(), NOW)).toBe("in 3 hours");
  expect(jobRelative(new Date(NOW - 60_000).toISOString(), NOW)).toBe("1 minute ago");
  expect(jobRelative(new Date(NOW).toISOString(), NOW)).toBe("now");
});

test("the chip counts the ticket's scheduled jobs and names the next one", () => {
  const jobs = [
    job("a", { at: new Date(NOW + 2 * 86400_000).toISOString() }),
    job("b", { name: "Post B", at: new Date(NOW + 3600_000).toISOString() }),
    job("c", { state: "done" }),
    job("d", { sourceTicketId: "t2" }),
  ];
  expect(jobChip(jobs, "t1", NOW)).toEqual({ label: "2 scheduled", title: "Next: Post B, Sun 18 Oct 23:00 · in 1 hour" });
  expect(jobChip(jobs, "t3", NOW)).toBeNull();
  expect(upcoming(jobs).map((j) => j.id)).toEqual(["b", "d", "a"]);
});

test("the Upcoming list keeps finished jobs for 7 days", () => {
  const old = new Date(NOW - 8 * 86400_000).toISOString();
  const recent = new Date(NOW - 86400_000).toISOString();
  const jobs = [
    job("open"),
    job("skip", { state: "skipped", updatedAt: recent }),
    job("run", { state: "running" }),
    job("done", { state: "done", updatedAt: recent, firedAt: recent }),
    job("stale", { state: "failed", updatedAt: old, firedAt: old }),
  ];
  const all = jobsToShow(jobs, null, NOW);
  expect(all.open.map((j) => j.id).sort()).toEqual(["open", "run"]);
  expect(all.over.map((j) => j.id).sort()).toEqual(["done", "skip"]);
});

test("a command's result reads as plain words", () => {
  const cmd = { kind: "command" as const, command: "./post.sh" };
  expect(commandResult(job("a", { action: cmd, state: "done", result: { exitCode: 0, durationMs: 2400 } }))).toBe("Finished OK in 2 s");
  expect(commandResult(job("b", { action: cmd, state: "failed", result: { exitCode: 2, durationMs: 120_000 } }))).toBe("Exit code 2 in 2 min");
  expect(commandResult(job("c", { action: cmd, state: "failed", result: { exitCode: null, timedOut: true, durationMs: 600_000 } }))).toBe("Stopped at its time limit in 10 min");
  expect(commandResult(job("d", { state: "done", result: { ticketId: "t9" } }))).toBeNull();
});

test("localInput gives a datetime-local value in this computer's time", () => {
  expect(localInput(new Date(2026, 0, 5, 7, 3).toISOString())).toBe("2026-01-05T07:03");
});
