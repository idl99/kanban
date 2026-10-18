import { beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus, type BusEvent } from "../src/server/events";
import { addArgs, maskSecrets, McpManager, parseMcpGet, parseMcpList, readMcpConfig, scopeOf, shellQuote } from "../src/server/mcp";
import { tempDir } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude-mcp.ts");

test("parseMcpList: real CLI output", () => {
  const { servers, unparsed } = parseMcpList(readFileSync(join(import.meta.dir, "fixtures", "mcp-list.txt"), "utf8"));
  expect(unparsed).toEqual(["something the parser has never seen"]);
  const by = Object.fromEntries(servers.map((s) => [s.name, s]));
  expect(servers.length).toBe(8);
  expect(by["claude.ai Claude Docs"]).toMatchObject({ target: "https://api.anthropic.com/v1/pages/mcp", transport: "http", status: "connected", message: null });
  expect(by["claude.ai Rippling"]).toMatchObject({ status: "needs_auth", message: "Needs authentication" });
  expect(by["claude.ai Custom MCP (Notion, Google Sheets etc.)"].status).toBe("needs_auth");
  expect(by["zai-mcp-server"]).toMatchObject({ target: "npx -y @z_ai/mcp-server", transport: "stdio", status: "connected" });
  expect(by.posthog).toMatchObject({ transport: "http", target: "https://mcp.posthog.com/mcp?features=llm_analytics&api_key=***" });
  expect(by.events).toMatchObject({ transport: "sse", status: "pending", target: "https://example.com/sse" });
  expect(by["google-sheets"]).toMatchObject({
    status: "failed",
    target: "uvx mcp-google-sheets@latest --token ***",
    message: "Failed to connect — CONNECTION_CLOSED: Connection closed",
  });
});

test("parseMcpList: empty config", () => {
  expect(parseMcpList("No MCP servers configured. Use `claude mcp add` to add a server.\n")).toEqual({ servers: [], unparsed: [] });
});

test("parseMcpGet", () => {
  expect(parseMcpGet("x:\n  Scope: User config\n  Status: ✔ Connected\n  Type: http\n")).toEqual({ status: "connected", message: null });
  expect(parseMcpGet("x:\n  Status: ✘ Failed to connect\n  Issue: CONNECTION_CLOSED: Connection closed\n")).toEqual({
    status: "failed", message: "Failed to connect — CONNECTION_CLOSED: Connection closed",
  });
  expect(parseMcpGet("garbage")).toBeNull();
});

test("maskSecrets", () => {
  expect(maskSecrets("node s.js --api-key abc --port 3")).toBe("node s.js --api-key *** --port 3");
  expect(maskSecrets("run --token=abc")).toBe("run --token=***");
  expect(maskSecrets("env GITHUB_TOKEN=abc DEBUG=1 x")).toBe("env GITHUB_TOKEN=*** DEBUG=1 x");
  expect(maskSecrets("https://h/x?a=1&auth=zz")).toBe("https://h/x?a=1&auth=***");
});

test("scopeOf", () => {
  const cfg = { user: new Set(["u"]), local: new Set(["l"]), project: new Set(["p"]) };
  expect(scopeOf("claude.ai Gmail", cfg)).toBe("claude.ai");
  expect(scopeOf("u", cfg)).toBe("user");
  expect(scopeOf("l", cfg)).toBe("local");
  expect(scopeOf("p", cfg)).toBe("project");
  expect(scopeOf("plugin:x:y", cfg)).toBe("other");
});

test("addArgs builds argv without a shell and validates input", () => {
  expect(addArgs({ name: "fs", transport: "stdio", command: "npx", args: ["-y", "pkg; rm -rf /"], env: [{ key: "API_KEY", value: "a b" }] }))
    .toEqual(["mcp", "add", "--scope", "user", "--transport", "stdio", "fs", "-e", "API_KEY=a b", "--", "npx", "-y", "pkg; rm -rf /"]);
  expect(addArgs({ name: "s", transport: "http", url: "https://x.dev/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] }))
    .toEqual(["mcp", "add", "--scope", "user", "--transport", "http", "s", "https://x.dev/mcp", "-H", "Authorization: Bearer t"]);
  expect(() => addArgs({ name: "--scope", transport: "stdio", command: "x" })).toThrow();
  expect(() => addArgs({ name: "ok", transport: "http", url: "file:///etc/passwd" })).toThrow();
  expect(() => addArgs({ name: "ok", transport: "stdio", command: "" })).toThrow();
  expect(() => addArgs({ name: "ok", transport: "stdio", command: "x", env: [{ key: "A-B", value: "1" }] })).toThrow();
  expect(() => addArgs({ name: "ok", transport: "http", url: "https://x", headers: [{ name: "X", value: "a\nb" }] })).toThrow();
});

let dir: string;
let events: BusEvent[];
let mgr: McpManager;
let argsFile: string;

function setup(servers: Record<string, { target: string; status: string }>, userScope: string[] = []) {
  dir = tempDir("ck-mcp-");
  argsFile = join(dir, "args.log");
  writeFileSync(argsFile, "");
  writeFileSync(join(dir, "state.json"), JSON.stringify(servers));
  writeFileSync(join(dir, "claude.json"), JSON.stringify({ mcpServers: Object.fromEntries(userScope.map((n) => [n, {}])) }));
  process.env.FAKE_MCP_STATE = join(dir, "state.json");
  process.env.FAKE_ARGS_FILE = argsFile;
  delete process.env.FAKE_LOGIN;
  delete process.env.FAKE_ADD;
  delete process.env.FAKE_LIST_MS;
  const bus = new Bus();
  events = [];
  bus.on((e) => events.push(e));
  mgr = new McpManager(bus, {
    claudeBin: FAKE, cwd: dir, configFile: join(dir, "claude.json"), seenFile: join(dir, "seen.json"), loginPollMs: 10, loginPollForMs: 2000,
  });
}

const calls = () => readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

beforeEach(() => setup({}));

test("refresh caches the list, scopes it and emits updates", async () => {
  setup({ docs: { target: "https://d.dev/mcp (HTTP)", status: "✔ Connected" }, "claude.ai Gmail": { target: "https://g", status: "! Needs authentication" } }, ["docs"]);
  const p = mgr.refresh();
  expect(mgr.state().checking).toBe(true);
  await p;
  const s = mgr.state();
  expect(s.checking).toBe(false);
  expect(s.checkedAt).not.toBeNull();
  expect(s.servers.map((x) => [x.name, x.scope, x.status])).toEqual([["docs", "user", "connected"], ["claude.ai Gmail", "claude.ai", "needs_auth"]]);
  // Never-connected claude.ai connector doesn't count toward the badge.
  expect(mgr.attentionCount()).toBe(0);
  expect(events.some((e) => e.type === "mcp.updated")).toBe(true);
});

test("server that worked before and now needs auth counts toward the badge", async () => {
  setup({ docs: { target: "https://d.dev/mcp (HTTP)", status: "✔ Connected" } }, ["docs"]);
  await mgr.refresh();
  await mgr.logout("docs");
  expect(mgr.state().servers[0].status).toBe("needs_auth");
  expect(mgr.attentionCount()).toBe(1);
  expect(calls().some((c) => c.join(" ") === "mcp logout docs")).toBe(true);
});

test("login runs in background, captures the URL and flips to connected", async () => {
  setup({ docs: { target: "https://d.dev/mcp (HTTP)", status: "! Needs authentication" } }, ["docs"]);
  await mgr.refresh();
  mgr.login("docs");
  expect(mgr.state().servers[0].login?.state).toBe("waiting");
  expect(() => mgr.login("docs")).toThrow(/already/);
  await until(() => mgr.state().servers[0].login === null);
  expect(mgr.state().servers[0].status).toBe("connected");
  expect(events.some((e) => e.type === "mcp.updated" && e.state.servers[0]?.login?.url === "https://auth.example.com/authorize?x=1")).toBe(true);
});

test("failed login keeps the error", async () => {
  setup({ docs: { target: "https://d.dev/mcp (HTTP)", status: "! Needs authentication" } }, ["docs"]);
  await mgr.refresh();
  process.env.FAKE_LOGIN = "fail";
  mgr.login("docs");
  await until(() => mgr.state().servers[0].login?.state === "failed");
  expect(mgr.state().servers[0].login?.error).toContain("OAuth discovery failed");
});

test("stdio servers can't log in; non-user servers can't be removed", async () => {
  setup({ fs: { target: "npx fs", status: "✔ Connected" }, "claude.ai X": { target: "https://x", status: "✔ Connected" } }, []);
  await mgr.refresh();
  expect(() => mgr.login("fs")).toThrow(/OAuth/);
  await expect(mgr.remove("claude.ai X")).rejects.toThrow(/user-scope/);
  await expect(mgr.remove("fs")).rejects.toThrow(/user-scope/);
  expect(() => mgr.login("nope")).toThrow(/no MCP server/);
});

test("add and remove", async () => {
  await mgr.refresh();
  await mgr.add({ name: "fs", transport: "stdio", command: "npx", args: ["-y", "fs"] });
  await until(() => mgr.state().servers.some((s) => s.name === "fs") && !mgr.state().checking);
  writeFileSync(join(dir, "claude.json"), JSON.stringify({ mcpServers: { fs: {} } }));
  await mgr.refresh();
  expect(mgr.state().servers.find((s) => s.name === "fs")?.scope).toBe("user");
  await expect(mgr.add({ name: "fs", transport: "stdio", command: "x" })).rejects.toThrow(/already exists/);
  await mgr.remove("fs");
  expect(mgr.state().servers.some((s) => s.name === "fs")).toBe(false);
  expect(calls().some((c) => c.join(" ") === "mcp remove fs --scope user")).toBe(true);
});

test("added and edited servers show at once, before the full list runs", async () => {
  await mgr.refresh();
  process.env.FAKE_LIST_MS = "300";
  await mgr.add({ name: "fs", transport: "stdio", command: "npx", args: ["-y", "fs"], env: [{ key: "API_KEY", value: "s3cret" }] });
  expect(mgr.state().servers.find((s) => s.name === "fs")).toMatchObject({ target: "npx -y fs", scope: "user", status: "connected" });
  await mgr.update("fs", { name: "fs2", transport: "stdio", command: "npx", args: ["-y", "fs2"] });
  expect(mgr.state().servers.map((s) => [s.name, s.target])).toEqual([["fs2", "npx -y fs2"]]);
});

test("a list that started before an add, edit or remove doesn't undo it", async () => {
  setup({ old: { target: "npx old", status: "✔ Connected" } }, ["old"]);
  await mgr.refresh();
  process.env.FAKE_LIST_MS = "400";
  const slow = mgr.refresh(); // reads the state before the changes below
  await Bun.sleep(100);
  delete process.env.FAKE_LIST_MS;
  await mgr.add({ name: "fs", transport: "stdio", command: "npx", args: ["fs"] });
  await mgr.remove("old");
  await slow;
  const names = () => mgr.state().servers.map((s) => s.name);
  expect(names()).toEqual(["fs"]);
  const seen: string[][] = [];
  events.length = 0;
  await until(() => !mgr.state().checking);
  for (const e of events) if (e.type === "mcp.updated") seen.push(e.state.servers.map((s) => s.name));
  expect(seen.every((n) => n.includes("fs") && !n.includes("old"))).toBe(true);
});

test("missing claude binary is reported, not thrown", async () => {
  const bus = new Bus();
  const m = new McpManager(bus, { claudeBin: join(tempDir(), "no-such-claude"), cwd: tempDir() });
  await m.refresh();
  expect(m.state().error).toMatch(/not found/i);
  expect(m.state().checking).toBe(false);
});

test("slow CLI times out", async () => {
  const slow = join(tempDir(), "slow.sh");
  writeFileSync(slow, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  const m = new McpManager(new Bus(), { claudeBin: slow, cwd: tempDir(), listTimeoutMs: 100 });
  await m.refresh();
  expect(m.state().error).toMatch(/timed out/);
});

test("shellQuote only quotes when needed", () => {
  expect(shellQuote("uvx")).toBe("uvx");
  expect(shellQuote("mcp-google-sheets@latest")).toBe("mcp-google-sheets@latest");
  expect(shellQuote("a b")).toBe("'a b'");
  expect(shellQuote("it's")).toBe("'it'\\''s'");
  expect(shellQuote("$(rm -rf ~)")).toBe("'$(rm -rf ~)'");
});

test("readMcpConfig: unmasked settings and a runnable command line, local before user", () => {
  const d = tempDir("ck-mcpcfg-");
  const cfg = join(d, "claude.json");
  writeFileSync(cfg, JSON.stringify({
    mcpServers: {
      sheets: { type: "stdio", command: "uvx", args: ["mcp-google-sheets@latest", "--token", "s3cr3t"], env: { API_KEY: "a b" } },
      docs: { type: "http", url: "https://d.dev/mcp", headers: { Authorization: "Bearer t" } },
      both: { command: "user-one" },
    },
    projects: { [d]: { mcpServers: { both: { command: "local-one" } } } },
  }));
  expect(readMcpConfig("sheets", d, cfg)).toEqual({
    name: "sheets", scope: "user", transport: "stdio", command: "uvx", args: ["mcp-google-sheets@latest", "--token", "s3cr3t"],
    env: [{ key: "API_KEY", value: "a b" }], commandLine: "API_KEY='a b' uvx mcp-google-sheets@latest --token s3cr3t",
  });
  expect(readMcpConfig("docs", d, cfg)).toMatchObject({ transport: "http", url: "https://d.dev/mcp", headers: [{ name: "Authorization", value: "Bearer t" }], commandLine: null });
  expect(readMcpConfig("both", d, cfg)).toMatchObject({ scope: "local", command: "local-one" });
  expect(readMcpConfig("nope", d, cfg)).toBeNull();
});

test("recheck updates one server without a full list", async () => {
  setup({ sheets: { target: "uvx sheets", status: "✘ Failed to connect" } }, ["sheets"]);
  await mgr.refresh();
  expect(mgr.state().servers[0].status).toBe("failed");
  writeFileSync(join(dir, "state.json"), JSON.stringify({ sheets: { target: "uvx sheets", status: "✔ Connected" } }));
  const before = calls().length;
  const s = await mgr.recheck("sheets");
  expect(s?.status).toBe("connected");
  expect(mgr.state().servers[0].attention).toBe(false);
  expect(calls().slice(before)).toEqual([["mcp", "get", "sheets"]]);
});

test("update replaces a user-scope server (remove + add) and restores it if add fails", async () => {
  setup({ fs: { target: "npx fs", status: "✔ Connected" } }, ["fs"]);
  writeFileSync(join(dir, "claude.json"), JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["fs"] } } }));
  await mgr.refresh();
  expect(mgr.config("fs")).toMatchObject({ command: "npx", args: ["fs"], commandLine: "npx fs" });
  await mgr.update("fs", { name: "fs", transport: "stdio", command: "npx", args: ["-y", "fs2"] });
  const after = calls().map((c) => c.join(" "));
  expect(after).toContain("mcp remove fs --scope user");
  expect(after).toContain("mcp add --scope user --transport stdio fs -- npx -y fs2");

  process.env.FAKE_ADD = "fail";
  const n = calls().length;
  await expect(mgr.update("fs", { name: "fs", transport: "stdio", command: "bad" })).rejects.toThrow(/add failed/);
  // Background `mcp list` refreshes can interleave; only the edits matter here.
  const tried = calls().slice(n).map((c) => c.join(" ")).filter((c) => c !== "mcp list");
  expect(tried[0]).toBe("mcp remove fs --scope user");
  expect(tried.filter((c) => c.startsWith("mcp add")).length).toBe(2); // the new one, then the restore
});

test("update and config refuse servers that aren't editable here", async () => {
  setup({ "claude.ai X": { target: "https://x", status: "✔ Connected" } }, []);
  await mgr.refresh();
  await expect(mgr.update("claude.ai X", { name: "claude.ai X", transport: "http", url: "https://x" })).rejects.toThrow(/user-scope/);
  expect(() => mgr.config("claude.ai X")).toThrow(/config files/);
});
