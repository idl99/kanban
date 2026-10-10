import { expect, test } from "bun:test";
import { findSnippet, fuzzyMatch, highlightRuns, rankTickets, type RankRow } from "../web/src/fuzzy";

type Row = RankRow & { id: string };

const row = (profile: string, title: string, extra: Partial<Row> = {}): Row => ({
  profile, id: `${profile}:${title}`, title, status: "backlog", running: false, updatedAt: "2026-01-01T00:00:00Z", ...extra,
});

test("fuzzyMatch prefers word-start substrings, then substrings, then letters in order", () => {
  const start = fuzzyMatch("Fix usage pill", "usa")!;
  const mid = fuzzyMatch("Causal graph", "usa")!;
  const loose = fuzzyMatch("u s a", "usa")!;
  expect(start.at).toEqual([4, 5, 6]);
  expect(start.score).toBeLessThan(mid.score);
  expect(mid.score).toBeLessThan(loose.score);
  expect(loose.at).toEqual([0, 2, 4]);
  expect(fuzzyMatch("board", "xyz")).toBeNull();
  expect(fuzzyMatch("anything", "  ")).toEqual({ score: 0, at: [] });
});

test("highlightRuns groups matched characters into runs", () => {
  expect(highlightRuns("Add usage", [4, 5, 6])).toEqual([
    { text: "Add ", hit: false }, { text: "usa", hit: true }, { text: "ge", hit: false },
  ]);
});

test("rankTickets puts the current board first within the same kind of match", () => {
  const rows = [row("other", "Usage report"), row("here", "Fix usage pill"), row("here", "u-s-a loose")];
  const ids = rankTickets(rows, "usa", "here").map((h) => h.row.id);
  expect(ids).toEqual(["here:Fix usage pill", "other:Usage report", "here:u-s-a loose"]);
});

test("rankTickets without a query lists active tickets, current board and running first, then most recent", () => {
  const rows = [
    row("other", "old", { updatedAt: "2026-01-01T00:00:00Z" }),
    row("other", "new", { updatedAt: "2026-02-01T00:00:00Z" }),
    row("here", "done", { status: "done" }),
    row("here", "idle"),
    row("here", "busy", { status: "in_progress", running: true }),
  ];
  expect(rankTickets(rows, "", "here").map((h) => h.row.title)).toEqual(["busy", "idle", "new", "old"]);
});

test("rankTickets finds a word only in the result summary, with a snippet, below title matches", () => {
  const rows = [
    row("here", "Board polish", { summary: "Websocket reconnect no longer flakes." }),
    row("other", "Websocket reconnect"),
    row("here", "Wide layout", { body: "Live updates should use a websocket." }),
    row("here", "w-e-b-s-o-c-k-e-t letters"),
  ];
  const hits = rankTickets(rows, "websocket", "here");
  expect(hits.map((h) => h.row.title)).toEqual(["Websocket reconnect", "Board polish", "Wide layout", "w-e-b-s-o-c-k-e-t letters"]);
  const snip = hits[1].snippet!;
  expect(snip.field).toBe("summary");
  expect(hits[1].at).toEqual([]);
  expect(snip.at.map((i) => snip.text[i]).join("")).toBe("Websocket");
  expect(hits[2].snippet!.field).toBe("body");
  expect(hits[0].snippet).toBeUndefined();
});

test("rankTickets matches a PR number", () => {
  const rows = [row("here", "Something", { prUrl: "https://github.com/a/b/pull/123" }), row("here", "Other")];
  const hits = rankTickets(rows, "#123", "here");
  expect(hits.map((h) => h.row.title)).toEqual(["Something"]);
  expect(hits[0].snippet).toEqual({ field: "pr", text: "PR #123", at: [3, 4, 5, 6] });
});

test("findSnippet matches a phrase across whitespace and trims long text around it", () => {
  const text = `${"lorem ipsum ".repeat(20)}rate\n  limit handling ${"dolor sit ".repeat(20)}`;
  const m = findSnippet(text, "rate limit")!;
  expect(m.text.startsWith("…")).toBe(true);
  expect(m.text.endsWith("…")).toBe(true);
  expect(m.at.map((i) => m.text[i]).join("")).toBe("rate limit");
  expect(findSnippet("nothing here", "rate limit")).toBeNull();
});
