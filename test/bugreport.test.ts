import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BoardClient } from "../src/client";
import { Board } from "../src/server/board";
import {
  buildIssueBody, draftReport, fileIssue, LOG_MAX_BYTES, logBlock, MAX_URL_LENGTH, newIssueUrl, screenshotNames, scrub,
  submitReport, tail, type BugBlock, type GhRunner,
} from "../src/server/bugreport";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import type { ActivityEntry } from "../src/server/types";
import { ticketCommand } from "../src/ticket-cli";
import { makeRepo, tempDir } from "./helpers";

const SHOT = "0123456789abcdef0123456789abcdef.png";

/** Fake gh: records argv, answers with `reply` (or a created-issue URL). */
function fakeGh(reply?: (args: string[], n: number) => { code: number; stdout?: string; stderr?: string }) {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    const r = reply?.(args, calls.length) ?? { code: 0, stdout: "https://github.com/leoawesome/ckanban/issues/42\n" };
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { gh, calls };
}

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

// --- Body builder -------------------------------------------------------------------------------

test("scrub hides the data folder, home folder and secrets", () => {
  const text = "log at /Users/me/.claude-kanban/profiles/x and /Users/me/dev/app; token ghp_abcdefghijklmnopqrstuvwx1234 API_KEY=hunter2";
  const out = scrub(text, { home: "/Users/me", dataRoot: "/Users/me/.claude-kanban" });
  expect(out).toContain("<ckanban data>/profiles/x");
  expect(out).toContain("~/dev/app");
  expect(out).not.toContain("/Users/me");
  expect(out).not.toContain("ghp_");
  expect(out).not.toContain("hunter2");
});

test("tail keeps the last lines within the byte cap", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
  const out = tail(text);
  expect(out.split("\n").length).toBeLessThanOrEqual(50);
  expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(LOG_MAX_BYTES);
  expect(out.endsWith(`line 199 ${"x".repeat(60)}`)).toBe(true);
  expect(tail("a\nb\nc", 2)).toBe("b\nc");
  expect(tail("x".repeat(100), 50, 10)).toBe("x".repeat(10));
});

test("log block summarizes only the last run", () => {
  const ev = (run: number, text: string): ActivityEntry => ({
    run, at: "2026-10-01T10:00:00.000Z", event: { type: "assistant", message: { content: [{ type: "text", text }] } },
  });
  const b = logBlock([ev(1, "old run"), ev(2, "new run"), { run: 2, at: "2026-10-01T10:00:05.000Z", event: { type: "result", result: "ok" } }])!;
  expect(b.text).toBe("10:00:00 new run\n10:00:05 Finished");
  expect(logBlock([])).toBeNull();
});

const BLOCKS: BugBlock[] = [
  { id: "env", label: "Version and system", text: "- ckanban: dev" },
  { id: "ticket", label: "Ticket details", text: `- Ticket: t_1\n\n![shot](/api/attachments/${SHOT})` },
  { id: "log", label: "Last run log (tail)", text: "10:00 Bash: ls" },
];

test("issue body: user text first, kept blocks, log folded, toggles respected", () => {
  const all = buildIssueBody({ title: "t", description: "It broke", blocks: BLOCKS, source: "ui" }).body;
  expect(all.startsWith("It broke")).toBe(true);
  expect(all).toContain("### Version and system");
  expect(all).toContain("### Ticket details");
  expect(all).toContain("<details><summary>Last run log (tail)</summary>");
  expect(all).toContain("Reported from the board");

  const some = buildIssueBody({ title: "t", description: "x", blocks: BLOCKS, include: ["env"], source: "ai" });
  expect(some.body).toContain("### Version and system");
  expect(some.body).not.toContain("Ticket details");
  expect(some.body).not.toContain("<details>");
  expect(some.body).toContain("Reported from Claude");
  expect(some.screenshots).toEqual([]);
});

test("issue body: local screenshots are counted and replaced", () => {
  const r = buildIssueBody({ title: "t", description: `see ![](/api/attachments/${SHOT})`, blocks: BLOCKS, source: "ui" });
  expect(r.screenshots).toEqual([SHOT]);
  expect(r.body).toContain("> 1 screenshot not uploaded, see comments.");
  expect(r.body).not.toContain("/api/attachments/");
  expect(r.body).toContain("_[screenshot not uploaded]_");
  expect(screenshotNames(`/Users/me/.claude-kanban/attachments/${SHOT} and /api/attachments/${SHOT}`)).toEqual([SHOT]);
});

test("new-issue URL is prefilled and cut to fit", () => {
  const short = new URL(newIssueUrl("Crash", "body text"));
  expect(short.origin + short.pathname).toBe("https://github.com/leoawesome/ckanban/issues/new");
  expect(short.searchParams.get("title")).toBe("Crash");
  expect(short.searchParams.get("body")).toBe("body text");
  expect(short.searchParams.get("labels")).toBe("bug");

  const long = newIssueUrl("Crash", "é".repeat(20_000));
  expect(long.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
  const body = new URL(long).searchParams.get("body")!;
  expect(body.endsWith("add more details here)")).toBe(true);
  expect(body.length).toBeGreaterThan(500);
});

// --- gh -----------------------------------------------------------------------------------------

test("fileIssue creates with labels and returns the URL", async () => {
  const { gh, calls } = fakeGh();
  const r = await fileIssue("Crash", "body", ["bug", "from-ai"], gh);
  expect(r).toMatchObject({ url: "https://github.com/leoawesome/ckanban/issues/42", error: null });
  expect(calls[0].slice(0, 4)).toEqual(["issue", "create", "--repo", "leoawesome/ckanban"]);
  expect(flag(calls[0], "--title")).toBe("Crash");
  expect(calls[0].filter((a, i) => calls[0][i - 1] === "--label")).toEqual(["bug", "from-ai"]);
});

test("fileIssue retries without labels when one is missing", async () => {
  const { gh, calls } = fakeGh((_a, n) => n === 1
    ? { code: 1, stderr: "could not add label: 'from-ai' not found" }
    : { code: 0, stdout: "https://github.com/leoawesome/ckanban/issues/43" });
  const r = await fileIssue("Crash", "body", ["bug", "from-ai"], gh);
  expect(r.url).toBe("https://github.com/leoawesome/ckanban/issues/43");
  expect(calls.length).toBe(2);
  expect(calls[1]).not.toContain("--label");
});

test("fileIssue falls back to the browser when gh is missing or logged out", async () => {
  const missing = await fileIssue("Crash", "body", ["bug"], fakeGh(() => ({ code: -1, stderr: "Executable not found in $PATH: \"gh\"" })).gh);
  expect(missing.url).toBeNull();
  expect(missing.error).toContain("not installed");
  expect(missing.fallbackUrl).toStartWith("https://github.com/leoawesome/ckanban/issues/new?");

  const out = await fileIssue("Crash", "body", ["bug"], fakeGh(() => ({ code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login" })).gh);
  expect(out.error).toContain("not logged in");
  expect(new URL(out.fallbackUrl).searchParams.get("body")).toBe("body");
});

test("submitReport validates the title and labels AI reports", async () => {
  const { gh, calls } = fakeGh();
  await expect(submitReport({ title: "  ", description: "", blocks: [], source: "ui" }, { gh })).rejects.toThrow("title is required");
  await submitReport({ title: "Crash\n in  chat", description: "d", blocks: [], source: "ai" }, { gh });
  expect(flag(calls[0], "--title")).toBe("Crash in chat");
  expect(calls[0]).toContain("from-ai");
});

// --- Draft from a real store, HTTP endpoint and CLI --------------------------------------------

let store: Store;
let server: ReturnType<typeof createServer>;
let gh: ReturnType<typeof fakeGh>;
let repo: string;
let ticketId: string;

beforeAll(async () => {
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  gh = fakeGh();
  server = createServer({ store, bus, board: new Board(store, bus, { claudeBin: "/bin/false" }), port: 0, webDir: tempDir("ck-web-"), gh: gh.gh });
  repo = await makeRepo();
  mkdirSync(join(repo, "src"));
  store.saveProfile({ name: "Repo", slug: "repo", path: repo, baseBranch: "main", maxParallel: 1, createdAt: "" });
  const t = store.createTicket("repo", { title: "Dark mode", body: `Use ${store.root}/x\n![s](/api/attachments/${SHOT})`, status: "review" });
  ticketId = t.id;
  store.updateTicket("repo", t.id, { prUrl: "https://github.com/x/y/pull/1", error: "boom", outcome: "failed", runCount: 1 });
  store.appendActivity("repo", t.id, 1, { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] } });
  store.appendActivity("repo", t.id, 1, { type: "result", result: "Tests failed." });
});
afterAll(() => server.stop(true));

test("draftReport collects env, ticket and log blocks, scrubbed", () => {
  expect(draftReport(store).blocks.map((b) => b.id)).toEqual(["env"]);
  const d = draftReport(store, { slug: "repo", id: ticketId });
  expect(d.blocks.map((b) => b.id)).toEqual(["env", "ticket", "log"]);
  const ticket = d.blocks[1].text;
  expect(ticket).toContain("Dark mode");
  expect(ticket).toContain("Column: review (last run: failed)");
  expect(ticket).toContain("PR: https://github.com/x/y/pull/1");
  expect(ticket).toContain("Error: boom");
  expect(ticket).toContain("Tests failed.");
  expect(ticket).toContain("<ckanban data>/x");
  expect(ticket).not.toContain(store.root);
  expect(d.blocks[2].text).toContain("Bash: bun test");
  expect(d.screenshots).toEqual([`/api/attachments/${SHOT}`]);
  expect(() => draftReport(store, { slug: "repo", id: "nope" })).toThrow("not found");
});

const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("HTTP: draft, then submit with an unticked block", async () => {
  const draft: any = await (await post("/api/bug-report/draft", { profile: "repo", ticketId })).json();
  expect(draft.blocks.length).toBe(3);
  const before = gh.calls.length;
  const r = await post("/api/bug-report", { title: "Run hangs", description: "Steps", profile: "repo", ticketId, include: ["env", "ticket"] });
  expect(r.status).toBe(201);
  const res: any = await r.json();
  expect(res.url).toBe("https://github.com/leoawesome/ckanban/issues/42");
  expect(res.screenshots).toEqual([`/api/attachments/${SHOT}`]);
  const body = flag(gh.calls[before], "--body");
  expect(body).toContain("Steps");
  expect(body).toContain("Dark mode");
  expect(body).not.toContain("<details>");
  expect((await post("/api/bug-report", { title: "" })).status).toBe(400);
  expect((await post("/api/bug-report/draft", { profile: "repo", ticketId: "nope" })).status).toBe(404);
});

test("CLI: report-bug works inside a board run and labels it from-ai", async () => {
  const lines: string[] = [];
  const io = { out: (s: string) => lines.push(s), client: new BoardClient(server.port!), cwd: join(repo, "src"), env: { CKANBAN_TICKET: "repo/t_x" } };
  await ticketCommand(["report-bug", ticketId, "--title", "Crash", "--body", "boom", "--no-logs"], io);
  expect(lines[0]).toContain("Created https://github.com/leoawesome/ckanban/issues/42");
  expect(lines[0]).toContain("1 screenshot(s)");
  const args = gh.calls.at(-1)!;
  expect(args).toContain("from-ai");
  expect(flag(args, "--body")).not.toContain("Last run log");
  // No ticket id: works from any folder.
  await ticketCommand(["report-bug", "--title", "General"], { ...io, cwd: tempDir(), env: {} });
  expect(gh.calls.at(-1)).not.toContain("from-ai");
});
