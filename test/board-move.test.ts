// Board: moving a Backlog ticket to another board.
import { expect, test } from "bun:test";
import { tempDir } from "./helpers";
import { store, board, setup, useBoardEnv } from "./board-env";

useBoardEnv();

async function twoBoards() {
  await setup({ git: false });
  store.saveProfile({ name: "Q", slug: "q", path: tempDir("ck-plain-"), baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() });
}

test("moveTicket makes a Backlog ticket with the title, description and tags on the other board and removes the original", async () => {
  await twoBoards();
  const t = await board.createTicket("p", { title: "Fix login", body: "Details", status: "backlog", tags: ["auth"] });
  store.addComment("p", t.id, "user", "a comment");
  const moved = await board.moveTicket("p", t.id, "q");
  expect(moved).toMatchObject({ title: "Fix login", body: "Details", status: "backlog", tags: ["auth"] });
  expect(moved.id).not.toBe(t.id);
  expect(store.getTicket("p", t.id)).toBeNull();
  expect(store.listTickets("q").map((x) => x.id)).toEqual([moved.id]);
  expect(store.listComments("q", moved.id)).toEqual([]);
});

test("moveTicket refuses a ticket linked to other tickets, in either direction", async () => {
  await twoBoards();
  const a = await board.createTicket("p", { title: "A", body: "", status: "backlog" });
  const child = await board.createTicket("p", { title: "B", body: "", status: "backlog", dependsOn: [a.id] });
  await expect(board.moveTicket("p", a.id, "q")).rejects.toThrow("Can't move: this ticket is linked to other tickets. Remove the links first.");
  await expect(board.moveTicket("p", child.id, "q")).rejects.toThrow("linked to other tickets");
  expect(store.getTicket("p", a.id)).not.toBeNull();
  expect(store.getTicket("p", child.id)).not.toBeNull();
  expect(store.listTickets("q")).toEqual([]);
});

test("moveTicket refuses tickets outside Backlog, the same board and unknown boards", async () => {
  await twoBoards();
  const t = await board.createTicket("p", { title: "Idea", body: "", status: "planning" });
  await expect(board.moveTicket("p", t.id, "q")).rejects.toThrow("Only tickets in Backlog");
  const b = await board.createTicket("p", { title: "Idea 2", body: "", status: "backlog" });
  await expect(board.moveTicket("p", b.id, "p")).rejects.toThrow("already on that board");
  await expect(board.moveTicket("p", b.id, "nope")).rejects.toThrow("not found");
  expect(store.listTickets("q")).toEqual([]);
});

test("a failed move leaves the original untouched and no copy behind", async () => {
  await twoBoards();
  const t = await board.createTicket("p", { title: "Keep me", body: "x", status: "backlog" });
  const real = store.deleteTicket.bind(store);
  store.deleteTicket = (slug: string, id: string) => {
    if (slug === "p") throw new Error("disk error");
    real(slug, id);
  };
  try {
    await expect(board.moveTicket("p", t.id, "q")).rejects.toThrow("disk error");
  } finally {
    store.deleteTicket = real;
  }
  expect(store.getTicket("p", t.id)?.title).toBe("Keep me");
  expect(store.listTickets("q")).toEqual([]);
});
