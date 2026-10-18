// `ckanban ticket setup`: a run installs its ticket's dependencies through the daemon.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BoardClient } from "../src/client";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import { parseSetupBlock } from "../src/server/worktree-setup";
import { ticketCommand } from "../src/ticket-cli";
import { makeRepo, tempDir } from "./helpers";

let store: Store;
let board: Board;
let server: ReturnType<typeof createServer>;
let repo: string;

beforeAll(async () => {
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  board = new Board(store, bus, { claudeBin: "/bin/false" });
  server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-") });
  repo = await makeRepo();
  store.saveProfile({ name: "Repo", slug: "repo", path: repo, baseBranch: "main", maxParallel: 1, createdAt: "", setupCommand: "echo x >> installs.txt; echo deps ok" });
});

afterAll(() => server.stop(true));

/** A ticket with its own copy of the folder, as after its first run started. */
async function ticketWithCopy() {
  const t = store.createTicket("repo", { title: "Code", body: "", status: "review" });
  await board.ensureSession("repo", t.id);
  return store.getTicket("repo", t.id)!;
}

test("CLI: a run installs its ticket's dependencies once; the output ends with the setup block", async () => {
  const t = await ticketWithCopy();
  const lines: string[] = [];
  const io = { out: (s: string) => lines.push(s), client: new BoardClient(server.port!), cwd: t.worktree!, env: { CKANBAN_TICKET: `repo/${t.id}` } };
  await ticketCommand(["setup", `repo/${t.id}`], io);
  expect(lines[0]).toStartWith("Installed the project's dependencies in");
  expect(parseSetupBlock(lines[0])).toMatchObject({ ok: true, output: "deps ok" });
  expect(readFileSync(join(t.worktree!, "installs.txt"), "utf8")).toBe("x\n");
  // The bare id works too (the board comes from the run); now it's already done.
  await ticketCommand(["setup", t.id], io);
  expect(lines[1]).toContain("Already done");
  expect(readFileSync(join(t.worktree!, "installs.txt"), "utf8")).toBe("x\n");
});

test("CLI: a failing setup prints its output and exits with an error", async () => {
  store.saveProfile({ ...store.getProfile("repo")!, setupCommand: "echo cannot install; exit 7" });
  try {
    const t = await ticketWithCopy();
    const lines: string[] = [];
    const io = { out: (s: string) => lines.push(s), client: new BoardClient(server.port!), cwd: tempDir(), env: {} };
    await expect(ticketCommand(["setup", `repo/${t.id}`], io)).rejects.toThrow("Setup failed (exit 7).");
    expect(lines[0]).toContain("failed (exit 7)");
    expect(lines[0]).toContain("cannot install");
  } finally {
    store.saveProfile({ ...store.getProfile("repo")!, setupCommand: "echo x >> installs.txt; echo deps ok" });
  }
});

test("CLI: a run can't run another ticket's setup", async () => {
  const t = await ticketWithCopy();
  const io = { out: () => {}, client: new BoardClient(server.port!), cwd: tempDir(), env: { CKANBAN_TICKET: "repo/t_other" } };
  await expect(ticketCommand(["setup", `repo/${t.id}`], io)).rejects.toThrow("only run the setup of its own ticket");
  expect(store.getTicket("repo", t.id)!.setupPending).toBe(true);
});
