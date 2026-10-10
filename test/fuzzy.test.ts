import { expect, test } from "bun:test";
import { fuzzyMatch, highlightRuns, rankTickets, type RankRow } from "../web/src/fuzzy";

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
