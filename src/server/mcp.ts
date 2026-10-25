import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Bus } from "./events";

export type McpStatus = "connected" | "needs_auth" | "failed" | "pending" | "unknown";
export type McpScope = "user" | "local" | "project" | "claude.ai" | "other";
export type McpTransport = "stdio" | "http" | "sse";

export interface McpServer {
  name: string;
  /** Command line or URL, with secret-looking values masked. */
  target: string;
  transport: McpTransport | null;
  scope: McpScope;
  status: McpStatus;
  /** Status text from the CLI, plus the error detail when there is one. */
  message: string | null;
  /** Counts toward the header badge: failed, or needs auth after having worked before. */
  attention: boolean;
  login: McpLogin | null;
}

export interface McpLogin {
  state: "waiting" | "failed";
  /** Sign-in page printed by the CLI. The board opens it in the user's browser (the CLI runs with --no-browser). */
  url: string | null;
  error: string | null;
  startedAt: string;
  /** A claude.ai connector: sign-in happens on claude.ai, and the CLI exits once it printed the link. */
  claudeAi: boolean;
  /** The CLI waits in a terminal that takes the address the sign-in page ended on (sign-in on another device). */
  canPaste: boolean;
}

export interface McpState {
  servers: McpServer[];
  /** Lines of `claude mcp list` we couldn't parse (format changed?). Shown raw. */
  unparsed: string[];
  checkedAt: string | null;
  checking: boolean;
  error: string | null;
}

export interface McpAddInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: { key: string; value: string }[];
  headers?: { name: string; value: string }[];
}

export class McpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Parsed = Omit<McpServer, "scope" | "attention" | "login">;

const SECRET = /key|token|secret|pass|auth|sig|cred|bearer/i;

/** Hides values of secret-looking query params, --flags and KEY=VALUE pairs. */
export function maskSecrets(s: string): string {
  return s
    .replace(/([?&])([^=&\s]+)=([^&\s]*)/g, (m, sep, k) => (SECRET.test(k) ? `${sep}${k}=***` : m))
    .replace(/(^|\s)(--?[\w-]+)(=|\s+)(?!-)(\S+)/g, (m, pre, flag, eq) => (SECRET.test(flag) ? `${pre}${flag}${eq}***` : m))
    .replace(/(^|\s)([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g, (m, pre, k) => (SECRET.test(k) ? `${pre}${k}=***` : m));
}

function statusOf(text: string): McpStatus {
  const t = text.toLowerCase();
  if (t.includes("needs auth")) return "needs_auth";
  if (t.includes("fail") || t.includes("error")) return "failed";
  if (t.includes("pending")) return "pending";
  if (t.includes("connected")) return "connected";
  return "unknown";
}

/** "✔ Connected" / "✘ Failed to connect — CONNECTION_CLOSED: …" → status + readable text. */
function splitStatus(raw: string): { status: McpStatus; message: string | null } {
  const text = raw.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const status = statusOf(text);
  return { status, message: status === "connected" ? null : text || null };
}

/**
 * Parses `claude mcp list`. Lines look like `<name>: <command or URL>[ (HTTP|SSE)] - <symbol> <status>`.
 * Names never contain ": ", URLs and args do, so we split on the first ": " and on the first " - <symbol> ".
 */
export function parseMcpList(text: string): { servers: Parsed[]; unparsed: string[] } {
  const servers: Parsed[] = [];
  const unparsed: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^checking mcp server health/i.test(line) || /^no mcp servers configured/i.test(line)) continue;
    const colon = line.indexOf(": ");
    const dash = line.slice(colon + 2).search(/\s-\s(?=[^\p{L}\p{N}\s])/u);
    if (colon <= 0 || dash < 0) {
      unparsed.push(line);
      continue;
    }
    const name = line.slice(0, colon);
    let target = line.slice(colon + 2, colon + 2 + dash).trim();
    const statusText = line.slice(colon + 2 + dash).replace(/^\s-\s/, "");
    let transport: McpTransport | null = null;
    const suffix = target.match(/\s\((HTTP|SSE|STDIO)\)$/i);
    if (suffix) {
      transport = suffix[1].toLowerCase() as McpTransport;
      target = target.slice(0, -suffix[0].length);
    } else transport = /^https?:\/\//.test(target) ? "http" : "stdio";
    servers.push({ name, target: maskSecrets(target), transport, ...splitStatus(statusText) });
  }
  return { servers, unparsed };
}

/** Parses the `Status:` and `Issue:` lines of `claude mcp get <name>`. */
export function parseMcpGet(text: string): { status: McpStatus; message: string | null } | null {
  const status = text.match(/^\s*Status:\s*(.+)$/m);
  if (!status) return null;
  const s = splitStatus(status[1]);
  const issue = text.match(/^\s*Issue:\s*(.+)$/m);
  if (issue && s.status !== "connected") s.message = `${s.message ?? ""} — ${issue[1].trim()}`.replace(/^ — /, "");
  return s;
}

const SESSION_STATUS: Record<string, McpStatus> = {
  connected: "connected", "needs-auth": "needs_auth", failed: "failed", pending: "pending",
};

/**
 * Server statuses from a Claude session's stream-json `init` event (`{"type":"system","subtype":"init","mcp_servers":[…]}`).
 * Null for any other line. Statuses we don't map (e.g. "disabled") are left out.
 */
export function parseSessionInit(line: string): Map<string, McpStatus> | null {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (d?.type !== "system" || d.subtype !== "init" || !Array.isArray(d.mcp_servers)) return null;
  const out = new Map<string, McpStatus>();
  for (const s of d.mcp_servers) {
    const status = SESSION_STATUS[String(s?.status)];
    if (typeof s?.name === "string" && status) out.set(s.name, status);
  }
  return out;
}

/**
 * Puts what a Claude session sees over what `claude mcp list` says. The list can call a claude.ai connector
 * connected while sessions still get "needs authentication" for it, so the session wins.
 */
export function applySessionStatus<T extends Pick<McpServer, "name" | "status" | "message">>(s: T, session: Map<string, McpStatus> | null): T {
  const status = session?.get(s.name);
  if (!status || status === s.status) return s;
  const message = status === "connected" ? null
    : status === "needs_auth" ? "Needs authentication"
    : status === "failed" ? s.message ?? "Failed to connect in Claude sessions"
    : s.message;
  return { ...s, status, message };
}

/** Scope from Claude's config files, as seen from `cwd` (the list itself doesn't say). */
export function scopeOf(name: string, cfg: { user: Set<string>; local: Set<string>; project: Set<string> }): McpScope {
  if (name.startsWith("claude.ai ")) return "claude.ai";
  if (cfg.local.has(name)) return "local";
  if (cfg.project.has(name)) return "project";
  if (cfg.user.has(name)) return "user";
  return "other";
}

/** Quotes one word for a POSIX shell (only when needed). */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Saved settings of a server, unmasked, for the edit form and for running it in a terminal. */
export interface McpConfig extends McpAddInput {
  scope: McpScope;
  /** Shell line that starts a stdio server the way Claude does (env included). Null for http/sse. */
  commandLine: string | null;
}

/** Reads a server's entry from Claude's config files. Null when it isn't in them (claude.ai, plugins). */
export function readMcpConfig(name: string, cwd: string, configFile: string): McpConfig | null {
  const cfg = readJson(configFile) ?? {};
  const sources: [McpScope, any][] = [
    ["local", cfg.projects?.[cwd]?.mcpServers],
    ["project", readJson(join(cwd, ".mcp.json"))?.mcpServers],
    ["user", cfg.mcpServers],
  ];
  for (const [scope, servers] of sources) {
    const e = servers && typeof servers === "object" ? servers[name] : null;
    if (!e || typeof e !== "object") continue;
    const kind = String(e.type ?? (e.url ? "http" : "stdio"));
    if (kind === "http" || kind === "sse") {
      const headers = Object.entries(e.headers ?? {}).map(([k, v]) => ({ name: k, value: String(v) }));
      return { name, scope, transport: kind, url: String(e.url ?? ""), headers, commandLine: null };
    }
    const command = String(e.command ?? "");
    const args = Array.isArray(e.args) ? e.args.map(String) : [];
    const env = Object.entries(e.env ?? {}).map(([k, v]) => ({ key: k, value: String(v) }));
    const commandLine = [...env.map((x) => `${x.key}=${shellQuote(x.value)}`), shellQuote(command), ...args.map(shellQuote)].join(" ");
    return { name, scope, transport: "stdio", command, args, env, commandLine };
  }
  return null;
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function configScopes(cwd: string, configFile: string) {
  const cfg = readJson(configFile) ?? {};
  const keys = (o: unknown) => new Set(o && typeof o === "object" ? Object.keys(o) : []);
  return {
    user: keys(cfg.mcpServers),
    local: keys(cfg.projects?.[cwd]?.mcpServers),
    project: keys(readJson(join(cwd, ".mcp.json"))?.mcpServers),
  };
}

export function canLogin(s: Pick<McpServer, "transport" | "scope">): boolean {
  return s.scope === "claude.ai" || s.transport === "http" || s.transport === "sse";
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** argv for `claude mcp add` (user scope). Throws McpError on bad input. Never goes through a shell. */
export function addArgs(input: McpAddInput): string[] {
  const name = String(input.name ?? "").trim();
  if (!NAME.test(name)) throw new McpError(400, "name: letters, digits, dot, dash and underscore only");
  const noNewline = (v: string, what: string) => {
    if (/[\r\n\0]/.test(v)) throw new McpError(400, `${what} must be on one line`);
    return v;
  };
  if (input.transport === "stdio") {
    const command = String(input.command ?? "").trim();
    if (!command) throw new McpError(400, "command is required");
    const env = (input.env ?? []).filter((e) => e.key || e.value).flatMap((e) => {
      if (!ENV_KEY.test(e.key)) throw new McpError(400, `invalid environment variable name: ${e.key}`);
      return ["-e", `${e.key}=${noNewline(String(e.value), e.key)}`];
    });
    const args = (input.args ?? []).map((a) => noNewline(String(a), "arguments"));
    return ["mcp", "add", "--scope", "user", "--transport", "stdio", name, ...env, "--", noNewline(command, "command"), ...args];
  }
  if (input.transport === "http" || input.transport === "sse") {
    const url = noNewline(String(input.url ?? "").trim(), "URL");
    if (!/^https?:\/\/\S+$/.test(url)) throw new McpError(400, "URL must start with http:// or https://");
    const headers = (input.headers ?? []).filter((h) => h.name || h.value).flatMap((h) => {
      if (!HEADER.test(h.name)) throw new McpError(400, `invalid header name: ${h.name}`);
      return ["-H", `${h.name}: ${noNewline(String(h.value), h.name)}`];
    });
    return ["mcp", "add", "--scope", "user", "--transport", input.transport, name, url, ...headers];
  }
  throw new McpError(400, "transport must be stdio, http or sse");
}

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

export interface McpOptions {
  claudeBin?: string;
  /** Where commands run; project/local servers are read for this folder. Default: home dir. */
  cwd?: string;
  /** Claude's global config (for scopes). Default: $CLAUDE_CONFIG_DIR/.claude.json or ~/.claude.json. */
  configFile?: string;
  /** Remembers which servers once worked, so "needs auth" there means expired (badge). */
  seenFile?: string;
  listTimeoutMs?: number;
  /** How long to wait for a probe session's statuses (see `sessionStatuses`). */
  probeTimeoutMs?: number;
  loginTimeoutMs?: number;
  /** How often and how long to re-check a server after `login` exits, waiting for the browser flow. */
  loginPollMs?: number;
  loginPollForMs?: number;
}

/** Cached view of `claude mcp list` plus the actions behind the Connections panel. */
export class McpManager {
  private servers: McpServer[] = [];
  private unparsed: string[] = [];
  private checkedAt: string | null = null;
  private error: string | null = null;
  private inflight: Promise<void> | null = null;
  /** Servers added, edited or removed while the current `claude mcp list` ran: its older output doesn't overwrite them. */
  private touched = new Set<string>();
  private again = false;
  private logins = new Map<string, McpLogin>();
  /** Running `claude mcp login` per server, to cancel it or type a pasted address into it. */
  private loginProcs = new Map<string, { kill: () => void; write: (s: string) => void }>();
  private seen: Set<string>;
  private bin: string;
  private cwd: string;
  private configFile: string;
  private opts: Required<Pick<McpOptions, "listTimeoutMs" | "probeTimeoutMs" | "loginTimeoutMs" | "loginPollMs" | "loginPollForMs">>;

  constructor(private bus: Bus, private options: McpOptions = {}) {
    this.bin = options.claudeBin ?? "claude";
    this.cwd = options.cwd ?? homedir();
    this.configFile = options.configFile
      ?? join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
    this.opts = {
      listTimeoutMs: options.listTimeoutMs ?? 120_000,
      probeTimeoutMs: options.probeTimeoutMs ?? 60_000,
      loginTimeoutMs: options.loginTimeoutMs ?? 10 * 60_000,
      loginPollMs: options.loginPollMs ?? 5_000,
      loginPollForMs: options.loginPollForMs ?? 5 * 60_000,
    };
    this.seen = new Set(options.seenFile && existsSync(options.seenFile) ? readJson(options.seenFile) ?? [] : []);
  }

  state(): McpState {
    return {
      servers: this.servers.map((s) => ({ ...s, login: this.logins.get(s.name) ?? null })),
      unparsed: this.unparsed,
      checkedAt: this.checkedAt,
      checking: this.inflight !== null,
      error: this.error,
    };
  }

  attentionCount(): number {
    return this.servers.filter((s) => s.attention).length;
  }

  /** Refresh now and every `intervalMs`. Returns a stop function. */
  start(intervalMs = 10 * 60_000): () => void {
    this.refresh();
    const t = setInterval(() => this.refresh(), intervalMs);
    return () => clearInterval(t);
  }

  /** Re-runs `claude mcp list`. Concurrent calls share one run (a call during a run queues one more). */
  refresh(): Promise<void> {
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
      if (this.again) {
        this.again = false;
        this.refresh();
      }
      this.emit();
    });
    this.emit();
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    const touched = (this.touched = new Set());
    const [r, session] = await Promise.all([this.run(["mcp", "list"], this.opts.listTimeoutMs), this.sessionStatuses()]);
    if (r.code !== 0) {
      this.error = errorText(r, "claude mcp list");
      return;
    }
    const { servers, unparsed } = parseMcpList(r.stdout);
    const scopes = configScopes(this.cwd, this.configFile);
    let next = servers.map((s) => this.decorate(applySessionStatus({ ...s, scope: scopeOf(s.name, scopes), attention: false, login: null }, session)));
    for (const name of touched) {
      const now = this.servers.find((x) => x.name === name);
      next = next.filter((x) => x.name !== name);
      if (now) next.push(now);
    }
    this.servers = next;
    this.unparsed = unparsed;
    this.checkedAt = new Date().toISOString();
    this.error = null;
    this.saveSeen();
  }

  private decorate(s: McpServer): McpServer {
    if (s.status === "connected") this.seen.add(s.name);
    const attention = s.status === "failed" || (s.status === "needs_auth" && this.seen.has(s.name));
    return { ...s, attention };
  }

  private saveSeen() {
    if (!this.options.seenFile) return;
    try {
      writeFileSync(this.options.seenFile, JSON.stringify([...this.seen].sort()));
    } catch {}
  }

  private find(name: string): McpServer {
    const s = this.servers.find((x) => x.name === name);
    if (!s) throw new McpError(404, `no MCP server named "${name}"`);
    return s;
  }

  /** Re-checks one server with `claude mcp get` (a few seconds, vs. the whole list). */
  async recheck(name: string): Promise<McpServer | null> {
    if (this.servers.find((x) => x.name === name)?.scope === "claude.ai") return this.recheckConnector(name);
    const r = await this.run(["mcp", "get", name], 60_000);
    const parsed = r.code === 0 ? parseMcpGet(r.stdout) : null;
    const i = this.servers.findIndex((x) => x.name === name);
    if (!parsed || i < 0) return null;
    this.servers[i] = this.decorate({ ...this.servers[i], ...parsed });
    this.saveSeen();
    this.emit();
    return this.servers[i];
  }

  /** `claude mcp get` has the same blind spot as the list for claude.ai connectors: ask a probe session instead. */
  private async recheckConnector(name: string): Promise<McpServer | null> {
    const session = await this.sessionStatuses();
    const i = this.servers.findIndex((x) => x.name === name);
    if (!session?.has(name) || i < 0) return null;
    this.servers[i] = this.decorate(applySessionStatus(this.servers[i], session));
    this.saveSeen();
    this.emit();
    return this.servers[i];
  }

  /**
   * Server statuses as a real Claude session sees them. Starts `claude -p` and stops it at its `init` event,
   * before any model call: the API address points at a closed local port, hooks are off and the session isn't saved,
   * so it costs nothing and leaves no trace. Null if the session didn't report in time.
   */
  private async sessionStatuses(): Promise<Map<string, McpStatus> | null> {
    let p: ReturnType<typeof Bun.spawn>;
    try {
      p = Bun.spawn([this.bin, "-p", "ok", "--output-format", "stream-json", "--verbose", "--tools", "", "--max-turns", "1",
        "--no-session-persistence", "--settings", JSON.stringify({ disableAllHooks: true })], {
        cwd: this.cwd, env: { ...process.env, ANTHROPIC_BASE_URL: "http://127.0.0.1:9" },
        stdin: "ignore", stdout: "pipe", stderr: "ignore",
      });
    } catch {
      return null;
    }
    const read = async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
          const init = parseSessionInit(buf.slice(0, i));
          if (init) return init;
        }
      }
      return null;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Don't wait for the stream to end after a timeout: children of the killed CLI can hold the pipe open.
    const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), this.opts.probeTimeoutMs)));
    try {
      return await Promise.race([read().catch(() => null), timeout]);
    } finally {
      clearTimeout(timer);
      p.kill();
    }
  }

  /** Saved settings of one server (unmasked). Throws 404 if it isn't in Claude's config files. */
  config(name: string): McpConfig {
    this.find(name);
    const c = readMcpConfig(name, this.cwd, this.configFile);
    if (!c) throw new McpError(404, `${name} isn't in Claude's config files, so it can't be edited here`);
    return c;
  }

  /** Replaces a user-scope server: remove, then add with the new settings (restores the old one if that fails). */
  async update(name: string, input: McpAddInput): Promise<void> {
    const s = this.find(name);
    if (s.scope !== "user") throw new McpError(400, `${name} isn't a user-scope server; edit it where it's configured`);
    const args = addArgs(input);
    const next = String(input.name).trim();
    if (next !== name && this.servers.some((x) => x.name === next)) throw new McpError(409, `a server named "${next}" already exists`);
    const old = readMcpConfig(name, this.cwd, this.configFile);
    const rm = await this.run(["mcp", "remove", name, "--scope", "user"], 60_000);
    if (rm.code !== 0) throw new McpError(502, errorText(rm, "claude mcp remove"));
    const r = await this.run(args, 60_000);
    if (r.code !== 0) {
      if (old) await this.run(addArgs(old), 60_000).catch(() => null);
      this.refresh();
      throw new McpError(502, errorText(r, "claude mcp add"));
    }
    this.logins.delete(name);
    if (next !== name) {
      this.servers = this.servers.filter((x) => x.name !== name);
      this.touched.add(name);
    }
    await this.show(input);
    this.refresh();
  }

  /**
   * Puts a server just added or edited in the list with a quick `claude mcp get`,
   * so the panel shows it now instead of after the full `claude mcp list` (which can take a while).
   */
  private async show(input: McpAddInput): Promise<void> {
    const name = String(input.name).trim();
    const r = await this.run(["mcp", "get", name], 30_000);
    const parsed = r.code === 0 ? parseMcpGet(r.stdout) : null;
    const target = input.transport === "stdio"
      ? [String(input.command ?? "").trim(), ...(input.args ?? [])].join(" ")
      : String(input.url ?? "").trim();
    const server = this.decorate({
      name, target: maskSecrets(target), transport: input.transport, scope: "user",
      status: parsed?.status ?? "unknown", message: parsed?.message ?? null, attention: false, login: null,
    });
    const i = this.servers.findIndex((x) => x.name === name);
    if (i >= 0) this.servers[i] = server;
    else this.servers.push(server);
    this.touched.add(name);
    this.saveSeen();
    this.emit();
  }

  /**
   * Starts signing in to a server and returns right away. The CLI runs with --no-browser: the board opens the
   * link it prints in the user's own browser, which also works when the daemon can't open one (launchd, phone).
   * - claude.ai connectors: the CLI prints a claude.ai link and exits. The link stays until the connector turns
   *   connected (if it wasn't), the user is done, or the login times out: a connector that already shows as
   *   connected must not drop it at once.
   * - OAuth servers: the CLI deletes the old login, then waits for the browser's callback. It refuses to wait without
   *   a terminal, so it runs on a pseudo-terminal, which also takes a pasted redirect address (`paste`).
   *   After it exits, polls the server until it's connected or we give up.
   */
  login(name: string): void {
    const s = this.find(name);
    if (!canLogin(s)) throw new McpError(400, `${name} doesn't use OAuth, so there's nothing to log in to`);
    if (this.logins.get(name)?.state === "waiting") throw new McpError(409, `already logging in to ${name}`);
    const claudeAi = s.scope === "claude.ai";
    const login: McpLogin = { state: "waiting", url: null, error: null, startedAt: new Date().toISOString(), claudeAi, canPaste: false };
    this.logins.set(name, login);
    this.emit();
    const current = () => this.logins.get(name) === login;
    const fail = async (error: string) => {
      if (!current()) return;
      this.logins.set(name, { ...login, state: "failed", error, canPaste: false });
      this.emit();
      // An OAuth login deletes the old one before it starts: show what's left, not the stale "Connected".
      if (!claudeAi) await this.recheck(name).catch(() => null);
    };
    const onOutput = (out: string) => {
      const url = findUrl(out);
      if (url && url !== login.url) {
        login.url = url;
        this.emit();
      }
    };
    (async () => {
      if (claudeAi) {
        const wasConnected = s.status === "connected";
        const r = await this.run(["mcp", "login", name, "--no-browser"], 60_000, onOutput);
        if (!current()) return;
        if (r.code !== 0) return fail(errorText(r, "claude mcp login"));
        if (!login.url) return fail("claude mcp login didn't print a sign-in link");
        const until = Date.now() + this.opts.loginTimeoutMs;
        while (current() && Date.now() < until) {
          if (!wasConnected) {
            const now = await this.recheck(name);
            if (!now || now.status === "connected") break;
          }
          await Bun.sleep(this.opts.loginPollMs);
        }
      } else {
        const r = await this.runLogin(name, login, onOutput);
        if (!current()) return;
        if (r.code !== 0) return fail(r.timedOut ? "Sign-in timed out" : errorText(r, "claude mcp login"));
        login.canPaste = false;
        this.emit();
        const until = Date.now() + this.opts.loginPollForMs;
        while (current()) {
          const now = await this.recheck(name);
          if (!now || now.status === "connected" || Date.now() > until) break;
          await Bun.sleep(this.opts.loginPollMs);
        }
      }
      if (current()) this.logins.delete(name);
      this.emit();
    })().catch((e) => fail((e as Error).message));
  }

  /** `claude mcp login <name> --no-browser` on a pseudo-terminal (falls back to pipes where there is none). */
  private async runLogin(name: string, login: McpLogin, onOutput: (soFar: string) => void): Promise<RunOut & { timedOut?: boolean }> {
    const args = [this.bin, "mcp", "login", name, "--no-browser"];
    let out = "";
    const dec = new TextDecoder();
    let p: ReturnType<typeof Bun.spawn>;
    try {
      p = Bun.spawn(args, {
        cwd: this.cwd, env: { ...process.env, TERM: "xterm-256color" },
        terminal: { cols: 2000, rows: 50, name: "xterm-256color", data: (_t, d) => { out = (out + dec.decode(d, { stream: true })).slice(-64 * 1024); onOutput(out); } },
      });
    } catch {
      return this.run(args.slice(1), this.opts.loginTimeoutMs, onOutput);
    }
    let exited = false;
    // The terminal echoes what's typed: pasted addresses (they carry the sign-in code) are cut from error text.
    const pasted: string[] = [];
    const handle = { kill: () => p.kill(), write: (s: string) => { if (exited) return; pasted.push(s.trim()); p.terminal?.write(s); } };
    this.loginProcs.set(name, handle);
    login.canPaste = true;
    this.emit();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill(); }, this.opts.loginTimeoutMs);
    const code = await p.exited;
    exited = true;
    clearTimeout(timer);
    // The last output can arrive just after the exit.
    await Bun.sleep(50);
    if (this.loginProcs.get(name) === handle) this.loginProcs.delete(name);
    p.terminal?.close();
    let text = stripAnsi(out).replace(/\r/g, "");
    for (const s of pasted) text = text.split(s).join("[pasted address]");
    return { code, stdout: text, stderr: "", timedOut };
  }

  /** Types the address the sign-in page ended on into a waiting OAuth login (signed in on another device). */
  paste(name: string, text: string): void {
    const t = String(text ?? "").trim();
    // Printable ASCII only: no control bytes (Ctrl-C, Ctrl-D, escapes) reach the CLI's terminal.
    if (t.length > 4096 || !/^https?:\/\/[\x21-\x7e]+$/.test(t)) throw new McpError(400, "paste the full address from the browser, starting with http");
    const proc = this.loginProcs.get(name);
    if (!proc || this.logins.get(name)?.state !== "waiting") throw new McpError(409, `not signing in to ${name} right now`);
    proc.write(t + "\r");
  }

  /** Stops a login (the browser tab was closed, etc.), then re-checks: the old login may be gone already. */
  cancelLogin(name: string): void {
    const was = this.logins.get(name);
    this.logins.delete(name);
    this.loginProcs.get(name)?.kill();
    this.loginProcs.delete(name);
    this.emit();
    if (was && !was.claudeAi) this.recheck(name).catch(() => null);
  }

  async logout(name: string): Promise<void> {
    const s = this.find(name);
    if (!canLogin(s)) throw new McpError(400, `${name} doesn't use OAuth`);
    const r = await this.run(["mcp", "logout", name], 60_000);
    if (r.code !== 0) throw new McpError(502, errorText(r, "claude mcp logout"));
    this.logins.delete(name);
    await this.recheck(name);
  }

  async add(input: McpAddInput): Promise<void> {
    const args = addArgs(input);
    const name = String(input.name).trim();
    if (this.servers.some((s) => s.name === name)) throw new McpError(409, `a server named "${name}" already exists`);
    const r = await this.run(args, 60_000);
    if (r.code !== 0) throw new McpError(502, errorText(r, "claude mcp add"));
    await this.show(input);
    this.refresh();
  }

  async remove(name: string): Promise<void> {
    const s = this.find(name);
    if (s.scope !== "user") throw new McpError(400, `${name} isn't a user-scope server; remove it where it's configured`);
    const r = await this.run(["mcp", "remove", name, "--scope", "user"], 60_000);
    if (r.code !== 0) throw new McpError(502, errorText(r, "claude mcp remove"));
    this.servers = this.servers.filter((x) => x.name !== name);
    this.touched.add(name);
    this.logins.delete(name);
    this.emit();
    this.refresh();
  }

  private emit() {
    this.bus.emit({ type: "mcp.updated", state: this.state() });
  }

  private async run(args: string[], timeoutMs: number, onStdout?: (soFar: string) => void): Promise<RunOut> {
    let p: ReturnType<typeof Bun.spawn>;
    try {
      p = Bun.spawn([this.bin, ...args], { cwd: this.cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      const missing = /ENOENT|not found|No such file/i.test((e as Error).message);
      return { code: -1, stdout: "", stderr: missing ? `Claude CLI not found (${this.bin}). Is Claude Code installed and on PATH?` : (e as Error).message };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, timeoutMs);
    const out = { stdout: "", stderr: "" };
    const read = async (stream: ReadableStream<Uint8Array>, key: "stdout" | "stderr", cb?: (s: string) => void) => {
      const dec = new TextDecoder();
      for await (const chunk of stream) {
        out[key] += dec.decode(chunk, { stream: true });
        cb?.(out[key]);
      }
    };
    const reads = Promise.all([
      read(p.stdout as ReadableStream<Uint8Array>, "stdout", onStdout),
      read(p.stderr as ReadableStream<Uint8Array>, "stderr"),
    ]);
    const code = await p.exited;
    clearTimeout(timer);
    // Children of a killed CLI (e.g. MCP servers) can hold the pipes open: don't wait for them after a timeout.
    if (timedOut) return { code: -1, stdout: out.stdout, stderr: `timed out after ${Math.round(timeoutMs / 1000)}s` };
    await reads;
    return { code, ...out };
  }
}

/** Drops terminal escapes (colours, OSC 8 links) from CLI output. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** First web address in CLI output (the sign-in page). */
export function findUrl(out: string): string | null {
  return stripAnsi(out).match(/https?:\/\/[^\s\x07\x1b]+/)?.[0] ?? null;
}

function errorText(r: RunOut, what: string): string {
  const text = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-5).join("\n");
  return `${what} failed: ${maskSecrets(text) || `exit code ${r.code}`}`;
}
