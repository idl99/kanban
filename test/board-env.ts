// Shared setup for the board-*.test.ts files: a fresh store, bus and Board on the fake claude per test.
// Call useBoardEnv() at the top of a test file; the exported bindings are live and change per test.
import { afterEach, beforeEach } from "bun:test";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";
import { makeRepo, readJsonl, tempDir, until } from "./helpers";

export const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");

export let store: Store;
export let bus: Bus;
export let board: Board;
export let argsFile: string;
export let liveSessions: Set<string>;

/** Swap in another Board (a daemon restart, or one with other options). */
export function setBoard(b: Board): Board {
  board = b;
  return b;
}

/** A Board like a restarted daemon's: same store and bus, no live sessions. */
export function restartBoard(): Board {
  return setBoard(new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false }));
}

export async function setup(opts: { git?: boolean; maxParallel?: number } = {}): Promise<Profile> {
  const path = opts.git === false ? tempDir("ck-plain-") : await makeRepo();
  const p: Profile = {
    name: "P", slug: "p", path, baseBranch: "main", maxParallel: opts.maxParallel ?? 1,
    model: null, createdAt: new Date().toISOString(),
  };
  store.saveProfile(p);
  return p;
}

export function readArgs(): { args: string[]; cwd: string; prompt: string }[] {
  return readJsonl(argsFile);
}

/** Claude has been spawned `n` times (it logs its args once it reads its first message). */
export async function untilSpawned(n = 1) {
  await until(() => readArgs().length >= n);
}

/** Messages Claude replayed as read mid-run (steering), in order. */
export const replays = (id: string) =>
  store.readActivity("p", id).map((a: any) => a.event ?? a).filter((e: any) => e.type === "user" && e.isReplay)
    .map((e: any) => e.message.content[0].text as string);

export function useBoardEnv() {
  beforeEach(() => {
    store = new Store(tempDir("ck-home-"));
    bus = new Bus();
    liveSessions = new Set();
    board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async (id) => liveSessions.has(id) });
    argsFile = join(tempDir("ck-args-"), "args.jsonl");
    process.env.FAKE_ARGS_FILE = argsFile;
    // Fake claude saves its sessions here, so runs can resume them.
    process.env.CLAUDE_CONFIG_DIR = tempDir("ck-claude-");
    process.env.FAKE_MODE = "ok";
    process.env.FAKE_PR = "https://github.com/x/y/pull/7";
  });

  afterEach(async () => {
    // shutdown(), not stopAll(): stopping frees a slot and would start the next queued (slow) ticket.
    await board.shutdown();
    delete process.env.FAKE_MODE;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.FAKE_PR;
    delete process.env.FAKE_ARGS_FILE;
  }, 10000);
}
