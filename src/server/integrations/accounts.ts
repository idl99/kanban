import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bus } from "../events";
import { newId } from "../util";
import type { Registry } from "./registry";
import { AuthError, type AccountContext, type Deps, type FieldOption, type Identity, type Tokens } from "./types";

export type AccountStatus = "pending" | "connected" | "needs_reconnect";

/** One signed-in account of a provider, shared by every board. Holds secrets: never sent to the UI as is (see view). */
export interface Account {
  id: string;
  provider: string;
  credentials: Record<string, string>;
  tokens?: Tokens;
  identity?: Identity;
  status: AccountStatus;
  error: string | null;
  createdAt: string;
}

/** What the UI may see of an account: secret fields only as "is it set". */
export interface AccountView {
  id: string;
  provider: string;
  providerName: string | null;
  status: AccountStatus;
  error: string | null;
  identity: Identity | null;
  createdAt: string;
  credentials: Record<string, string>;
  secretsSet: string[];
}

export class AccountError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface File {
  version: 1;
  accounts: Account[];
}

/** An access token is renewed when it has less than this long left. */
const RENEW_MS = 60_000;
/** The user has this long to finish signing in at the service. */
const SIGN_IN_MS = 10 * 60_000;

/**
 * The accounts file (`integrations.json` in the data folder, readable by the owner only: it holds client secrets and
 * tokens), the sign-in flow and token renewal. Providers do the service-specific calls; this is the same for all.
 */
export class Accounts {
  private file: string;
  private signIns = new Map<string, { accountId: string; expires: number; verifier?: string }>();
  private renewing = new Map<string, Promise<string>>();

  constructor(root: string, private registry: Registry, private bus: Bus, private deps: Deps, private callbackUrl: () => string) {
    this.file = join(root, "integrations.json");
  }

  private read(): File {
    if (!existsSync(this.file)) return { version: 1, accounts: [] };
    try {
      const f = JSON.parse(readFileSync(this.file, "utf8"));
      return { version: 1, accounts: Array.isArray(f.accounts) ? f.accounts : [] };
    } catch {
      return { version: 1, accounts: [] };
    }
  }

  private write(f: File) {
    const tmp = `${this.file}.tmp-${newId()}`;
    writeFileSync(tmp, JSON.stringify(f, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  private save(a: Account) {
    const f = this.read();
    const i = f.accounts.findIndex((x) => x.id === a.id);
    if (i < 0) f.accounts.push(a);
    else f.accounts[i] = a;
    this.write(f);
    this.bus.emit({ type: "integration.updated" });
  }

  list(): Account[] {
    return this.read().accounts;
  }

  get(id: string): Account | null {
    return this.list().find((a) => a.id === id) ?? null;
  }

  private require(id: string): Account {
    const a = this.get(id);
    if (!a) throw new AccountError(404, "That connection no longer exists");
    return a;
  }

  view(a: Account): AccountView {
    const p = this.registry.provider(a.provider);
    const secret = new Set(p?.fields.filter((f) => f.secret).map((f) => f.id));
    return {
      id: a.id, provider: a.provider, providerName: p?.name ?? null, status: a.status, error: a.error, identity: a.identity ?? null,
      createdAt: a.createdAt,
      credentials: Object.fromEntries(Object.entries(a.credentials).filter(([k]) => !secret.has(k))),
      secretsSet: Object.entries(a.credentials).filter(([k, v]) => secret.has(k) && v).map(([k]) => k),
    };
  }

  private cleanCredentials(providerId: string, input: unknown, keep: Record<string, string> = {}): Record<string, string> {
    const p = this.registry.provider(providerId);
    if (!p) throw new AccountError(400, `Unknown integration "${providerId}"`);
    const given = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const out: Record<string, string> = {};
    for (const f of p.fields) {
      const v = typeof given[f.id] === "string" ? (given[f.id] as string).trim() : "";
      // Secrets are never shown, so an empty field keeps the saved one.
      const value = v || keep[f.id] || "";
      if (!value) throw new AccountError(400, `${f.label} is required`);
      out[f.id] = value;
    }
    return out;
  }

  /** Saves the account. With sign-in (oauth): it waits for authorize(); without, it connects at once. */
  async add(providerId: string, credentials: unknown): Promise<Account> {
    const p = this.registry.provider(providerId);
    if (!p) throw new AccountError(400, `Unknown integration "${providerId}"`);
    const a: Account = {
      id: newId(), provider: providerId, credentials: this.cleanCredentials(providerId, credentials), status: "pending", error: null,
      createdAt: this.deps.now().toISOString(),
    };
    if (!p.oauth) return this.finish(a, { access: a.credentials.token ?? "" });
    this.save(a);
    return a;
  }

  /** Changes the pasted credentials (an empty secret keeps the old one); it needs signing in again. */
  update(id: string, credentials: unknown): Account {
    const a = this.require(id);
    const next: Account = { ...a, credentials: this.cleanCredentials(a.provider, credentials, a.credentials), status: "pending", error: null };
    delete next.tokens;
    this.save(next);
    return next;
  }

  remove(id: string): void {
    this.require(id);
    const f = this.read();
    this.write({ ...f, accounts: f.accounts.filter((a) => a.id !== id) });
    this.bus.emit({ type: "integration.updated" });
  }

  /** The address to send the user to, to approve ckanban at the service. Registers ckanban first when the service allows it. */
  async authorizeUrl(id: string): Promise<string> {
    let a = this.require(id);
    const p = this.registry.provider(a.provider);
    if (!p?.oauth) throw new AccountError(400, "This integration has no sign-in step");
    const redirect = this.callbackUrl();
    // A registration belongs to one callback address: a new port needs a new one.
    if (p.oauth.register && (!a.credentials.clientId || a.credentials.redirectUri !== redirect)) {
      try {
        a = { ...a, credentials: { ...a.credentials, ...(await p.oauth.register(redirect, this.deps)), redirectUri: redirect } };
      } catch (e) {
        throw new AccountError(502, `Could not register ckanban with ${p.name}: ${(e as Error).message}`);
      }
      this.save(a);
    }
    const state = randomBytes(24).toString("base64url");
    const verifier = p.oauth.pkce ? randomBytes(32).toString("base64url") : undefined;
    for (const [k, v] of this.signIns) if (v.expires < Date.now()) this.signIns.delete(k);
    this.signIns.set(state, { accountId: id, expires: Date.now() + SIGN_IN_MS, verifier });
    const challenge = verifier ? createHash("sha256").update(verifier).digest("base64url") : undefined;
    return p.oauth.authorizeUrl(a.credentials, redirect, state, challenge);
  }

  /** The service sent the user back with a code. The state must be one authorizeUrl made, and works once. */
  async complete(state: string, code: string): Promise<Account> {
    const s = this.signIns.get(state);
    this.signIns.delete(state);
    if (!s || s.expires < Date.now()) throw new AccountError(400, "This sign-in link is not valid any more. Start again from Integrations.");
    const a = this.require(s.accountId);
    const p = this.registry.provider(a.provider)!;
    try {
      return await this.finish(a, await p.oauth!.exchange(a.credentials, code, a.credentials.redirectUri ?? this.callbackUrl(), this.deps, s.verifier));
    } catch (e) {
      this.save({ ...a, status: "pending", error: (e as Error).message });
      throw new AccountError(502, (e as Error).message);
    }
  }

  private async finish(a: Account, tokens: Tokens): Promise<Account> {
    const p = this.registry.provider(a.provider)!;
    let identity: Identity;
    try {
      identity = await p.identify(tokens.access, this.deps);
    } catch (e) {
      throw new AccountError(502, `Could not check the account: ${(e as Error).message}`);
    }
    const done: Account = { ...a, tokens, identity, status: "connected", error: null };
    this.save(done);
    void this.writeDiagnostics(done);
    return done;
  }

  /** Saves what the service's API looks like to `integrations-debug/<provider>.json`: for a developer, never holds tokens. */
  private async writeDiagnostics(a: Account): Promise<void> {
    const p = this.registry.provider(a.provider);
    if (!p?.diagnose || !a.tokens) return;
    try {
      const dir = join(this.file, "..", "integrations-debug");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${a.provider}.json`), JSON.stringify({ at: this.deps.now().toISOString(), ...(await p.diagnose(a.tokens.access, this.deps) as object) }, null, 2) + "\n");
    } catch {}
  }

  /** The service refused this account: loops stop polling and the UI asks to connect again. */
  markNeedsReconnect(id: string, message: string): void {
    const a = this.get(id);
    if (a && (a.status !== "needs_reconnect" || a.error !== message)) this.save({ ...a, status: "needs_reconnect", error: message });
  }

  /** The account a loop polls as; null unless it is connected. */
  context(id: string): AccountContext | null {
    const a = this.get(id);
    if (!a || a.status !== "connected" || !a.identity) return null;
    return { id, identity: a.identity, deps: this.deps, token: () => this.token(id) };
  }

  private token(id: string): Promise<string> {
    const a = this.get(id);
    if (!a?.tokens) return Promise.reject(new AuthError("This connection is not signed in"));
    const soon = a.tokens.expiresAt && Date.parse(a.tokens.expiresAt) - this.deps.now().getTime() < RENEW_MS;
    if (!soon) return Promise.resolve(a.tokens.access);
    let p = this.renewing.get(id);
    if (!p) {
      p = this.renew(a).finally(() => this.renewing.delete(id));
      this.renewing.set(id, p);
    }
    return p;
  }

  private async renew(a: Account): Promise<string> {
    const oauth = this.registry.provider(a.provider)?.oauth;
    if (!oauth || !a.tokens?.refresh) throw new AuthError("The sign-in expired. Connect again.");
    const tokens = await oauth.refresh(a.credentials, a.tokens.refresh, this.deps);
    // The service may keep the same refresh token.
    this.save({ ...a, tokens: { refresh: a.tokens.refresh, ...tokens } });
    return tokens.access;
  }

  /** Values to pick from for a filter field, from the service. */
  async options(id: string, providerTrigger: string, fieldId: string): Promise<FieldOption[]> {
    const a = this.require(id);
    const field = this.registry.trigger(a.provider, providerTrigger)?.fields.find((f) => f.id === fieldId);
    if (!field?.options) return [];
    const ctx = this.context(id);
    if (!ctx) throw new AccountError(409, "This connection needs to be signed in again");
    try {
      return await field.options(ctx);
    } catch (e) {
      if (e instanceof AuthError) this.markNeedsReconnect(id, e.message);
      throw new AccountError(502, (e as Error).message);
    }
  }
}
