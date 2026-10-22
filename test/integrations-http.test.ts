import { afterAll, beforeAll, expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { createTicketAction } from "../src/server/integrations/actions";
import { linear } from "../src/server/integrations/linear";
import { Registry } from "../src/server/integrations/registry";
import { Store } from "../src/server/store";
import { dummyProvider } from "./fixtures/dummy-provider";
import { tempDir } from "./helpers";

let server: ReturnType<typeof createServer>;
let store: Store;
let base: string;

beforeAll(() => {
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  const registry = new Registry([linear, dummyProvider({ things: [], polls: 0, fail: null })], [createTicketAction(board)]);
  server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-"), registry });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });

test("the catalog lists every provider with its setup steps and the callback address", async () => {
  const r = await send("GET", "/integrations");
  const b: any = await r.json();
  expect(b.accounts).toEqual([]);
  expect(b.catalog.callbackUrl).toBe(`http://localhost:${server.port}/api/integrations/oauth/callback`);
  expect(b.catalog.providers.map((p: any) => p.id)).toEqual(["linear", "dummy"]);
  const l = b.catalog.providers[0];
  expect(l).toMatchObject({ oauth: true, fields: [] });
  expect(l.steps[0]).toContain("Authorize with Linear");
  expect(l.triggers.map((t: any) => t.label)).toEqual(["Issue created", "Issue assigned"]);
  expect(l.triggers[0].fields.map((f: any) => f.id)).toEqual(["team", "project", "assignee"]);
});

test("accounts: add, list without secrets, options, delete", async () => {
  let r = await send("POST", "/integrations", { provider: "dummy", credentials: { token: "tok-123" } });
  expect(r.status).toBe(201);
  const a: any = await r.json();
  expect(a).toMatchObject({ provider: "dummy", status: "connected", secretsSet: ["token"] });
  expect(JSON.stringify(a)).not.toContain("tok-123");
  expect(JSON.stringify(await (await send("GET", "/integrations")).json())).not.toContain("tok-123");

  r = await send("GET", `/integrations/${a.id}/options?trigger=thing_added&field=color`);
  expect((await r.json() as any[]).map((o) => o.label)).toEqual(["Red", "Blue", "My favorite"]);
  expect((await send("POST", "/integrations", { provider: "nope", credentials: {} })).status).toBe(400);
  expect((await send("POST", `/integrations/${a.id}/authorize`)).status).toBe(400);
  expect((await send("DELETE", `/integrations/${a.id}`)).status).toBe(204);
  expect((await send("DELETE", `/integrations/${a.id}`)).status).toBe(404);
});

test("the sign-in callback refuses a state ckanban did not make, and escapes what it shows", async () => {
  let r = await fetch(`${base}/api/integrations/oauth/callback?state=forged&code=x`);
  expect(r.status).toBe(400);
  expect(r.headers.get("content-type")).toContain("text/html");
  expect(await r.text()).toContain("not valid any more");
  r = await fetch(`${base}/api/integrations/oauth/callback?error=access_denied&error_description=${encodeURIComponent("<script>x</script>")}`);
  expect(r.status).toBe(400);
  const html = await r.text();
  expect(html).not.toContain("<script>x");
  expect(html).toContain("&#60;script&#62;");
});

test("automations: create, edit, switch off, delete over HTTP", async () => {
  const acc: any = await (await send("POST", "/integrations", { provider: "dummy", credentials: { token: "t" } })).json();
  const url = "/profiles/p/loops";
  const body = {
    name: "Reds", accountId: acc.id, trigger: "thing_added", rules: [{ field: "color", op: "is", values: ["red"] }],
    action: { type: "create_ticket", settings: { column: "backlog" } }, instructions: "See {{thing.name}}",
  };
  let r = await send("POST", url, { ...body, instructions: "See {{nope}}" });
  expect(r.status).toBe(400);
  expect(((await r.json()) as any).error).toContain("{{nope}}");

  r = await send("POST", url, body);
  expect(r.status).toBe(201);
  const l: any = await r.json();
  expect(l).toMatchObject({ name: "Reds", state: "ok", enabled: true, version: 1, account: "Dummy · Dum" });
  expect(((await (await send("GET", url)).json()) as any[]).map((x) => x.id)).toEqual([l.id]);

  r = await send("PATCH", `${url}/${l.id}`, { enabled: false, name: "Reds off" });
  expect(await r.json()).toMatchObject({ enabled: false, name: "Reds off" });
  r = await send("POST", `${url}/${l.id}/check`);
  expect(((await r.json()) as any).lastCheckedAt).toBeNull();
  store.saveProfile({ name: "Q", slug: "q", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  r = await send("POST", `${url}/${l.id}/copy`, { to: "q" });
  expect(r.status).toBe(201);
  expect(await r.json()).toMatchObject({ name: "Reds off", enabled: false });
  expect(((await (await send("GET", "/profiles/q/loops")).json()) as any[])).toHaveLength(1);
  expect((await send("POST", `${url}/${l.id}/copy`, { to: "nope" })).status).toBe(404);
  expect((await send("DELETE", `${url}/${l.id}`)).status).toBe(204);
  expect((await send("PATCH", `${url}/${l.id}`, { enabled: true })).status).toBe(404);
});

test("a board run can read but not change integrations or automations", async () => {
  const run = { "x-ckanban-run": "p/t_20261001_aaaa" };
  expect((await send("GET", "/integrations", undefined, run)).status).toBe(200);
  expect((await send("POST", "/integrations", { provider: "dummy", credentials: { token: "t" } }, run)).status).toBe(403);
  expect((await send("POST", "/profiles/p/loops", {}, run)).status).toBe(403);
});
