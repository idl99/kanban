// Shared setup for the huddle-*.test.ts files: a store, board, huddles, HTTP server and client on the fake claude per test.
// Call useHuddleEnv() at the top of a test file; the exported bindings are live and change per test.
import { afterEach, beforeEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BoardClient } from "../src/client";
import type { ToolContext } from "../src/mcp-server";
import { Board } from "../src/server/board";
import { Bus, type BusEvent } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Huddles } from "../src/server/huddle";
import { Store } from "../src/server/store";
import type { Huddle, Profile, Ticket } from "../src/server/types";
import { makeRepo, readJsonl, tempDir } from "./helpers";

export { until } from "./helpers";

export const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(p.stderr).text()}`);
  return out;
}

export let store: Store;
export let bus: Bus;
export let board: Board;
export let huddles: Huddles;
export let server: ReturnType<typeof createServer>;
export let client: BoardClient;
export let heardFile: string;
export let argsFile: string;
export let events: BusEvent[];

export async function setup(idleMs = 300, maxParallel = 3) {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  events = [];
  bus.on((e) => events.push(e));
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  huddles = new Huddles(store, board, bus, { claudeBin: FAKE, idleMs });
  server = createServer({ store, bus, board, huddles, port: 0, webDir: tempDir("ck-web-") });
  client = new BoardClient(server.port);
  const p: Profile = { name: "P", slug: "p", path: await makeRepo(), baseBranch: "main", maxParallel, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p);
}

export function useHuddleEnv() {
  beforeEach(async () => {
    heardFile = join(tempDir("ck-heard-"), "heard.jsonl");
    argsFile = join(tempDir("ck-args-"), "args.jsonl");
    process.env.FAKE_HEARD_FILE = heardFile;
    process.env.FAKE_ARGS_FILE = argsFile;
    process.env.CLAUDE_CONFIG_DIR = tempDir("ck-claude-");
    process.env.FAKE_MODE = "ok";
    await setup();
  });

  afterEach(async () => {
    await Promise.all([board.shutdown(), huddles.shutdown()]);
    server.stop(true);
    for (const k of ["FAKE_MODE", "FAKE_ARGS_FILE", "FAKE_HEARD_FILE", "FAKE_STEP_MS", "FAKE_TRANSCRIPT", "CLAUDE_CONFIG_DIR"]) delete process.env[k];
  }, 15000);
}

/** A call to the board's HTTP API under the test profile. */
export const api = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${server.port}/api/profiles/p${path}`, init);
export const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  api(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

export const idle = async () => {
  await huddles.whenIdle();
  await board.whenIdle();
};

/** What each session read, by huddle agent handle (or session id for ticket sessions). */
export function heard(): { who: string; text: string }[] {
  if (!existsSync(heardFile)) return [];
  // A line still being written (fake claudes append concurrently) is skipped until it's complete.
  const parse = (l: string) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  };
  return readFileSync(heardFile, "utf8").trim().split("\n").flatMap(parse).map((x) => ({ who: x.env?.split("/")[1] ?? x.session, text: x.text }));
}
export const heardBy = (who: string) => heard().filter((x) => x.who === who).map((x) => x.text);
export const processes = () => readJsonl(argsFile);

export async function host(): Promise<Ticket> {
  return board.createTicket("p", { title: "Login page", body: "Build it", status: "review" });
}

export function participant(h: Huddle, handle: string) {
  return store.getHuddle("p", h.id)!.participants.find((p) => p.handle === handle)!;
}

/** MCP context of a huddle agent's run (the env the huddle gave its claude process). */
export function agentCtx(h: Huddle, handle: string): ToolContext {
  const p = participant(h, handle);
  return { client, cwd: "/", env: { CKANBAN_TICKET: `p/${h.hostTicket}`, CKANBAN_HUDDLE_AGENT: `${h.id}/${handle}/${p.token}` } };
}
export const mainCtx = (h: Huddle): ToolContext => ({ client, cwd: "/", env: { CKANBAN_TICKET: `p/${h.hostTicket}` } });
export const text = (r: { content: { text: string }[] }) => r.content[0].text;
export const you = (h: Huddle) => store.getHuddle("p", h.id)!.participants.find((p) => p.kind === "human")!;
export const messages = (h: Huddle) => store.readHuddleMessages("p", h.id);
