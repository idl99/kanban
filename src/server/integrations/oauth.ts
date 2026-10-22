import { AuthError, type Deps, type Tokens } from "./types";

// The sign-in every online MCP server is meant to support (MCP authorization spec): find the server's sign-in
// addresses from the server itself, register ckanban as a client on the spot (RFC 7591), and sign in with a one-time
// proof (PKCE) for a token bound to that server (RFC 8707 `resource`). Nothing here is written for one service.

/** Where a server signs people in, as its metadata says. */
export interface SignInServer {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Missing: the server doesn't let clients register themselves, so the user pastes a key instead. */
  registrationEndpoint?: string;
  /** The read-only scopes it offers ("read", "org:read"); empty: ask for none, the server's default. */
  readScopes: string[];
}

/** Scopes that only read, by their name: "read", "x:read", "read:x", "x.read". */
export function readScopes(supported: unknown): string[] {
  if (!Array.isArray(supported)) return [];
  return supported.map(String).filter((s) => /^read$|[:.]read$|^read[:.]/i.test(s));
}

/** The server can't register ckanban by itself: ask the user for a key instead. */
export class NoRegistrationError extends Error {}

async function getJson(url: string, deps: Deps): Promise<any | null> {
  try {
    const res = await deps.fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** `resource_metadata="..."` from a 401's WWW-Authenticate header. */
export function resourceMetadataUrl(header: string | null): string | null {
  const m = header?.match(/resource_metadata="([^"]+)"/i);
  return m ? m[1] : null;
}

/** RFC 8414 / OpenID addresses for an issuer: path-aware first, then at the root. */
function metadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, "");
  const urls = [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`];
  if (path) urls.push(`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}${path}/.well-known/openid-configuration`);
  return [...new Set(urls)];
}

/**
 * The server's sign-in addresses. Asks the MCP address without a token for its protected-resource metadata (the
 * 401's header, or the well-known address), then the sign-in server's metadata. Servers that predate that metadata
 * keep it at their own origin, which is tried last.
 */
export async function discover(mcpUrl: string, deps: Deps): Promise<SignInServer> {
  const url = new URL(mcpUrl);
  let prm: string | null = null;
  try {
    const res = await deps.fetch(mcpUrl, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ckanban", version: "1" } } }),
    });
    prm = resourceMetadataUrl(res.headers.get("www-authenticate"));
    await res.body?.cancel().catch(() => {});
  } catch {
    throw new Error(`Could not reach ${url.host}`);
  }
  const path = url.pathname.replace(/\/$/, "");
  const resource = (prm && (await getJson(prm, deps)))
    ?? (path ? await getJson(`${url.origin}/.well-known/oauth-protected-resource${path}`, deps) : null)
    ?? (await getJson(`${url.origin}/.well-known/oauth-protected-resource`, deps));
  const issuers: string[] = Array.isArray(resource?.authorization_servers) && resource.authorization_servers.length
    ? resource.authorization_servers.map(String) : [url.origin];
  for (const issuer of issuers) {
    for (const m of metadataUrls(issuer)) {
      const meta = await getJson(m, deps);
      if (meta?.authorization_endpoint && meta?.token_endpoint) {
        return {
          authorizationEndpoint: String(meta.authorization_endpoint), tokenEndpoint: String(meta.token_endpoint),
          ...(meta.registration_endpoint ? { registrationEndpoint: String(meta.registration_endpoint) } : {}),
          readScopes: readScopes(meta.scopes_supported),
        };
      }
    }
  }
  throw new NoRegistrationError(`${url.host} doesn't say how to sign in`);
}

/** Registers ckanban for this callback address (no secret: a public client that signs in with PKCE). */
export async function register(server: SignInServer, redirectUri: string, deps: Deps): Promise<{ clientId: string; clientSecret?: string }> {
  if (!server.registrationEndpoint) throw new NoRegistrationError("This service doesn't let ckanban sign in by itself");
  const res = await deps.fetch(server.registrationEndpoint, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "ckanban", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none", ...(server.readScopes.length ? { scope: server.readScopes.join(" ") } : {}),
    }),
  });
  let b: any = {};
  try {
    b = await res.json();
  } catch {}
  if (!res.ok || !b.client_id) throw new Error(String(b.error_description ?? b.error ?? `registration answered ${res.status}`));
  return { clientId: String(b.client_id), ...(b.client_secret ? { clientSecret: String(b.client_secret) } : {}) };
}

export interface Client {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** The MCP address the token is for. */
  resource: string;
  /** Asked for when set: the server's read-only scopes, so the board's pass can only read where the server allows it. */
  scope?: string;
}

export function authorizeUrl(c: Client, state: string, challenge: string): string {
  const u = new URL(c.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", c.clientId);
  u.searchParams.set("redirect_uri", c.redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", c.resource);
  if (c.scope) u.searchParams.set("scope", c.scope);
  return u.toString();
}

async function tokenCall(c: Client, params: Record<string, string>, deps: Deps): Promise<Tokens> {
  const res = await deps.fetch(c.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...params, client_id: c.clientId, resource: c.resource, ...(c.clientSecret ? { client_secret: c.clientSecret } : {}) }).toString(),
  });
  let b: any = {};
  try {
    b = await res.json();
  } catch {}
  if (!res.ok || !b.access_token) {
    const why = String(b.error_description ?? b.error ?? `status ${res.status}`);
    if (params.grant_type === "refresh_token") throw new AuthError(`The service refused to renew the connection: ${why}`);
    throw new Error(`The service refused the sign-in: ${why}`);
  }
  const seconds = Number(b.expires_in);
  return {
    access: String(b.access_token),
    ...(b.refresh_token ? { refresh: String(b.refresh_token) } : {}),
    ...(Number.isFinite(seconds) && seconds > 0 ? { expiresAt: new Date(deps.now().getTime() + seconds * 1000).toISOString() } : {}),
  };
}

export function exchange(c: Client, code: string, verifier: string, deps: Deps): Promise<Tokens> {
  return tokenCall(c, { grant_type: "authorization_code", code, redirect_uri: c.redirectUri, code_verifier: verifier }, deps);
}

export function refresh(c: Client, refreshToken: string, deps: Deps): Promise<Tokens> {
  return tokenCall(c, { grant_type: "refresh_token", refresh_token: refreshToken }, deps);
}
