import { beforeEach, expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { mergePr, PrError, refreshPr, resolveConflicts, sendFailures } from "../src/server/prpoller";
import { actionsIds, conflictMessage, failureMessage, mergeBlock, parsePrStatus, PER_CHECK_LOG, TOTAL_LOG } from "../src/server/prstatus";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

const URL = "https://github.com/x/y/pull/7";
const run = (name: string, conclusion: string | null, status = "COMPLETED", job = "11") => ({
  __typename: "CheckRun", name, status, conclusion, detailsUrl: `https://github.com/x/y/actions/runs/99/job/${job}`,
  startedAt: "2026-10-10T10:00:00Z", completedAt: status === "COMPLETED" ? "2026-10-10T10:03:00Z" : "0001-01-01T00:00:00Z",
});
const raw = (over: Record<string, unknown> = {}) => ({
  number: 7, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "",
  statusCheckRollup: [run("test", "SUCCESS"), run("typecheck", "SUCCESS", "COMPLETED", "12")], comments: [], ...over,
});
const green = () => parsePrStatus(URL, raw());

test("parses checks, counts and mergeability", () => {
  const pr = parsePrStatus(URL, raw({
    statusCheckRollup: [
      run("test", "FAILURE"), run("lint", null, "IN_PROGRESS"), run("docs", "SKIPPED"),
      { __typename: "StatusContext", context: "ci/legacy", state: "PENDING", targetUrl: "https://ci.example/1" },
      { __typename: "StatusContext", context: "ci/other", state: "SUCCESS", targetUrl: "" },
    ],
    comments: [{}, {}], mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", reviewDecision: "APPROVED",
  }), "2026-10-10T11:00:00Z");
  expect(pr.checks.map((c) => c.state)).toEqual(["fail", "pending", "skipped", "pending", "pass"]);
  expect(pr.checks[0].at).toBe("2026-10-10T10:03:00Z");
  expect(pr.checks[1].at).toBe("2026-10-10T10:00:00Z");
  expect(pr.checks[4].url).toBeNull();
  expect([pr.failing, pr.pending, pr.comments, pr.number]).toEqual([1, 2, 2, 7]);
  expect(pr.conflicts).toBe(true);
  expect(pr.reviewDecision).toBe("APPROVED");
  expect(pr.fetchedAt).toBe("2026-10-10T11:00:00Z");
});

test("empty review decision and missing rollup", () => {
  const pr = parsePrStatus(URL, { state: "OPEN", mergeable: "UNKNOWN", reviewDecision: "" });
  expect(pr.checks).toEqual([]);
  expect(pr.reviewDecision).toBeNull();
  expect(pr.number).toBe(7);
  expect(pr.mergeable).toBe("UNKNOWN");
});

test("merge guard", () => {
  expect(mergeBlock(green())).toBeNull();
  expect(mergeBlock(parsePrStatus(URL, raw({ statusCheckRollup: [] })))).toBeNull();
  expect(mergeBlock(null)).toMatch(/not loaded/);
  expect(mergeBlock(parsePrStatus(URL, raw({ state: "MERGED" })))).toMatch(/already merged/);
  expect(mergeBlock(parsePrStatus(URL, raw({ state: "CLOSED" })))).toMatch(/closed/);
  expect(mergeBlock(parsePrStatus(URL, raw({ statusCheckRollup: [run("test", "FAILURE")] })))).toBe("1 check failing");
  expect(mergeBlock(parsePrStatus(URL, raw({ statusCheckRollup: [run("test", null, "QUEUED")] })))).toMatch(/still running/);
  expect(mergeBlock(parsePrStatus(URL, raw({ mergeable: "CONFLICTING" })))).toMatch(/conflicts/);
  expect(mergeBlock(parsePrStatus(URL, raw({ mergeable: "UNKNOWN" })))).toMatch(/mergeable/);
  expect(mergeBlock(parsePrStatus(URL, raw({ reviewDecision: "CHANGES_REQUESTED" })))).toMatch(/requested changes/);
  expect(mergeBlock(parsePrStatus(URL, raw({ statusCheckRollup: [run("docs", "SKIPPED")] })))).toBeNull();
});

test("actions ids from details urls", () => {
  expect(actionsIds("https://github.com/x/y/actions/runs/99/job/11")).toEqual({ repo: "x/y", run: "99", job: "11" });
  expect(actionsIds("https://github.com/x/y/actions/runs/99")).toEqual({ repo: "x/y", run: "99", job: null });
  expect(actionsIds("https://ci.example/1")).toBeNull();
  expect(actionsIds(null)).toBeNull();
});

test("failure message names checks, keeps the end of each log and caps the total", () => {
  const pr = parsePrStatus(URL, raw());
  const long = "a".repeat(10_000) + "THE ERROR";
  const msg = failureMessage(pr, [
    { name: "test", log: long, url: null },
    { name: "lint", log: null, url: "https://ci.example/2" },
    { name: "e2e", log: "b".repeat(9_000), url: null },
    { name: "build", log: "c".repeat(9_000), url: null },
    { name: "late", log: "d".repeat(100), url: "https://ci.example/3" },
  ]);
  expect(msg.startsWith(`CI failed on PR #7 (${URL}): test, lint, e2e, build, late.`)).toBe(true);
  expect(msg.endsWith("Fix it and push.")).toBe(true);
  expect(msg).toContain("THE ERROR");
  expect(msg).toContain("earlier chars cut");
  expect(msg).toContain("(no log available; see https://ci.example/2)");
  expect(msg).toContain("(log left out to keep this message short; see https://ci.example/3)");
  // 8k + 8k + 4k of log bodies, plus headings and cut notes.
  expect(msg.match(/b{100,}/)![0].length).toBe(PER_CHECK_LOG);
  expect(msg.match(/c{100,}/)![0].length).toBe(TOTAL_LOG - 2 * PER_CHECK_LOG);
  expect(msg.length).toBeLessThan(TOTAL_LOG + 1_000);
});

let store: Store;
let board: Board;
let id: string;

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  board = new Board(store, new Bus(), { claudeBin: "/bin/false" });
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  id = store.createTicket("p", { title: "x", body: "", status: "review" }).id;
  store.updateTicket("p", id, { prUrl: URL, sessionId: "s1" });
});

test("refresh caches the status on the ticket and reuses a fresh one", async () => {
  let calls = 0;
  const status = async () => (calls++, green());
  await refreshPr(board, store, "p", id, { status });
  expect(store.getTicket("p", id)!.pr?.checks.length).toBe(2);
  await refreshPr(board, store, "p", id, { status, maxAgeMs: 30_000 });
  expect(calls).toBe(1);
  await refreshPr(board, store, "p", id, { status, maxAgeMs: 0 });
  expect(calls).toBe(2);
});

test("refresh of a merged PR moves the card to Done", async () => {
  await refreshPr(board, store, "p", id, { status: async () => parsePrStatus(URL, raw({ state: "MERGED" })) });
  expect(store.getTicket("p", id)!.status).toBe("done");
});

test("merge & done squash-merges a green PR and moves the card to Done", async () => {
  const merged: string[] = [];
  const t = await mergePr(board, store, "p", id, { status: async () => green(), merge: async (u) => (merged.push(u), { ok: true, error: "" }) });
  expect(merged).toEqual([URL]);
  expect(t.status).toBe("done");
  expect(t.pr?.state).toBe("MERGED");
  expect(store.listComments("p", id).filter((c) => c.text === "PR merged.").length).toBe(1);
});

test("merge is refused when the fresh status changed since the UI loaded", async () => {
  board.setPr("p", id, green());
  let mergeCalled = false;
  const failing = async () => parsePrStatus(URL, raw({ statusCheckRollup: [run("test", "FAILURE")] }));
  const err = await mergePr(board, store, "p", id, { status: failing, merge: async () => ((mergeCalled = true), { ok: true, error: "" }) }).catch((e) => e);
  expect(err).toBeInstanceOf(PrError);
  expect(err.status).toBe(409);
  expect(err.message).toMatch(/1 check failing/);
  expect(mergeCalled).toBe(false);
  expect(store.getTicket("p", id)!.status).toBe("review");
  expect(store.getTicket("p", id)!.pr?.failing).toBe(1);
});

test("gh merge failure leaves the ticket in Review with gh's error", async () => {
  const err = await mergePr(board, store, "p", id, {
    status: async () => green(), merge: async () => ({ ok: false, error: "GraphQL: Base branch policy prohibits the merge" }),
  }).catch((e) => e);
  expect(err.message).toBe("GraphQL: Base branch policy prohibits the merge");
  expect(store.getTicket("p", id)!.status).toBe("review");
  expect(store.listComments("p", id).length).toBe(0);
});

test("merge needs a Review ticket with a PR", async () => {
  store.updateTicket("p", id, { prUrl: null });
  expect((await mergePr(board, store, "p", id, { status: async () => green() }).catch((e) => e)).status).toBe(400);
});

test("send failures chats the failing checks and their logs to the ticket", async () => {
  let sent = "";
  board.chat = async (s, i, text) => ((sent = text), store.getTicket(s, i)!);
  const pr = async () => parsePrStatus(URL, raw({ statusCheckRollup: [run("test", "FAILURE"), run("lint", "SUCCESS", "COMPLETED", "12")] }));
  const asked: string[] = [];
  await sendFailures(board, store, "p", id, { status: pr, failedLog: async (c) => (asked.push(c.name), "expected 1 got 2") });
  expect(asked).toEqual(["test"]);
  expect(sent).toContain("CI failed on PR #7");
  expect(sent).toContain("expected 1 got 2");
  expect(sent).not.toContain("lint");
});

test("send failures refuses when nothing fails any more", async () => {
  board.chat = async () => { throw new Error("should not chat"); };
  const err = await sendFailures(board, store, "p", id, { status: async () => green() }).catch((e) => e);
  expect(err.status).toBe(409);
});


test("resolve conflicts chats the rebase instructions to the ticket", async () => {
  let sent = "";
  board.chat = async (s, i, text) => ((sent = text), store.getTicket(s, i)!);
  await resolveConflicts(board, store, "p", id, { status: async () => parsePrStatus(URL, raw({ mergeable: "CONFLICTING" })) });
  expect(sent).toContain("PR #7");
  expect(sent).toContain("rebase");
  expect(sent).toContain("--force-with-lease");
  expect(store.getTicket("p", id)!.pr?.conflicts).toBe(true);
});

test("resolve conflicts refuses without conflicts or while Claude runs", async () => {
  board.chat = async () => { throw new Error("should not chat"); };
  expect((await resolveConflicts(board, store, "p", id, { status: async () => green() }).catch((e) => e)).status).toBe(409);
  board.isRunning = () => true;
  const conflicting = async () => parsePrStatus(URL, raw({ mergeable: "CONFLICTING" }));
  expect((await resolveConflicts(board, store, "p", id, { status: conflicting }).catch((e) => e)).status).toBe(409);
});

test("conflict message names the base branch and keeps force pushes on the ticket branch", () => {
  const msg = conflictMessage(parsePrStatus(URL, raw({ mergeable: "CONFLICTING" })), "main");
  expect(msg).toContain("origin/main");
  expect(msg).toContain("both sides' intent");
  expect(msg).toContain("this ticket's branch only");
  expect(conflictMessage(green(), "")).toContain("the remote base branch");
});

test("card chips and the UI's merge guard match the server", async () => {
  const web = await import("../web/src/prText");
  const cases = [
    raw(), raw({ statusCheckRollup: [] }), raw({ state: "MERGED" }), raw({ state: "CLOSED" }),
    raw({ statusCheckRollup: [run("test", "FAILURE"), run("lint", "FAILURE")] }), raw({ statusCheckRollup: [run("test", null, "QUEUED")] }),
    raw({ mergeable: "CONFLICTING" }), raw({ mergeable: "UNKNOWN" }), raw({ reviewDecision: "CHANGES_REQUESTED" }),
  ].map((r) => parsePrStatus(URL, r));
  for (const pr of cases) expect(web.mergeBlock(pr)).toBe(mergeBlock(pr));
  const chips = (r: Record<string, unknown>) => web.prChips(parsePrStatus(URL, raw(r))).map((c) => c.label);
  expect(chips({})).toEqual(["✓ checks"]);
  expect(chips({ statusCheckRollup: [run("test", "FAILURE")], comments: [{}, {}] })).toEqual(["✗ 1 failing", "2 comments"]);
  expect(chips({ statusCheckRollup: [run("test", null, "IN_PROGRESS")], mergeable: "CONFLICTING" })).toEqual(["● running", "conflicts"]);
  expect(chips({ statusCheckRollup: [] })).toEqual([]);
  expect(chips({ state: "MERGED" })).toEqual([]);
  expect(web.currentPr({ prUrl: "https://github.com/x/y/pull/8", pr: green() })).toBeNull();
});
