import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../src/server/events";
import { envNameFor, maskText, PassError, Passes } from "../src/server/integrations/passes";
import { readScopes, resourceMetadataUrl } from "../src/server/integrations/oauth";
import { startFakeService, type FakeService } from "./fixtures/fake-mcp-service";
import { tempDir } from "./helpers";

let root: string;
let svc: FakeService;
let passes: Passes;
let now: Date;
let configFile: string;

function build(o: { registration?: boolean; expiresIn?: number; authorizeEndpoint?: string } = {}) {
  svc?.stop();
  svc = startFakeService(o);
  passes = new Passes(root, new Bus(), { fetch, now: () => now }, () => "http://localhost:7777/api/passes/oauth/callback", { configFile, home: root });
}

beforeEach(() => {
  root = tempDir("ck-passes-");
  configFile = join(root, ".claude.json");
  now = new Date("2026-10-22T08:00:00Z");
  build();
});
afterEach(() => svc.stop());

async function signIn(): Promise<string> {
  const p = await passes.add({ kind: "mcp", name: "Tracker", url: svc.url });
  expect(p.status).toBe("pending");
  const url = await passes.authorizeUrl(p.id);
  const { code, state } = svc.approve(url);
  await passes.complete(state, code);
  return p.id;
}

test("signs in to any MCP server by itself: finds its sign-in, registers, PKCE, a token bound to the server", async () => {
  const id = await signIn();
  const p = passes.get(id)!;
  expect(p.status).toBe("connected");
  // It asks only for the read-only scopes the server offers.
  expect(p.oauth).toMatchObject({ scope: "read", resource: svc.url, authorizationEndpoint: `${svc.origin}/authorize`, redirectUri: "http://localhost:7777/api/passes/oauth/callback" });
  // The sign-in checked that the token can list the tools.
  expect(await passes.tools(id)).toEqual([{ name: "list_issues", description: "Issues assigned to you" }, { name: "delete_issue" }]);
  svc.issues = [{ id: "1", title: "Fix", url: "https://x/1" }];
  expect(await passes.call(id, "list_issues", {})).toEqual({ issues: svc.issues });
  // The passes file is for the owner only and the view has no secrets.
  expect(statSync(join(root, "automation-passes.json")).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(passes.view(p))).not.toContain(p.tokens!.access);
});

test("the sign-in state works once and only for the address it was made for", async () => {
  const p = await passes.add({ kind: "mcp", name: "Tracker", url: svc.url });
  const { code, state } = svc.approve(await passes.authorizeUrl(p.id));
  await passes.complete(state, code);
  await expect(passes.complete(state, code)).rejects.toThrow("not valid any more");
  await expect(passes.complete("made-up", "x")).rejects.toThrow("not valid any more");
});

test("a server that can't register clients asks for a key instead", async () => {
  build({ registration: false });
  const p = await passes.add({ kind: "mcp", name: "Tracker", url: svc.url });
  const e = await passes.authorizeUrl(p.id).catch((x) => x);
  expect(e).toBeInstanceOf(PassError);
  expect(e.code).toBe("no_registration");
  expect(e.message).toContain("Paste a key");
});

test("an expiring token is renewed once, in one place, even for calls at the same time", async () => {
  build({ expiresIn: 3600 });
  const id = await signIn();
  now = new Date(now.getTime() + 3600_000);
  await Promise.all([passes.call(id, "list_issues", {}), passes.call(id, "list_issues", {})]);
  expect(svc.tokenRequests.filter((g) => g === "refresh_token")).toHaveLength(1);
  expect(passes.get(id)!.status).toBe("connected");
});

test("a key for scripts goes out as one environment variable, only to the automations that use it", async () => {
  const k = await passes.add({ kind: "key", name: "Jira token", secret: "jira-secret-123" });
  const other = await passes.add({ kind: "key", name: "Other", envName: "OTHER_KEY", secret: "other-secret-456" });
  expect(k.envName).toBe("JIRA_TOKEN");
  expect(passes.envFor([k.id])).toEqual({ JIRA_TOKEN: "jira-secret-123" });
  expect(passes.envFor([other.id, "nope"])).toEqual({ OTHER_KEY: "other-secret-456" });
  await expect(passes.add({ kind: "key", name: "x", envName: "PATH", secret: "s" })).rejects.toThrow("can't be used");
  await expect(passes.add({ kind: "key", name: "y", envName: "JIRA_TOKEN", secret: "s" })).rejects.toThrow("already exists");
  // A key can't be called like a service.
  await expect(passes.call(k.id, "x", {})).rejects.toThrow("key for scripts");
});

test("a key for an MCP server is its bearer token", async () => {
  const id = await signIn();
  const token = passes.get(id)!.tokens!.access;
  const k = await passes.add({ kind: "key", name: "Tracker key", url: svc.url, secret: token });
  expect(passes.envFor([k.id])).toEqual({});
  await passes.call(k.id, "list_issues", {});
  expect(svc.calls.at(-1)!.token).toBe(token);
});

test("a program on this computer starts from Claude's own settings, read again each time; never from a project's .mcp.json", async () => {
  const log = join(root, "stdio.log");
  const fixture = join(import.meta.dir, "fixtures", "fake-stdio-mcp.ts");
  const write = (greeting: string) => writeFileSync(configFile, JSON.stringify({
    mcpServers: { helper: { command: process.execPath, args: [fixture], env: { FAKE_GREETING: greeting, FAKE_STDIO_LOG: log } } },
  }));
  write("hello");
  const p = await passes.add({ kind: "local", claudeName: "helper" });
  expect(await passes.call(p.id, "greet", { who: "me" })).toEqual({ greeting: "hello", args: { who: "me" } });
  write("changed");
  expect(await passes.call(p.id, "greet", {})).toMatchObject({ greeting: "changed" });
  expect(readFileSync(log, "utf8")).toContain("tools/call");

  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { planted: { command: "/bin/echo" } } }));
  await expect(passes.add({ kind: "local", claudeName: "planted" })).rejects.toThrow(".mcp.json");
});

test("secrets are hidden in text for the UI and logs", async () => {
  const k = await passes.add({ kind: "key", name: "Jira", secret: "jira-secret-123" });
  expect(passes.mask(`curl -H "Authorization: jira-secret-123" failed`)).toBe(`curl -H "Authorization: ***" failed`);
  expect(maskText("Authorization: Bearer abcdefghijklmnop", [])).toBe("Authorization: Bearer ***");
  expect(maskText('{"access_token":"zzz"}', [])).toBe('{"access_token":"***"}');
  passes.remove(k.id);
  expect(envNameFor("Linear API key")).toBe("LINEAR_API_KEY");
  expect(envNameFor("Jira")).toBe("JIRA_KEY");
  expect(readScopes(["read", "write", "openid"])).toEqual(["read"]);
  expect(readScopes(["org:read", "project:write", "issues.read", "read:all", "bread"])).toEqual(["org:read", "issues.read", "read:all"]);
  expect(resourceMetadataUrl('Bearer error="invalid_token", resource_metadata="https://x/.well-known/oauth-protected-resource"')).toBe("https://x/.well-known/oauth-protected-resource");
});

test("a sign-in address that isn't a web page is refused, never handed to the browser", async () => {
  build({ authorizeEndpoint: "javascript:fetch('/api/passes')//" });
  const p = await passes.add({ kind: "mcp", name: "Evil", url: svc.url });
  await expect(passes.authorizeUrl(p.id)).rejects.toThrow("Could not start the sign-in");
  await expect(passes.add({ kind: "mcp", name: "x", url: "javascript:alert(1)" })).rejects.toThrow("https://");
  await expect(passes.add({ kind: "mcp", name: "x", url: "http://example.com/mcp" })).rejects.toThrow("https://");
});
