import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Bus } from "../events";
import { maskSecrets, readMcpConfig } from "../mcp";
import { inheritedEnv } from "../runner";
import { newId } from "../util";
import { McpClient } from "./mcp-client";
import { authorizeUrl, discover, exchange, NoRegistrationError, refresh, register, webAddress, type Client } from "./oauth";
import { StdioMcpClient } from "./stdio-client";
import { AuthError, type Deps, type Tokens, type ToolClient } from "./types";

/**
 * How the board reaches a service by itself, without Claude ("the board's pass"; Claude's own are in Connections and
 * can't be borrowed):
 * - mcp: an online MCP server the board signed in to (one click, its own sign-in);
 * - key: a key the user pasted. With `url` it is the bearer token for that MCP server; without, the scripts that use
 *   it get it as one environment variable;
 * - local: a program on this computer, started from Claude's own user or local settings for it at each use.
 */
export type PassKind = "mcp" | "key" | "local";
export type PassStatus = "pending" | "connected" | "needs_reconnect";

/** One board pass, shared by every board. Holds secrets: never sent to the UI as is (see view). */
export interface Pass {
  id: string;
  kind: PassKind;
  /** Display name ("Linear"); scripts can also call it by this name. */
  name: string;
  /** The Connections (Claude) server it was made from: that row shows both passes. Null: a row of its own. */
  claudeName: string | null;
  url?: string;
  envName?: string;
  secret?: string;
  oauth?: Client;
  tokens?: Tokens;
  status: PassStatus;
  error: string | null;
  createdAt: string;
}

/** What the UI and runs may see of a pass: no secrets. */
export interface PassView {
  id: string;
  kind: PassKind;
  name: string;
  claudeName: string | null;
  url: string | null;
  envName: string | null;
  status: PassStatus;
  error: string | null;
  createdAt: string;
}

export class PassError extends Error {
  constructor(public status: number, message: string, public code?: "no_registration") {
    super(message);
  }
}

export interface AddPassInput {
  kind?: unknown;
  name?: unknown;
  claudeName?: unknown;
  url?: unknown;
  envName?: unknown;
  secret?: unknown;
}

interface File {
  version: 1;
  passes: Pass[];
}

/** An access token is renewed when it has less than this long left. */
const RENEW_MS = 60_000;
/** The user has this long to finish signing in at the service. */
const SIGN_IN_MS = 10 * 60_000;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Names the board sets for scripts itself. */
const RESERVED_ENV = new Set(["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR", "CKANBAN_PORT", "CKANBAN_CALL_TOKEN"]);

export interface PassOptions {
  /** Claude's global config, for programs on this computer. Default: $CLAUDE_CONFIG_DIR/.claude.json or ~/.claude.json. */
  configFile?: string;
  /** Folder Claude's local-scope servers belong to (Connections reads them from the home folder too). */
  home?: string;
  /** Time limit for one call to a program on this computer. */
  stdioTimeoutMs?: number;
}

/**
 * The passes file (`automation-passes.json` in the data folder, readable by the owner only), the generic sign-in and
 * token renewal, and calling a pass's tools. Every call goes through here, so a token is renewed in one place only.
 */
export class Passes {
  private file: string;
  private signIns = new Map<string, { passId: string; expires: number; verifier: string }>();
  private renewing = new Map<string, Promise<string>>();
  private configFile: string;
  private home: string;

  constructor(root: string, private bus: Bus, private deps: Deps, private callbackUrl: () => string, private o: PassOptions = {}) {
    this.file = join(root, "automation-passes.json");
    this.configFile = o.configFile ?? join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
    this.home = o.home ?? homedir();
  }

  private read(): File {
    if (!existsSync(this.file)) return { version: 1, passes: [] };
    try {
      const f = JSON.parse(readFileSync(this.file, "utf8"));
      return { version: 1, passes: Array.isArray(f.passes) ? f.passes : [] };
    } catch {
      return { version: 1, passes: [] };
    }
  }

  private write(f: File) {
    const tmp = `${this.file}.tmp-${newId()}`;
    writeFileSync(tmp, JSON.stringify(f, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  private save(p: Pass) {
    const f = this.read();
    const i = f.passes.findIndex((x) => x.id === p.id);
    if (i < 0) f.passes.push(p);
    else f.passes[i] = p;
    this.write(f);
    this.bus.emit({ type: "integration.updated" });
  }

  list(): Pass[] {
    return this.read().passes;
  }

  get(id: string): Pass | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  private require(id: string): Pass {
    const p = this.get(id);
    if (!p) throw new PassError(404, "That connection no longer exists");
    return p;
  }

  /** A pass by id, Claude server name or display name (any case): how scripts and the setup chat name one. */
  find(ref: string, among?: string[]): Pass | null {
    const r = ref.trim().toLowerCase();
    const list = this.list().filter((p) => !among || among.includes(p.id));
    return list.find((p) => p.id === ref) ?? list.find((p) => p.claudeName?.toLowerCase() === r) ?? list.find((p) => p.name.toLowerCase() === r)
      ?? list.find((p) => p.envName?.toLowerCase() === r) ?? null;
  }

  view(p: Pass): PassView {
    return {
      id: p.id, kind: p.kind, name: p.name, claudeName: p.claudeName, url: p.url ?? null, envName: p.envName ?? null,
      status: p.status, error: p.error ? this.mask(p.error) : null, createdAt: p.createdAt,
    };
  }

  /** Every secret the board holds, to hide them in errors, logs and script output. */
  secrets(): string[] {
    return this.list().flatMap((p) => [p.secret, p.tokens?.access, p.tokens?.refresh, p.oauth?.clientSecret]).filter((s): s is string => !!s && s.length >= 6);
  }

  /** Hides known secrets and anything that looks like one. */
  mask(text: string): string {
    return maskText(text, this.secrets());
  }

  /** Adds a pass. mcp: waits for authorizeUrl + the sign-in; key and local: connected at once. */
  async add(input: AddPassInput): Promise<Pass> {
    const kind = String(input.kind ?? "");
    const claudeName = typeof input.claudeName === "string" && input.claudeName.trim() ? input.claudeName.trim() : null;
    const base = { id: newId(), claudeName, error: null, createdAt: this.deps.now().toISOString() };
    if (kind === "local") {
      if (!claudeName) throw new PassError(400, "Pick the program from Connections");
      this.localServer(claudeName);
      const p: Pass = { ...base, kind: "local", name: nameOr(input.name, claudeName), status: "connected" };
      this.save(p);
      return p;
    }
    if (kind === "mcp") {
      const url = httpUrl(input.url);
      const p: Pass = { ...base, kind: "mcp", name: nameOr(input.name, claudeName ?? new URL(url).host), url, status: "pending" };
      this.save(p);
      return p;
    }
    if (kind === "key") {
      const secret = typeof input.secret === "string" ? input.secret.trim() : "";
      if (!secret) throw new PassError(400, "Paste the key");
      if (/[\r\n\0]/.test(secret)) throw new PassError(400, "The key must be on one line");
      const url = input.url ? httpUrl(input.url) : undefined;
      const name = nameOr(input.name, claudeName ?? "");
      if (!name) throw new PassError(400, "Give the key a name, e.g. Jira");
      let envName: string | undefined;
      if (!url) {
        envName = typeof input.envName === "string" && input.envName.trim() ? input.envName.trim() : envNameFor(name);
        if (!ENV_NAME.test(envName) || RESERVED_ENV.has(envName)) throw new PassError(400, `"${envName}" can't be used as the key's name for scripts: use capital letters, digits and _`);
        if (this.list().some((x) => x.envName === envName)) throw new PassError(409, `A key named ${envName} already exists: replace that one instead`);
      }
      const p: Pass = { ...base, kind: "key", name, ...(url ? { url } : {}), ...(envName ? { envName } : {}), secret, status: "connected" };
      this.save(p);
      return p;
    }
    throw new PassError(400, 'kind must be "mcp", "key" or "local"');
  }

  /** A new key for a key pass (the old one is replaced). */
  replaceKey(id: string, secret: unknown): Pass {
    const p = this.require(id);
    if (p.kind !== "key") throw new PassError(400, "Only a key can be replaced");
    const s = typeof secret === "string" ? secret.trim() : "";
    if (!s || /[\r\n\0]/.test(s)) throw new PassError(400, "Paste the new key on one line");
    const next: Pass = { ...p, secret: s, status: "connected", error: null };
    this.save(next);
    return next;
  }

  remove(id: string): void {
    this.require(id);
    const f = this.read();
    this.write({ ...f, passes: f.passes.filter((p) => p.id !== id) });
    this.bus.emit({ type: "integration.updated" });
  }

  /**
   * The address to send the user to, to approve the board at the service. Finds the service's sign-in and registers
   * the board there first (again when the board's address changed). A service that can't register clients gets a
   * PassError with code no_registration: the UI offers to paste a key instead.
   */
  async authorizeUrl(id: string): Promise<string> {
    let p = this.require(id);
    if (p.kind !== "mcp" || !p.url) throw new PassError(400, "This connection has no sign-in step");
    const redirect = this.callbackUrl();
    if (!p.oauth || p.oauth.redirectUri !== redirect) {
      try {
        const server = await discover(p.url, this.deps);
        const client = await register(server, redirect, this.deps);
        p = { ...p, oauth: { ...client, redirectUri: redirect, authorizationEndpoint: server.authorizationEndpoint, tokenEndpoint: server.tokenEndpoint, resource: p.url, ...(server.readScopes.length ? { scope: server.readScopes.join(" ") } : {}) } };
      } catch (e) {
        if (e instanceof NoRegistrationError) {
          throw new PassError(409, `${p.name} can't be signed in to from the board by itself. Paste a key for it instead.`, "no_registration");
        }
        throw new PassError(502, `Could not start the sign-in with ${p.name}: ${this.mask((e as Error).message)}`);
      }
      this.save(p);
    }
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    for (const [k, v] of this.signIns) if (v.expires < Date.now()) this.signIns.delete(k);
    this.signIns.set(state, { passId: id, expires: Date.now() + SIGN_IN_MS, verifier });
    return authorizeUrl(p.oauth!, state, createHash("sha256").update(verifier).digest("base64url"));
  }

  /** The service sent the user back with a code. The state must be one authorizeUrl made, and works once. */
  async complete(state: string, code: string): Promise<Pass> {
    const s = this.signIns.get(state);
    this.signIns.delete(state);
    if (!s || s.expires < Date.now()) throw new PassError(400, "This sign-in link is not valid any more. Start again from Connections.");
    const p = this.require(s.passId);
    if (!p.oauth) throw new PassError(400, "Start the sign-in again from Connections.");
    let tokens: Tokens;
    try {
      tokens = await exchange(p.oauth, code, s.verifier, this.deps);
    } catch (e) {
      this.save({ ...p, status: "pending", error: (e as Error).message });
      throw new PassError(502, this.mask((e as Error).message));
    }
    // A token that can't list the tools is no use: say so now, not at the first check.
    const signedIn: Pass = { ...p, tokens, status: "connected", error: null };
    this.save(signedIn);
    try {
      await this.withClient(signedIn.id, (c) => c.listTools());
    } catch (e) {
      const why = `${p.name} signed you in but didn't let the board use its tools: ${(e as Error).message}`;
      this.save({ ...signedIn, status: "needs_reconnect", error: why });
      throw new PassError(502, this.mask(why));
    }
    return this.get(p.id)!;
  }

  /** The service refused this pass: automations using it wait and the UI asks to connect again. */
  markNeedsReconnect(id: string, message: string): void {
    const p = this.get(id);
    if (p && (p.status !== "needs_reconnect" || p.error !== message)) this.save({ ...p, status: "needs_reconnect", error: message });
  }

  /** The access token, renewed first when it is about to run out. One renewal per pass at a time. */
  private token(id: string): Promise<string> {
    const p = this.get(id);
    if (!p?.tokens) return Promise.reject(new AuthError("This connection is not signed in"));
    const soon = p.tokens.expiresAt && Date.parse(p.tokens.expiresAt) - this.deps.now().getTime() < RENEW_MS;
    if (!soon) return Promise.resolve(p.tokens.access);
    let renewing = this.renewing.get(id);
    if (!renewing) {
      renewing = this.renew(p).finally(() => this.renewing.delete(id));
      this.renewing.set(id, renewing);
    }
    return renewing;
  }

  private async renew(p: Pass): Promise<string> {
    if (!p.oauth || !p.tokens?.refresh) throw new AuthError("The sign-in expired. Connect again.");
    const tokens = await refresh(p.oauth, p.tokens.refresh, this.deps);
    // The service may keep the same refresh token.
    this.save({ ...p, tokens: { refresh: p.tokens.refresh, ...tokens } });
    return tokens.access;
  }

  /** Claude's own settings for a program on this computer, read again each time (never copied). */
  private localServer(claudeName: string) {
    const cfg = readMcpConfig(claudeName, this.home, this.configFile);
    if (!cfg) throw new PassError(404, `${claudeName} isn't in Claude's settings any more`);
    if (cfg.scope !== "user" && cfg.scope !== "local") {
      throw new PassError(400, `${claudeName} comes from a project's .mcp.json: the board only starts programs from your own Claude settings`);
    }
    if (cfg.transport !== "stdio" || !cfg.command) throw new PassError(400, `${claudeName} isn't a program on this computer`);
    return cfg;
  }

  /** Opens the pass's tool server, runs fn, and closes it again. Auth failures mark the pass. */
  async withClient<T>(id: string, fn: (c: ToolClient) => Promise<T>): Promise<T> {
    const p = this.require(id);
    let client: ToolClient;
    if (p.kind === "local") {
      const cfg = this.localServer(p.claudeName ?? "");
      const env = { ...inheritedEnv(), ...Object.fromEntries((cfg.env ?? []).map((e) => [e.key, e.value])) } as Record<string, string>;
      client = new StdioMcpClient({ command: cfg.command!, args: cfg.args ?? [], env, cwd: this.home }, this.o.stdioTimeoutMs);
    } else if (p.kind === "mcp") {
      if (p.status === "pending") throw new AuthError(`${p.name} isn't signed in yet: press Connect in Connections`);
      client = new McpClient(p.url!, await this.token(id), this.deps);
    } else if (p.url) {
      client = new McpClient(p.url, p.secret ?? "", this.deps);
    } else {
      throw new PassError(400, `${p.name} is a key for scripts (${p.envName}), not a service the board can call`);
    }
    try {
      return await fn(client);
    } catch (e) {
      if (e instanceof AuthError) this.markNeedsReconnect(id, e.message);
      throw e;
    } finally {
      await client.close().catch(() => {});
    }
  }

  call(id: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    return this.withClient(id, (c) => c.call(tool, args));
  }

  tools(id: string): Promise<{ name: string; description?: string }[]> {
    return this.withClient(id, async (c) => (await c.listTools()).map((t) => ({ name: t.name, ...(t.description ? { description: t.description.slice(0, 300) } : {}) })));
  }

  /** The environment variables a script gets for these passes: the keys meant for scripts, nothing else. */
  envFor(ids: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.list()) if (ids.includes(p.id) && p.kind === "key" && !p.url && p.envName && p.secret) out[p.envName] = p.secret;
    return out;
  }
}

function nameOr(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, 60) : "";
  return s || fallback;
}

function httpUrl(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  try {
    return webAddress(s);
  } catch {
    throw new PassError(400, "The address must start with https://");
  }
}

/** "Linear API key" -> LINEAR_API_KEY. */
export function envNameFor(name: string): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "_$1");
  if (!base) return "API_KEY";
  return /(KEY|TOKEN|SECRET)$/.test(base) ? base : `${base}_KEY`;
}

/** Hides the given secrets, bearer tokens and secret-looking values in text meant for the UI or logs. */
export function maskText(text: string, secrets: string[]): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join("***");
  out = out.replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 ***");
  out = out.replace(/("?(?:access_token|refresh_token|api_key|apikey|client_secret|password|secret)"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1***");
  return maskSecrets(out);
}
