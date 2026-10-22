import { AuthError, RateLimitError, type Deps, type ToolClient } from "./types";

const PROTOCOL = "2025-03-26";

/**
 * A small client for a remote MCP server over streamable HTTP: initialize, then call tools. One client per piece of
 * work; nothing is kept between them. A token that comes from the server's own sign-in only works here.
 */
export class McpClient implements ToolClient {
  private session: string | null = null;
  private nextId = 1;
  private ready: Promise<void> | null = null;

  constructor(private url: string, private token: string, private deps: Deps) {}

  private async post(body: unknown): Promise<Response> {
    const res = await this.deps.fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${this.token}`,
        "mcp-protocol-version": PROTOCOL, ...(this.session ? { "mcp-session-id": this.session } : {}),
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) throw new AuthError("The service no longer accepts this connection");
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      throw new RateLimitError("The service is limiting requests", (Number.isFinite(retry) && retry > 0 ? retry : 60) * 1000);
    }
    if (!res.ok) throw new Error(`The service answered ${res.status}`);
    return res;
  }

  /** The reply to request `id`: plain JSON, or the matching message of an event stream. */
  private async reply(res: Response, id: number): Promise<any> {
    const text = await res.text();
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try {
          const msg = JSON.parse(data);
          if (msg?.id === id) return msg;
        } catch {}
      }
      throw new Error("The service sent no answer");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("The service sent an answer ckanban can't read");
    }
  }

  private async request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    if (method === "initialize") this.session = res.headers.get("mcp-session-id") ?? this.session;
    const msg = await this.reply(res, id);
    if (msg.error) throw new Error(String(msg.error.message ?? "The service refused the request"));
    return msg.result;
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      await this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "ckanban", version: "1" } });
      await (await this.post({ jsonrpc: "2.0", method: "notifications/initialized" })).text();
    })();
    return this.ready;
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
    await this.init();
    return (await this.request("tools/list", {})).tools ?? [];
  }

  /** Calls a tool and returns what it answered: its JSON text parsed, or the plain text. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.init();
    return toolAnswer(name, await this.request("tools/call", { name, arguments: args }));
  }

  /** Ends the session on the server (best effort). */
  async close(): Promise<void> {
    if (!this.session) return;
    await this.deps.fetch(this.url, { method: "DELETE", headers: { authorization: `Bearer ${this.token}`, "mcp-session-id": this.session } }).catch(() => {});
  }
}

/** A tools/call result as its JSON text parsed, or the plain text. Throws the tool's own error text. */
export function toolAnswer(name: string, result: any): unknown {
  const text = (result?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("\n");
  if (result?.isError) throw new Error(text || `${name} failed`);
  if (result?.structuredContent !== undefined && !text) return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
