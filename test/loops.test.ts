import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus, type BusEvent } from "../src/server/events";
import { Accounts } from "../src/server/integrations/accounts";
import { createTicketAction } from "../src/server/integrations/actions";
import { Registry } from "../src/server/integrations/registry";
import { AuthError, RateLimitError, type ActionDef } from "../src/server/integrations/types";
import { LoopManager } from "../src/server/loops";
import { Store } from "../src/server/store";
import { dummyProvider, type Thing } from "./fixtures/dummy-provider";
import { tempDir } from "./helpers";

let store: Store;
let board: Board;
let bus: Bus;
let events: BusEvent[];
let now: Date;
let world: { things: Thing[]; polls: number; fail: Error | null; load?: "ok" | "fail" };
let registry: Registry;
let accounts: Accounts;
let loops: LoopManager;
let accountId: string;
let failAction: Error | null;

const minute = (n: number) => new Date(Date.UTC(2026, 9, 1, 8, n)).toISOString();
const thing = (id: string, n: number, color = "red", size = "s"): Thing => ({ id, name: `Name ${id}`, color, size, at: minute(n) });
const tickets = () => store.listTickets("p");
const input = (extra: Record<string, unknown> = {}) => ({
  name: "Reds", accountId, trigger: "thing_added", rules: [{ field: "color", op: "is", values: ["red"] }],
  action: { type: "create_ticket", settings: { column: "backlog" } }, instructions: "Look at {{thing.name}}: {{thing.color}}", ...extra,
});

function build() {
  const deps = { fetch: (async () => new Response("{}")) as unknown as typeof fetch, now: () => now };
  const real = createTicketAction(board);
  // Wraps the real action so a test can make it fail once.
  const action: ActionDef = { ...real, run: async (ctx, s) => { if (failAction) throw failAction; return real.run(ctx, s); } };
  registry = new Registry([dummyProvider(world)], [action]);
  accounts = new Accounts(store.root, registry, bus, deps, () => "http://localhost:1/cb");
  loops = new LoopManager(store, bus, registry, accounts, deps);
}

beforeEach(async () => {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  events = [];
  bus.on((e) => events.push(e));
  board = new Board(store, bus, { claudeBin: "/bin/false" });
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  now = new Date(minute(0));
  world = { things: [thing("old", -30)], polls: 0, fail: null };
  failAction = null;
  build();
  accountId = (await accounts.add("dummy", { token: "secret-token" })).id;
});

afterEach(() => board.whenIdle());

test("create checks the loop in plain words", async () => {
  await expect(loops.create("p", input({ name: " " }))).rejects.toThrow("Give the automation a name");
  await expect(loops.create("p", input({ accountId: "nope" }))).rejects.toThrow("Pick a connection");
  await expect(loops.create("p", input({ trigger: "x" }))).rejects.toThrow("Pick what starts it (Thing added)");
  await expect(loops.create("p", input({ rules: [{ field: "size", op: "is_not", values: ["l"] }] }))).rejects.toThrow("Size can't use");
  await expect(loops.create("p", input({ match: "xor" }))).rejects.toThrow('Match must be "all" or "any"');
  await expect(loops.create("p", input({ action: { type: "boom" } }))).rejects.toThrow('Unknown action "boom"');
  await expect(loops.create("p", input({ action: { type: "create_ticket", settings: { column: "done" } } }))).rejects.toThrow("Ready, Planning or Backlog");
  await expect(loops.create("p", input({ instructions: "Hi {{thing.nam}}" }))).rejects.toThrow("Unknown variable in the instructions: {{thing.nam}}");
  await expect(loops.create("p", input({ instructions: "  " }))).rejects.toThrow("Write the instructions");
  expect(store.listLoops("p")).toHaveLength(0);
});

test("a new loop only looks forward, then makes one ticket per matching event", async () => {
  const l = await loops.create("p", input());
  expect(l).toMatchObject({ state: "ok", account: "Dummy · Dum", enabled: true });
  await loops.tick();
  expect(tickets()).toHaveLength(0);

  world.things.push(thing("a", 2), thing("b", 3, "blue"), thing("c", 4));
  now = new Date(minute(5));
  await loops.tick();
  const made = tickets().sort((x, y) => x.title.localeCompare(y.title));
  expect(made.map((t) => t.title)).toEqual(["Thing Name a", "Thing Name c"]);
  expect(made[0]).toMatchObject({
    status: "backlog", body: "Look at Name a: red",
    source: { provider: "Dummy", label: "Thing Name a", url: "https://dummy.test/a", loopId: l.id },
  });
  const after = store.getLoop("p", l.id)!;
  expect(after).toMatchObject({ lastError: null, lastCheckedAt: now.toISOString(), lastFiredAt: now.toISOString() });
});

test("what a list left out is fetched only for an event that runs, and a failed fetch doesn't stop it", async () => {
  await loops.create("p", input({ rules: [{ field: "color", op: "is", values: ["red"] }] }));
  world.load = "ok";
  world.things.push(thing("a", 1), thing("b", 2, "blue"));
  await loops.tick();
  expect(tickets().map((t) => t.body)).toEqual(["Look at Full Name a: red"]);

  world.load = "fail";
  world.things.push(thing("c", 3));
  await loops.tick();
  expect(tickets().map((t) => t.body).sort()).toEqual(["Look at Full Name a: red", "Look at Name c: red"]);
});

test("the same event never makes two tickets, also after a restart", async () => {
  await loops.create("p", input());
  world.things.push(thing("a", 2));
  await loops.tick();
  await loops.tick();
  expect(tickets()).toHaveLength(1);

  build();
  await loops.tick();
  expect(tickets()).toHaveLength(1);
  // Not seen at the cursor any more or still seen: handled keys decide, not the cursor.
  store.saveLoopState("p", store.listLoops("p")[0].id, { ...store.getLoopState("p", store.listLoops("p")[0].id), cursor: minute(-60) });
  await loops.tick();
  expect(tickets().filter((t) => t.title === "Thing Name a")).toHaveLength(1);
});

test("AND / OR / IS NOT rules decide which events count", async () => {
  await loops.create("p", input({ name: "or", match: "any", rules: [{ field: "color", op: "is", values: ["blue"] }, { field: "size", op: "is", values: ["l"] }] }));
  await loops.create("p", input({ name: "not", rules: [{ field: "color", op: "is_not", values: ["red", "blue"] }] }));
  world.things.push(thing("a", 1, "red", "l"), thing("b", 2, "green", "s"), thing("c", 3, "red", "s"));
  await loops.tick();
  const byLoop = (name: string) => tickets().filter((t) => store.getLoop("p", t.source!.loopId)!.name === name).map((t) => t.title).sort();
  expect(byLoop("or")).toEqual(["Thing Name a"]);
  expect(byLoop("not")).toEqual(["Thing Name b"]);
});

test("a disabled loop does not poll; switching it on starts from now", async () => {
  const l = await loops.create("p", input({ enabled: false }));
  world.things.push(thing("a", 1));
  await loops.tick();
  expect(world.polls).toBe(0);

  now = new Date(minute(10));
  await loops.update("p", l.id, { enabled: true });
  await loops.tick();
  expect(tickets()).toHaveLength(0);
  world.things.push(thing("b", 11));
  await loops.tick();
  expect(tickets().map((t) => t.title)).toEqual(["Thing Name b"]);
});

test("a failing check waits before trying again and says why", async () => {
  const l = await loops.create("p", input());
  world.fail = new Error("network down");
  await loops.tick();
  expect(world.polls).toBe(1);
  expect(store.getLoop("p", l.id)!.lastError).toBe("network down");

  await loops.tick();
  expect(world.polls).toBe(1);
  now = new Date(minute(3));
  world.things.push(thing("a", 3));
  await loops.tick();
  expect(world.polls).toBe(2);
  expect(tickets()).toHaveLength(0);

  // The wait doubles: 4 minutes after the second failure.
  now = new Date(minute(5));
  await loops.tick();
  expect(world.polls).toBe(2);
  world.fail = null;
  now = new Date(minute(8));
  await loops.tick();
  expect(tickets()).toHaveLength(1);
  expect(store.getLoop("p", l.id)!.lastError).toBeNull();
});

test("a rate limit waits as long as the service asks", async () => {
  await loops.create("p", input());
  world.fail = new RateLimitError("slow down", 10 * 60_000);
  await loops.tick();
  now = new Date(minute(9));
  await loops.tick();
  expect(world.polls).toBe(1);
  now = new Date(minute(11));
  await loops.tick();
  expect(world.polls).toBe(2);
});

test("a refused connection shows as needing sign-in and stops polling", async () => {
  const l = await loops.create("p", input());
  world.fail = new AuthError("token revoked");
  await loops.tick();
  expect(accounts.get(accountId)).toMatchObject({ status: "needs_reconnect", error: "token revoked" });
  expect(loops.view(store.getLoop("p", l.id)!)).toMatchObject({ state: "needs_reconnect" });
  world.fail = null;
  now = new Date(minute(60));
  await loops.tick();
  expect(world.polls).toBe(1);
});

test("an action that fails is retried on the next check, once", async () => {
  await loops.create("p", input());
  world.things.push(thing("a", 1));
  failAction = new Error("disk full");
  await loops.tick();
  expect(tickets()).toHaveLength(0);
  expect(store.listLoops("p")[0].lastError).toBe("disk full");
  failAction = null;
  now = new Date(minute(3));
  await loops.tick();
  await loops.tick();
  expect(tickets()).toHaveLength(1);
});

test("loops this version can't run stay on disk, can be switched off and deleted", async () => {
  const l = await loops.create("p", input());
  const raw = { ...store.getLoop("p", l.id)!, provider: "gone", trigger: "other" };
  store.saveLoop("p", raw);
  const newer = { ...store.getLoop("p", l.id)!, id: "newer1", version: 9, provider: "dummy", trigger: "thing_added" };
  store.saveLoop("p", newer);
  const odd = { ...newer, id: "odd1", version: 1, rules: [{ field: "weather", op: "is" as const, values: ["x"] }], action: { type: "teleport", settings: {} } };
  store.saveLoop("p", odd);

  const views = loops.list("p");
  const byId = (id: string) => views.find((v) => v.id === id)!;
  expect(views.map((v) => v.state)).toEqual(["unsupported", "unsupported", "unsupported"]);
  expect(byId(l.id).problems[0]).toContain('"gone" integration is not available');
  expect(byId("newer1").problems[0]).toContain("newer ckanban");
  expect(byId("odd1").problems.join(" ")).toContain('"weather" filter');
  expect(byId("odd1").problems.join(" ")).toContain('"teleport" action');

  world.things.push(thing("a", 1));
  await loops.tick();
  expect(world.polls).toBe(0);
  expect(store.listLoops("p")).toHaveLength(3);

  expect((await loops.update("p", l.id, { enabled: false })).enabled).toBe(false);
  await expect(loops.update("p", "newer1", { name: "x" })).rejects.toThrow("newer ckanban");
  await loops.remove("p", "newer1");
  expect(store.getLoop("p", "newer1")).toBeNull();
});

test("a removed connection is shown on the loop and nothing is polled", async () => {
  const l = await loops.create("p", input());
  accounts.remove(accountId);
  expect(loops.view(store.getLoop("p", l.id)!)).toMatchObject({ state: "no_connection", account: null });
  await loops.tick();
  expect(world.polls).toBe(0);
});

test("connections: secrets are private to the owner and never shown", async () => {
  const file = join(store.root, "integrations.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toContain("secret-token");
  const view = accounts.view(accounts.get(accountId)!);
  expect(JSON.stringify(view)).not.toContain("secret-token");
  expect(view).toMatchObject({ status: "connected", secretsSet: ["token"], credentials: {}, identity: { userName: "Dum", workspace: "Dummyland" } });
  await expect(accounts.add("dummy", { token: "bad" })).rejects.toThrow("Could not check the account: bad token");
  await expect(accounts.add("dummy", {})).rejects.toThrow("Token is required");
  expect(accounts.list()).toHaveLength(1);
});

test("the catalog describes a new provider with no UI code", () => {
  const c = registry.catalog("http://localhost:1/cb");
  expect(c.providers).toHaveLength(1);
  expect(c.providers[0]).toMatchObject({ id: "dummy", name: "Dummy", oauth: false, fields: [{ id: "token", secret: true }] });
  expect(c.providers[0].triggers[0]).toMatchObject({
    id: "thing_added",
    fields: [{ id: "color", pick: true, operators: ["is", "is_not"] }, { id: "size", pick: false, operators: ["is"] }],
    variables: [{ name: "thing.name" }, { name: "thing.color" }],
  });
  expect(c.actions.map((a) => a.id)).toEqual(["create_ticket"]);
});

test("filter values load from the account", async () => {
  expect((await accounts.options(accountId, "thing_added", "color")).map((o) => o.value)).toEqual(["red", "blue", "@favorite"]);
  expect(await accounts.options(accountId, "thing_added", "size")).toEqual([]);
  expect(events.some((e) => e.type === "integration.updated")).toBe(true);
});

test("a loop can be copied to another board: switched off, same settings, clean memory", async () => {
  store.saveProfile({ name: "Q", slug: "q", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  const l = await loops.create("p", input({ match: "any", rules: [{ field: "color", op: "is_not", values: ["blue"] }, { field: "size", op: "is", values: ["l"] }] }));
  world.things.push(thing("a", 1));
  await loops.tick();
  expect(tickets()).toHaveLength(1);

  const copy = await loops.copy("p", l.id, "q");
  expect(copy).toMatchObject({
    name: "Reds", enabled: false, accountId, trigger: "thing_added", match: "any", state: "ok",
    action: { type: "create_ticket", settings: { column: "backlog" } }, instructions: l.instructions, lastFiredAt: null,
  });
  expect(copy.id).not.toBe(l.id);
  expect(copy.rules).toEqual(l.rules);
  expect(loops.list("p")).toHaveLength(1);
  expect(store.getLoopState("q", copy.id).handled).toEqual([]);

  // Switched on, the copy looks forward only and makes its own tickets on its own board.
  now = new Date(minute(5));
  await loops.update("q", copy.id, { enabled: true });
  await loops.tick();
  expect(store.listTickets("q")).toHaveLength(0);
  world.things.push(thing("b", 6));
  now = new Date(minute(7));
  await loops.tick();
  expect(store.listTickets("q").map((t) => t.title)).toEqual(["Thing Name b"]);
  expect(store.listTickets("q")[0].source!.loopId).toBe(copy.id);
});

test("copying fails in plain words for a missing board or a loop this version can't run", async () => {
  const l = await loops.create("p", input());
  expect(() => loops.copy("p", l.id, "nope")).toThrow("board nope not found");
  expect(() => loops.copy("p", "missing1", "p")).toThrow("not found");
  store.saveLoop("p", { ...store.getLoop("p", l.id)!, provider: "gone" });
  expect(() => loops.copy("p", l.id, "p")).toThrow("can't be copied");
});
