import { expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { MAX_RUN_CHAIN, MAX_RUN_STARTS } from "../src/server/plan";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

function setup() {
  const store = new Store(tempDir("ck-home-"));
  const board = new Board(store, new Bus(), { claudeBin: "/bin/false" });
  const p = { name: "Rights", slug: "rights", path: tempDir("ck-proj-"), baseBranch: "main", maxParallel: 3, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p);
  const mk = (title: string) => store.createTicket(p.slug, { title, body: "", status: "backlog" });
  // A run in progress on the ticket, as Board.start registers it (no claude here).
  const fakeRun = (id: string, chat?: object) =>
    (board as any).runs.set(`${p.slug}/${id}`, { slug: p.slug, id, stopRequested: false, targetStatus: null, promise: Promise.resolve(), ...(chat ? { chat } : {}) });
  return { store, board, slug: p.slug, mk, fakeRun };
}

test("only an active work run or chat reply gets runner rights: not Planning chats, peer replies or stopping runs", () => {
  const { board, slug, mk, fakeRun } = setup();
  const work = mk("Work");
  const refine = mk("Planning");
  const peer = mk("Peer");
  const chat = mk("Chat");
  const idle = mk("Idle");
  fakeRun(work.id);
  fakeRun(refine.id, { text: "", mode: "refine", user: true });
  fakeRun(peer.id, { text: "q", mode: "act", raw: true, quiet: true });
  fakeRun(chat.id, { text: "do it", mode: "act", user: true });
  expect(board.runnerRights(slug, work.id)?.id).toBe(work.id);
  expect(board.runnerRights(slug, chat.id)?.id).toBe(chat.id);
  expect(board.runnerRights(slug, refine.id)).toBeNull();
  expect(board.runnerRights(slug, peer.id)).toBeNull();
  expect(board.runnerRights(slug, idle.id)).toBeNull();
  (board as any).runs.get(`${slug}/${work.id}`).stopRequested = true;
  expect(board.runnerRights(slug, work.id)).toBeNull();
});

test("runs started by runs: the chain stops at MAX_RUN_CHAIN and one run starts at most MAX_RUN_STARTS", () => {
  const { store, board, slug, mk, fakeRun } = setup();
  const a = mk("A");
  fakeRun(a.id);
  // A run the user started: what it starts is one level deep.
  expect(board.runStart(slug, a.id)).toEqual({ ticketId: a.id, depth: 1 });
  for (let i = 1; i < MAX_RUN_STARTS; i++) board.runStart(slug, a.id);
  expect(() => board.runStart(slug, a.id)).toThrow(`already started ${MAX_RUN_STARTS} other tickets' runs`);

  const b = mk("B");
  fakeRun(b.id);
  board.markStartedBy(slug, b.id, { ticketId: a.id, depth: MAX_RUN_CHAIN - 1 });
  expect(board.runStart(slug, b.id)).toEqual({ ticketId: b.id, depth: MAX_RUN_CHAIN });
  board.markStartedBy(slug, b.id, { ticketId: a.id, depth: MAX_RUN_CHAIN });
  expect(() => board.runStart(slug, b.id)).toThrow(`stops at ${MAX_RUN_CHAIN}`);
  // The user starts it again: the chain starts over.
  board.markStartedBy(slug, b.id, null);
  expect(store.getTicket(slug, b.id)!.startedBy).toBeNull();
  expect(board.runStart(slug, b.id).depth).toBe(1);
});

test("a note from another ticket's run is saved as Claude's and labelled with its ticket", () => {
  const { store, board, slug, mk } = setup();
  const t = mk("T");
  const c = board.addComment(slug, t.id, 'Note from ticket t_x ("X"): replaced', "t_x");
  expect([c.author, c.from]).toEqual(["ai", "t_x"]);
  expect(store.listComments(slug, t.id).at(-1)).toEqual(c);
  expect(board.addComment(slug, t.id, "mine").author).toBe("user");
});
