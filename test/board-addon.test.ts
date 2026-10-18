// Add-ons: a new requirement on a ticket that already ran becomes its own ticket, linked to the original.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/server/git";
import { chatPrompt, addOnRule } from "../src/server/prompts";
import type { Ticket } from "../src/server/types";
import { addOnFor, addOnLinks, addOnState } from "../web/src/addOn";
import { store, board, setup, useBoardEnv } from "./board-env";

useBoardEnv();

test("moving a Review/Done ticket back to Planning or Backlog remembers where it was; moving on forgets it", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Add export", body: "Export CSV", status: "backlog" });
  store.updateTicket("p", t.id, { status: "done", outcome: "done", runCount: 1 });
  let u = await board.updateTicket("p", t.id, { status: "planning" });
  expect(u.reopenedFrom).toEqual({ status: "done", outcome: "done" });
  await board.whenIdle();
  u = await board.updateTicket("p", t.id, { status: "backlog" });
  expect(u.reopenedFrom).toEqual({ status: "done", outcome: "done" });
  u = await board.updateTicket("p", t.id, { status: "review" });
  expect(u.reopenedFrom).toBeNull();
});

test("addOnTicket makes a linked Backlog ticket and puts the original back in Done, unchanged", async () => {
  await setup();
  const src = await board.createTicket("p", { title: "Add export", body: "Export CSV", status: "backlog", tags: ["ui"] });
  store.updateTicket("p", src.id, { status: "done", outcome: "done", runCount: 1 });
  await board.updateTicket("p", src.id, { status: "planning" });
  // Planning starts a refine chat; the card shows its proposal once that reply is done.
  await board.whenIdle();

  const f = await board.addOnTicket("p", src.id, { title: "Export as Excel too", body: "## Context\nAdd-on to “Add export”" });
  expect(f).toMatchObject({ title: "Export as Excel too", status: "backlog", mode: "auto", addOnOf: src.id, tags: ["ui"] });
  expect(f.startFrom).toBeUndefined();
  const orig = store.getTicket("p", src.id)!;
  expect(orig).toMatchObject({ title: "Add export", body: "Export CSV", status: "done", outcome: "done", reopenedFrom: null });
  expect(orig.addOnOf).toBeUndefined();
});

test("addOnTicket with start queues the add-on; a Done original that never left Done stays put", async () => {
  await setup();
  const src = await board.createTicket("p", { title: "Add export", body: "", status: "backlog" });
  store.updateTicket("p", src.id, { status: "done", outcome: "done", runCount: 1 });
  const f = await board.addOnTicket("p", src.id, { title: "More formats", body: "b", start: true });
  expect(["ready", "in_progress"]).toContain(f.status);
  expect(store.getTicket("p", src.id)!.status).toBe("done");
  await board.whenIdle();
});

test("addOnTicket refuses an empty title", async () => {
  await setup();
  const src = await board.createTicket("p", { title: "Add export", body: "", status: "backlog" });
  await expect(board.addOnTicket("p", src.id, { title: "  ", body: "" })).rejects.toThrow("title is required");
});

test("an add-on to a ticket still in Review builds on its committed work", async () => {
  await setup();
  const src = await board.createTicket("p", { title: "Add export", body: "", status: "ready", mode: "auto" });
  await board.whenIdle();
  const s = store.getTicket("p", src.id)!;
  expect(s.status).toBe("review");
  writeFileSync(join(s.worktree!, "export.ts"), "x\n");
  await run(["git", "add", "."], s.worktree!);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "export"], s.worktree!);

  const f = await board.addOnTicket("p", src.id, { title: "Export as Excel too", body: "b" });
  expect(f.startFrom).toBe(s.branch);
  expect(store.getTicket("p", src.id)!.status).toBe("review");
  await board.updateTicket("p", f.id, { status: "ready" });
  await board.whenIdle();
  const done = store.getTicket("p", f.id)!;
  expect(done.branch).not.toBe(s.branch);
  expect(existsSync(join(done.worktree!, "export.ts"))).toBe(true);
  expect(done.startFrom).toBeNull();
});

test("an add-on to a Done ticket starts from the base branch", async () => {
  await setup();
  const src = await board.createTicket("p", { title: "Add export", body: "", status: "ready", mode: "auto" });
  await board.whenIdle();
  const s = store.getTicket("p", src.id)!;
  writeFileSync(join(s.worktree!, "export.ts"), "x\n");
  await run(["git", "add", "."], s.worktree!);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "export"], s.worktree!);
  store.updateTicket("p", src.id, { status: "done" });

  const f = await board.addOnTicket("p", src.id, { title: "Export as Excel too", body: "b", start: true });
  expect(f.startFrom).toBeUndefined();
  await board.whenIdle();
  expect(existsSync(join(store.getTicket("p", f.id)!.worktree!, "export.ts"))).toBe(false);
});

const ticket = (p: Partial<Ticket>): Ticket => ({
  id: "t_1", title: "Add export", status: "planning", order: 0, sessionId: null, worktree: null, branch: null, prUrl: null,
  outcome: null, lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: "", updatedAt: "", body: "Export CSV", ...p,
});

test("the planning prompt asks for an add-on only on a ticket that already ran", () => {
  expect(addOnRule(ticket({}))).toBe("");
  expect(chatPrompt(ticket({}), "hi", "refine", "/o")).not.toContain("Add-on to");
  const reopened = chatPrompt(ticket({ runCount: 1, reopenedFrom: { status: "done", outcome: "done" } }), "also Excel", "refine", "/o");
  expect(reopened).toContain("This ticket is Done. Treat a new requirement as an add-on");
  expect(reopened).toContain("Add-on to “Add export”");
  expect(addOnRule(ticket({ status: "review", runCount: 1 }))).toContain("is waiting in Review");
  expect(addOnRule(ticket({ runCount: 2 }))).toContain("This ticket already ran.");
});

test("addOnState: Done/Review (also reopened), ran before, or never ran (old tickets without the fields)", () => {
  expect(addOnState({ status: "planning", runCount: 0 })).toBeUndefined();
  expect(addOnState({ status: "backlog", runCount: 0, reopenedFrom: null })).toBeUndefined();
  expect(addOnState({ status: "planning", runCount: 1, reopenedFrom: { status: "done", outcome: "done" } })).toBe("Done");
  expect(addOnState({ status: "planning", runCount: 1, reopenedFrom: { status: "review", outcome: "done" } })).toBe("In review");
  expect(addOnState({ status: "review", runCount: 1 })).toBe("In review");
  expect(addOnState({ status: "planning", runCount: 1 })).toBeNull();
  // A stale reopenedFrom on a ticket that moved on is ignored.
  expect(addOnState({ status: "ready", runCount: 1, reopenedFrom: { status: "done", outcome: "done" } })).toBeNull();
});

test("addOnLinks and addOnFor link both ways, oldest add-on first", () => {
  const a = { id: "a", title: "Add export", status: "done" as const, createdAt: "1" };
  const b = { id: "b", title: "Excel", status: "backlog" as const, addOnOf: "a", createdAt: "3" };
  const c = { id: "c", title: "PDF", status: "ready" as const, addOnOf: "a", createdAt: "2" };
  const orphan = { id: "d", title: "Gone", status: "backlog" as const, addOnOf: "zzz", createdAt: "4" };
  const links = addOnLinks([a, b, c, orphan]);
  expect(links.get("a")!.addOns.map((t) => t.id)).toEqual(["c", "b"]);
  expect(links.get("b")!.of?.id).toBe("a");
  expect(links.get("d")!.of).toBeUndefined();
  expect(addOnFor([a, b, c], "a", " Excel ")?.id).toBe("b");
  expect(addOnFor([a, b, c], "b", "Excel")).toBeUndefined();
});

test("a ticket saved with the old followUpOf field loads as an add-on", async () => {
  await setup();
  const src = await board.createTicket("p", { title: "Add export", body: "", status: "backlog" });
  const t = await board.createTicket("p", { title: "Excel too", body: "", status: "backlog" });
  const file = store.ticketPath("p", t.id);
  writeFileSync(file, readFileSync(file, "utf8").replace(/^---\n/, `---\nfollowUpOf: ${src.id}\n`));
  const loaded = store.getTicket("p", t.id)!;
  expect(loaded.addOnOf).toBe(src.id);
  expect("followUpOf" in loaded).toBe(false);
  // Saved again under the new name.
  store.updateTicket("p", t.id, { title: "Excel too!" });
  expect(readFileSync(file, "utf8")).not.toContain("followUpOf");
  expect(store.getTicket("p", t.id)!.addOnOf).toBe(src.id);
});
