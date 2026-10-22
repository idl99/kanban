import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "bun:test";
import { Bus } from "../src/server/events";
import { Accounts } from "../src/server/integrations/accounts";
import { linear } from "../src/server/integrations/linear";
import { McpClient, shapeOf } from "../src/server/integrations/mcp-client";
import { Registry } from "../src/server/integrations/registry";
import { AuthError, RateLimitError } from "../src/server/integrations/types";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

let now: Date;
let calls: { url: string; body: any; auth: string | null; session: string | null }[];
let issues: any[];
let tokenReplies: any[];
let respond: ((url: string, body: any) => Response | null) | null;
let sse: boolean;
let lastIssueArgs: any;
let accounts: Accounts;
let callback: string;
let registered: number;
let store: Store;

// As Linear's list_issues answers: `id` is the identifier, names come with ids, empty fields are null when asked for.
const issue = (n: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id: `ENG-${n}`, uuid: `uuid-${n}`, title: `Issue ${n}`, description: `About ${n} (cut short)`, url: `https://linear.app/x/issue/ENG-${n}`,
  createdAt, updatedAt: createdAt, teamId: "team-1", team: "Backend", projectId: null, project: null, assigneeId: null, assignee: null, ...extra,
});

/** What Linear's tools answer (as far as ckanban relies on it). */
/** Linear refuses a larger `limit` than a tool allows, with this message. */
const MAX_LIMIT: Record<string, number> = { list_projects: 50, list_issues: 250, list_teams: 250, list_users: 250 };

const tools: Record<string, (args: any) => unknown> = {
  get_user: () => ({ id: "u-me", name: "Ihan", email: "i@x.io" }),
  get_workspace: () => ({ name: "Respond", urlKey: "respond" }),
  list_teams: () => ({ teams: [{ id: "team-2", name: "Platform" }, { id: "team-1", name: "Backend" }], hasNextPage: false }),
  list_projects: () => ({ projects: [{ id: "alpha-1", uuid: "pr-uuid-1", name: "Alpha" }], hasNextPage: false }),
  list_users: () => ({ users: [{ id: "u-me", name: "Ihan", isActive: true }, { id: "u2", name: "Zed", isActive: true }, { id: "u3", name: "Gone", isActive: false }], hasNextPage: false }),
  get_issue: (args) => ({ id: args.id, description: `Full text of ${args.id}` }),
  list_issues: (args) => {
    const field = args.orderBy === "createdAt" ? "createdAt" : "updatedAt";
    lastIssueArgs = args;
    return { issues: issues.filter((i) => i[field] >= args[field]), hasNextPage: false };
  },
};

const fakeFetch = (async (url: string, init: any) => {
  const text = String(init?.body ?? "");
  const isForm = String(init?.headers?.["content-type"]).includes("form");
  const body = isForm ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text);
  calls.push({ url, body, auth: init?.headers?.authorization ?? null, session: init?.headers?.["mcp-session-id"] ?? null });
  const custom = respond?.(url, body);
  if (custom) return custom;
  if (url.endsWith("/register")) {
    registered++;
    return new Response(JSON.stringify({ client_id: `client-${registered}` }), { status: 201 });
  }
  if (url.endsWith("/token")) {
    const r = tokenReplies.shift();
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }
  if (url.endsWith("/mcp")) {
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const reply = (result: unknown, headers: Record<string, string> = {}) => {
      const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
      return sse
        ? new Response(`event: message\ndata: ${msg}\n\n`, { headers: { "content-type": "text/event-stream", ...headers } })
        : new Response(msg, { headers: { "content-type": "application/json", ...headers } });
    };
    if (body.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: {} }, { "mcp-session-id": "sess-1" });
    if (body.method === "tools/list") return reply({ tools: Object.keys(tools).map((name) => ({ name, description: `d ${name}`, inputSchema: { type: "object" } })) });
    if (body.method === "tools/call") {
      const t = tools[body.params.name];
      const max = MAX_LIMIT[body.params.name];
      if (max && body.params.arguments?.limit > max) {
        return reply({ isError: true, content: [{ type: "text", text: `Input validation error: Invalid arguments for tool ${body.params.name}: limit: Too big: expected number to be <=${max}` }] });
      }
      return t ? reply({ content: [{ type: "text", text: JSON.stringify(t(body.params.arguments)) }] }) : reply({ isError: true, content: [{ type: "text", text: "no such tool" }] });
    }
  }
  return new Response("{}", { status: 500 });
}) as unknown as typeof fetch;

beforeEach(() => {
  now = new Date("2026-10-01T08:00:00.000Z");
  calls = [];
  issues = [];
  tokenReplies = [];
  respond = null;
  sse = false;
  registered = 0;
  callback = "http://localhost:7777/api/integrations/oauth/callback";
  store = new Store(tempDir("ck-home-"));
  accounts = new Accounts(store.root, new Registry([linear], []), new Bus(), { fetch: fakeFetch, now: () => now }, () => callback);
});

const connect = async () => {
  const a = await accounts.add("linear", {});
  const url = new URL(await accounts.authorizeUrl(a.id));
  tokenReplies.push({ body: { access_token: "acc1", refresh_token: "ref1", expires_in: 86400 } });
  await accounts.complete(url.searchParams.get("state")!, "the-code");
  // The diagnostics file is written in the background after sign-in: let it finish so it doesn't mix into a test's calls.
  await Bun.sleep(50);
  calls = [];
  return a.id;
};

test("signing in: ckanban registers itself, sends a one-time proof, and learns who the account is", async () => {
  const a = await accounts.add("linear", {});
  expect(accounts.get(a.id)!.status).toBe("pending");
  const url = new URL(await accounts.authorizeUrl(a.id));
  expect(calls[0]).toMatchObject({ url: "https://mcp.linear.app/register", body: { token_endpoint_auth_method: "none", redirect_uris: [callback], scope: "read" } });
  expect(url.origin + url.pathname).toBe("https://mcp.linear.app/authorize");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    client_id: "client-1", redirect_uri: callback, response_type: "code", scope: "read", code_challenge_method: "S256",
  });
  tokenReplies.push({ body: { access_token: "acc1", refresh_token: "ref1", expires_in: 3600 } });
  const done = await accounts.complete(url.searchParams.get("state")!, "the-code");
  const exchange = calls.find((c) => c.url === "https://mcp.linear.app/token")!;
  expect(exchange.body).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_id: "client-1", redirect_uri: callback });
  expect(exchange.body).not.toHaveProperty("client_secret");
  // The proof sent with the code matches the challenge sent at the start.
  expect(createHash("sha256").update(exchange.body.code_verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge")!);
  expect(calls.filter((c) => c.url.endsWith("/mcp")).every((c) => c.auth === "Bearer acc1")).toBe(true);
  expect(done).toMatchObject({ status: "connected", identity: { userId: "u-me", userName: "Ihan", workspace: "Respond" }, tokens: { access: "acc1", refresh: "ref1" } });
  expect(done.tokens!.expiresAt).toBe("2026-10-01T09:00:00.000Z");
  expect(done.credentials).toEqual({ clientId: "client-1", redirectUri: callback });
});

test("ckanban registers again only when its callback address changed", async () => {
  const a = await accounts.add("linear", {});
  await accounts.authorizeUrl(a.id);
  await accounts.authorizeUrl(a.id);
  expect(registered).toBe(1);
  callback = "http://localhost:7800/api/integrations/oauth/callback";
  const url = new URL(await accounts.authorizeUrl(a.id));
  expect(registered).toBe(2);
  expect(url.searchParams.get("client_id")).toBe("client-2");
  expect(url.searchParams.get("redirect_uri")).toBe(callback);
});

test("a refused registration says so in plain words", async () => {
  const a = await accounts.add("linear", {});
  respond = (url) => (url.endsWith("/register") ? new Response(JSON.stringify({ error: "invalid_redirect_uri" }), { status: 400 }) : null);
  await expect(accounts.authorizeUrl(a.id)).rejects.toThrow("Could not register ckanban with Linear: invalid_redirect_uri");
});

test("Linear turning the new token away is reported as a missing permission", async () => {
  const a = await accounts.add("linear", {});
  const state = new URL(await accounts.authorizeUrl(a.id)).searchParams.get("state")!;
  tokenReplies.push({ body: { access_token: "acc1" } });
  respond = (url) => (url.endsWith("/mcp") ? new Response("{}", { status: 401 }) : null);
  await expect(accounts.complete(state, "code")).rejects.toThrow("did not let ckanban read your issues");
});

test("a sign-in state works once and only for a link ckanban made", async () => {
  const a = await accounts.add("linear", {});
  await expect(accounts.complete("forged", "code")).rejects.toThrow("not valid any more");
  const state = new URL(await accounts.authorizeUrl(a.id)).searchParams.get("state")!;
  tokenReplies.push({ body: { access_token: "acc1" } });
  await accounts.complete(state, "code");
  await expect(accounts.complete(state, "code")).rejects.toThrow("not valid any more");
});

test("Linear refusing the code leaves the account waiting, with the reason", async () => {
  const a = await accounts.add("linear", {});
  const state = new URL(await accounts.authorizeUrl(a.id)).searchParams.get("state")!;
  tokenReplies.push({ status: 400, body: { error: "invalid_grant", error_description: "bad code" } });
  await expect(accounts.complete(state, "code")).rejects.toThrow("Linear refused the sign-in: bad code");
  expect(accounts.get(a.id)).toMatchObject({ status: "pending", error: "Linear refused the sign-in: bad code" });
});

test("an access token about to expire is renewed once, and the new one is saved", async () => {
  const id = await connect();
  now = new Date("2026-10-02T07:59:30.000Z");
  tokenReplies.push({ body: { access_token: "acc2", expires_in: 86400 } });
  const ctx = accounts.context(id)!;
  const [t1, t2] = await Promise.all([ctx.token(), ctx.token()]);
  expect([t1, t2]).toEqual(["acc2", "acc2"]);
  expect(calls.filter((c) => c.body.grant_type === "refresh_token")).toHaveLength(1);
  expect(calls.find((c) => c.body.grant_type === "refresh_token")!.body).toMatchObject({ refresh_token: "ref1" });
  expect(accounts.get(id)!.tokens).toMatchObject({ access: "acc2", refresh: "ref1" });
});

test("a refused renewal marks the connection as needing sign-in", async () => {
  const id = await connect();
  now = new Date("2026-10-02T08:30:00.000Z");
  tokenReplies.push({ status: 400, body: { error: "invalid_grant" } });
  await expect(accounts.context(id)!.token()).rejects.toBeInstanceOf(AuthError);
});

test("Issue created: events carry the filter values and variables, and the cursor moves on", async () => {
  const id = await connect();
  const trigger = linear.triggers.find((t) => t.id === "issue_created")!;
  expect(trigger.initialCursor(now)).toBe("2026-10-01T08:00:00.000Z");
  issues = [
    issue("1", "2026-10-01T07:59:00.000Z"),
    issue("2", "2026-10-01T08:05:00.000Z", { projectId: "pr-uuid-1", project: "Alpha", assigneeId: "u-me", assignee: "Ihan" }),
    issue("3", "2026-10-01T08:06:00.000Z"),
  ];
  const r = await trigger.poll(accounts.context(id)!, trigger.initialCursor(now));
  expect(r.events.map((e) => e.key)).toEqual(["ENG-2", "ENG-3"]);
  expect(r.cursor).toBe("2026-10-01T08:06:00.000Z");
  // Asks for the fields it needs by name, and never for more than a listing allows.
  expect(lastIssueArgs).toMatchObject({ orderBy: "createdAt", createdAt: "2026-10-01T08:00:00.000Z", limit: 50 });
  expect(lastIssueArgs.fields).toEqual(expect.arrayContaining(["projectId", "project", "assigneeId", "teamId"]));
  expect(r.events[0]).toMatchObject({
    title: "ENG-2 Issue 2", url: "https://linear.app/x/issue/ENG-2",
    fields: { team: ["team-1"], project: ["pr-uuid-1", "alpha-1"], assignee: ["u-me"] },
    vars: { "issue.identifier": "ENG-2", "issue.title": "Issue 2", "issue.description": "About 2 (cut short)", "issue.team": "Backend", "issue.project": "Alpha", "issue.assignee": "Ihan" },
  });
  expect(r.events[1].fields).toMatchObject({ project: [], assignee: [] });
  // The full description is fetched only when an event is about to run.
  expect(r.events[0].vars["issue.description"]).toBe("About 2 (cut short)");
  expect(await r.events[0].load!()).toEqual({ "issue.description": "Full text of ENG-2" });
});

test("a project filter matches whichever id Linear gives the issue", async () => {
  const id = await connect();
  const trigger = linear.triggers.find((t) => t.id === "issue_created")!;
  issues = [
    issue("5", "2026-10-01T08:05:00.000Z", { projectId: "pr-uuid-1", project: "Alpha" }),
    issue("6", "2026-10-01T08:06:00.000Z", { projectId: null, project: "Alpha" }),
    issue("7", "2026-10-01T08:07:00.000Z", { projectId: "alpha-1", project: null }),
  ];
  const r = await trigger.poll(accounts.context(id)!, trigger.initialCursor(now));
  expect(r.events).toHaveLength(3);
  for (const e of r.events) expect(e.fields.project).toContain("alpha-1");
});

test("answers that only name the team, project and person still match the rules' ids", async () => {
  const id = await connect();
  const trigger = linear.triggers.find((t) => t.id === "issue_created")!;
  issues = [{ ...issue("9", "2026-10-01T08:05:00.000Z"), teamId: undefined, team: "Platform", project: "Alpha", assignee: "Zed" }];
  const r = await trigger.poll(accounts.context(id)!, trigger.initialCursor(now));
  expect(r.events[0].fields).toEqual({ team: ["team-2"], project: ["alpha-1", "pr-uuid-1"], assignee: ["u2"] });
  // An object reference works too.
  issues = [{ ...issue("8", "2026-10-01T08:05:00.000Z"), teamId: undefined, team: { id: "team-1", name: "Backend" } }];
  expect((await trigger.poll(accounts.context(id)!, trigger.initialCursor(now))).events[0].fields.team).toEqual(["team-1"]);
});

test("Issue assigned: issues with an assignee that changed since the cursor", async () => {
  const id = await connect();
  const trigger = linear.triggers.find((t) => t.id === "issue_assigned")!;
  issues = [
    issue("1", "2026-09-01T00:00:00.000Z", { updatedAt: "2026-10-01T08:10:00.000Z", assigneeId: "u-me", assignee: "Ihan" }),
    issue("2", "2026-09-01T00:00:00.000Z", { updatedAt: "2026-10-01T08:11:00.000Z" }),
    issue("3", "2026-09-01T00:00:00.000Z", { updatedAt: "2026-09-02T00:00:00.000Z", assigneeId: "u2", assignee: "Zed" }),
    issue("4", "2026-10-01T08:13:00.000Z", { assigneeId: "u2", assignee: "Zed" }),
  ];
  const r = await trigger.poll(accounts.context(id)!, trigger.initialCursor(now));
  expect(r.events.map((e) => [e.key, e.at])).toEqual([["ENG-1", "2026-10-01T08:10:00.000Z"], ["ENG-4", "2026-10-01T08:13:00.000Z"]]);
  expect(r.events[0].fields.assignee).toEqual(["u-me"]);
  expect(r.cursor).toBe("2026-10-01T08:13:00.000Z");
});

test("filter pickers: teams, projects and people; 'Me' is the connected user", async () => {
  const id = await connect();
  expect((await accounts.options(id, "issue_created", "team")).map((o) => o.label)).toEqual(["Backend", "Platform"]);
  expect(await accounts.options(id, "issue_created", "project")).toEqual([{ value: "alpha-1", label: "Alpha" }]);
  const people = await accounts.options(id, "issue_assigned", "assignee");
  expect(people).toEqual([{ value: "@me", label: "Me (Ihan)" }, { value: "u-me", label: "Ihan" }, { value: "u2", label: "Zed" }]);
  const assignee = linear.triggers[0].fields.find((f) => f.id === "assignee")!;
  expect(assignee.resolve!("@me", { userId: "u-me", userName: "Ihan", workspace: "R" })).toBe("u-me");
  expect(assignee.resolve!("u2", { userId: "u-me", userName: "Ihan", workspace: "R" })).toBe("u2");
});

test("answers sent as an event stream are read too, and the session is kept", async () => {
  const id = await connect();
  sse = true;
  expect((await accounts.options(id, "issue_created", "team")).length).toBe(2);
  const after = calls.filter((c) => c.url.endsWith("/mcp") && c.body.method !== "initialize");
  expect(after.length).toBeGreaterThan(1);
  expect(after.every((c) => c.session === "sess-1")).toBe(true);
});

test("Linear errors become the errors loops know how to wait on", async () => {
  const id = await connect();
  const trigger = linear.triggers[0];
  const poll = () => trigger.poll(accounts.context(id)!, "2026-10-01T00:00:00.000Z");
  respond = (url) => (url.endsWith("/mcp") ? new Response("{}", { status: 401 }) : null);
  await expect(poll()).rejects.toBeInstanceOf(AuthError);
  respond = (url) => (url.endsWith("/mcp") ? new Response("{}", { status: 429, headers: { "retry-after": "30" } }) : null);
  const err: any = await poll().catch((e) => e);
  expect(err).toBeInstanceOf(RateLimitError);
  expect(err.retryAfterMs).toBe(30_000);
  respond = null;
  tools.list_issues = () => { throw new Error("unused"); };
  respond = (url, body) => (url.endsWith("/mcp") && body.method === "tools/call"
    ? new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "Boom" }] } })) : null);
  await expect(poll()).rejects.toThrow("Boom");
});

test("a sign-in saves how Linear's tools look, without tokens or private text", async () => {
  await connect();
  const file = join(store.root, "integrations-debug", "linear.json");
  expect(existsSync(file)).toBe(true);
  const text = readFileSync(file, "utf8");
  expect(text).not.toContain("acc1");
  expect(text).not.toContain("About 1");
  const d = JSON.parse(text);
  expect(d.tools.map((t: any) => t.name)).toContain("list_issues");
  expect(d.samples.map((s: any) => s.name)).toEqual(["get_user", "get_workspace", "list_teams", "list_projects", "list_users", "list_issues"]);
});

test("shapeOf keeps dates and the structure, and hides other text", () => {
  expect(shapeOf({ id: "abcdef-123", at: "2026-10-01T08:00:00.000Z", n: 3, list: [{ title: "Secret plan" }, { title: "b" }, { title: "c" }], ok: true })).toEqual({
    id: "<text:10>", at: "2026-10-01T08:00:00.000Z", n: 3, list: [{ title: "<text:11>" }, { title: "b" }], ok: true,
  });
});

test("the client works against a server that sends plain JSON and no session", async () => {
  const c = new McpClient("https://x.test/mcp", "t", { now: () => now, fetch: (async (_u: string, init: any) => {
    const b = JSON.parse(init.body);
    if (b.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: b.method === "tools/call" ? { content: [{ type: "text", text: "plain words" }] } : {} }));
  }) as unknown as typeof fetch });
  expect(await c.call("anything")).toBe("plain words");
});
