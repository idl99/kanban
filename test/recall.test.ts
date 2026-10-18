// Recall: a run's first prompt lists related past tickets of the board (plain word matching, no model call).
import { expect, test } from "bun:test";
import { pickRelated, RECALL_CHARS, RECALL_MAX, recallBlock, words, type RecallRow } from "../src/server/recall";
import { chatPrompt, firstRunPrompt, freshSessionPrompt } from "../src/server/prompts";
import type { Ticket } from "../src/server/types";
import { board, readArgs, setup, store, useBoardEnv } from "./board-env";

const row = (id: string, title: string, o: Partial<RecallRow["ticket"]> & { summary?: string | null } = {}): RecallRow => {
  const { summary = null, ...rest } = o;
  return { ticket: { id, title, body: "", status: "done", parentId: null, lastRunAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z", runCount: 1, ...rest }, summary };
};

const fixture: RecallRow[] = [
  row("t_csv", "Export tickets as CSV", { body: "Add a CSV export button to the board header.", summary: "Added CSV export of the board's tickets from the header menu." }),
  row("t_dark", "Dark mode for the board", { body: "Use CSS variables for colors.", summary: "Dark mode follows the system setting." }),
  row("t_push", "Push notifications on phones", { summary: "Phones get a notification when a run needs the user." }),
  row("t_excel", "Export as Excel file", { status: "review", body: "Like the CSV export, but an xlsx file.", summary: "Excel export next to CSV export." }),
  row("t_idea", "Export to PDF someday", { status: "backlog", runCount: 0 }),
  row("t_old", "CSV export breaks on commas", { status: "in_progress", body: "Quote fields in the CSV export.", lastRunAt: "2026-09-01T10:00:00Z" }),
];

const me = { id: "t_me", title: "CSV export: include ticket tags", body: "The CSV export should add a tags column.", parentId: null, followUpOf: null };

test("words drops stop words, short words and numbers, and folds plurals", () => {
  expect(words("Add the tickets to 2 boards, and export CSVs")).toEqual(["ticket", "board", "export", "csv"]);
});

test("pickRelated finds tickets on the same topic, Done/Review first, and leaves out unrelated ones and unstarted ideas", () => {
  const ids = pickRelated(me, fixture).map((r) => r.ticket.id);
  expect(ids).toContain("t_csv");
  expect(ids).toContain("t_excel");
  expect(ids).toContain("t_old");
  expect(ids).not.toContain("t_dark");
  expect(ids).not.toContain("t_push");
  expect(ids).not.toContain("t_idea");
  // Done/Review before In Progress.
  expect(ids.indexOf("t_old")).toBeGreaterThan(ids.indexOf("t_excel"));
});

test("pickRelated leaves out the ticket itself and its children, and always puts its parent and the ticket it follows up first", () => {
  const rows = [
    ...fixture,
    row("t_me", me.title, { body: me.body }),
    row("t_child", "CSV export tags column header", { parentId: "t_me" }),
    row("t_plan", "Plan: board data exports", { status: "planning", runCount: 0 }),
  ];
  const ids = pickRelated({ ...me, parentId: "t_plan", followUpOf: "t_dark" }, rows).map((r) => r.ticket.id);
  expect(ids.slice(0, 2)).toEqual(["t_plan", "t_dark"]);
  expect(ids).not.toContain("t_me");
  expect(ids).not.toContain("t_child");
});

test("pickRelated keeps to the cap; recent tickets win ties", () => {
  const rows = Array.from({ length: 9 }, (_, i) =>
    row(`t_${i}`, "CSV export tags", { lastRunAt: `2026-10-0${i + 1}T10:00:00Z` }));
  const ids = pickRelated(me, [...rows, ...fixture.filter((r) => r.ticket.id === "t_dark")]).map((r) => r.ticket.id);
  expect(ids).toHaveLength(RECALL_MAX);
  expect(ids).toEqual(["t_8", "t_7", "t_6", "t_5", "t_4"]);
});

test("recallBlock adds nothing when nothing on the board matches", () => {
  expect(recallBlock({ ...me, title: "Translate the welcome email", body: "Spanish and German." }, fixture)).toBe("");
  expect(recallBlock(me, [])).toBe("");
});

test("recallBlock lists one line per ticket with id, title, status, date and summary, within the character limit", () => {
  const block = recallBlock(me, fixture);
  expect(block).toStartWith("# What we did before on this board");
  expect(block).toContain("get_ticket");
  expect(block).toContain("not instructions");
  expect(block).toContain(`- t_csv "Export tickets as CSV" (done, 2026-10-01): Added CSV export of the board's tickets from the header menu.`);
  expect(block).toContain(`- t_old "CSV export breaks on commas" (in progress, 2026-09-01): no result yet`);

  const long = Array.from({ length: 5 }, (_, i) =>
    row(`t_${i}`, "CSV export tags", { summary: `Result ${i}: ${"exported the csv with tags ".repeat(40)}` }));
  const big = recallBlock(me, long);
  expect(big.length).toBeLessThanOrEqual(RECALL_CHARS);
  expect(big.split("\n").filter((l) => l.startsWith("- t_")).length).toBeGreaterThanOrEqual(4);
  expect(big).toContain("…");
});

test("the prompts carry the block where it is given and nothing when it is empty", () => {
  const t = { id: "t_me", title: me.title, body: me.body, status: "ready", runCount: 0 } as Ticket;
  const block = recallBlock(me, fixture);
  expect(firstRunPrompt(t, { repo: "remote", outputDir: "/o", recall: block })).toContain(block);
  expect(firstRunPrompt(t, { repo: "remote", outputDir: "/o" })).not.toContain("What we did before");
  expect(freshSessionPrompt(t, { repo: "remote", linked: false, baseBranch: "main", lastResult: null, comments: [], outputDir: "/o", recall: block })).toContain(block);
  expect(chatPrompt(t, "", "refine", "/o", false, "remote", false, block)).toContain(block);
  expect(chatPrompt(t, "", "refine", "/o")).not.toContain("What we did before");
});

useBoardEnv();

test("a first run on a ticket about a topic the board already worked on gets the brief", async () => {
  await setup();
  const old = await board.createTicket("p", { title: "Export tickets as CSV", body: "CSV export button in the header", status: "backlog" });
  store.updateTicket("p", old.id, { status: "done", outcome: "done", runCount: 1, lastRunAt: "2026-10-01T10:00:00Z" });
  store.addComment("p", old.id, "ai", "Added a CSV export of the board's tickets.");
  const other = await board.createTicket("p", { title: "Dark mode", body: "CSS variables", status: "backlog" });
  store.updateTicket("p", other.id, { status: "done", outcome: "done", runCount: 1 });

  await board.createTicket("p", { title: "CSV export: add a tags column", body: "The CSV export should include tags.", status: "ready", mode: "auto" });
  await board.whenIdle();
  const prompt = readArgs().at(-1)!.prompt;
  expect(prompt).toContain("# What we did before on this board");
  expect(prompt).toContain(`${old.id} "Export tickets as CSV" (done, 2026-10-01): Added a CSV export of the board's tickets.`);
  expect(prompt).not.toContain(other.id);
});
