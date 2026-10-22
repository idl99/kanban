// A fake online service with an MCP server and the standard MCP sign-in (protected-resource metadata, dynamic client
// registration, PKCE, refresh), for the board's passes and automations. Not Linear or any real service: the board
// must work with it without knowing it.
import { createHash } from "node:crypto";

export interface FakeService {
  url: string;
  origin: string;
  issues: { id: string; title: string; url: string; body?: string }[];
  /** Tool calls the server got, with the token they came with. */
  calls: { tool: string; args: any; token: string }[];
  /** Approves a sign-in page the board sent the user to: the code and state the browser would bring back. */
  approve(authorizeUrl: string): { code: string; state: string };
  /** Token requests (grant types) the server got. */
  tokenRequests: string[];
  stop(): void;
}

export function startFakeService(o: { registration?: boolean; expiresIn?: number; authorizeEndpoint?: string } = {}): FakeService {
  const registration = o.registration ?? true;
  const codes = new Map<string, { challenge: string; clientId: string; redirect: string; resource: string }>();
  const tokens = new Set<string>();
  const refresh = new Set<string>();
  let n = 0;
  const svc = { issues: [], calls: [], tokenRequests: [] } as unknown as FakeService;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const issue = () => {
    const access = `at-${++n}`;
    const r = `rt-${n}`;
    tokens.add(access);
    refresh.add(r);
    return { access_token: access, refresh_token: r, token_type: "Bearer", ...(o.expiresIn ? { expires_in: o.expiresIn } : {}) };
  };
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      const u = new URL(req.url);
      const origin: string = `http://127.0.0.1:${server.port}`;
      if (u.pathname === "/.well-known/oauth-protected-resource/mcp") return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      if (u.pathname === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: origin, authorization_endpoint: o.authorizeEndpoint ?? `${origin}/authorize`, token_endpoint: `${origin}/token`,
          ...(registration ? { registration_endpoint: `${origin}/register` } : {}), code_challenge_methods_supported: ["S256"], scopes_supported: ["read", "write"],
        });
      }
      if (u.pathname === "/register" && req.method === "POST") {
        const b: any = await req.json();
        if (!Array.isArray(b.redirect_uris) || b.token_endpoint_auth_method !== "none") return json({ error: "invalid_client_metadata" }, 400);
        return json({ client_id: `client-${++n}`, redirect_uris: b.redirect_uris }, 201);
      }
      if (u.pathname === "/token" && req.method === "POST") {
        const f = new URLSearchParams(await req.text());
        svc.tokenRequests.push(f.get("grant_type") ?? "");
        if (f.get("resource") !== `${origin}/mcp`) return json({ error: "invalid_target" }, 400);
        if (f.get("grant_type") === "authorization_code") {
          const c = codes.get(f.get("code") ?? "");
          codes.delete(f.get("code") ?? "");
          const ok = c && c.clientId === f.get("client_id") && c.redirect === f.get("redirect_uri")
            && createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === c.challenge;
          return ok ? json(issue()) : json({ error: "invalid_grant" }, 400);
        }
        if (f.get("grant_type") === "refresh_token") {
          const r = f.get("refresh_token") ?? "";
          if (!refresh.delete(r)) return json({ error: "invalid_grant", error_description: "refresh token already used" }, 400);
          return json(issue());
        }
        return json({ error: "unsupported_grant_type" }, 400);
      }
      if (u.pathname === "/mcp") {
        const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        if (!tokens.has(token)) {
          return new Response("unauthorized", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } });
        }
        if (req.method === "DELETE") return new Response(null, { status: 204 });
        const msg: any = await req.json();
        if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (msg.method === "initialize") {
          return json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }, 200, { "mcp-session-id": "s1" });
        }
        if (msg.method === "tools/list") {
          return json({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "list_issues", description: "Issues assigned to you" }, { name: "delete_issue" }] } });
        }
        if (msg.method === "tools/call") {
          const { name, arguments: args } = msg.params;
          svc.calls.push({ tool: name, args, token });
          if (name === "list_issues") return json({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ issues: svc.issues }) }] } });
          if (name === "delete_issue") return json({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "deleted" }] } });
          return json({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: `no tool ${name}` }] } });
        }
        return json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return Object.assign(svc, {
    url: `${origin}/mcp`, origin,
    approve(authorizeUrl: string) {
      const a = new URL(authorizeUrl);
      if (a.searchParams.get("code_challenge_method") !== "S256") throw new Error("no PKCE");
      const code = `code-${++n}`;
      codes.set(code, {
        challenge: a.searchParams.get("code_challenge") ?? "", clientId: a.searchParams.get("client_id") ?? "",
        redirect: a.searchParams.get("redirect_uri") ?? "", resource: a.searchParams.get("resource") ?? "",
      });
      return { code, state: a.searchParams.get("state") ?? "" };
    },
    stop: () => server.stop(true),
  });
}
