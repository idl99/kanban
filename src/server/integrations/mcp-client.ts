import { AuthError, RateLimitError, type Deps } from "./types";

const PROTOCOL = "2025-03-26";

/**
 * A small client for a remote MCP server over streamable HTTP: initialize, then call tools. Enough for a provider
 * whose sign-in token only works through its MCP server. One client per piece of work; nothing is kept between them.
 */
export class McpClient {
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
    const result = await this.request("tools/call", { name, arguments: args });
    const text = (result?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("\n");
    if (result?.isError) throw new Error(text || `${name} failed`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

/** The first list in a tool's answer: the answer itself, or the first of `keys` (then any property) that is a list. */
export function listOf(data: unknown, ...keys: string[]): any[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const k of keys) if (Array.isArray(o[k])) return o[k] as any[];
    for (const v of Object.values(o)) if (Array.isArray(v)) return v;
  }
  return [];
}

/**
 * What a value looks like, without the private text: dates stay, other text is replaced by its length. For the
 * diagnostics file that lets a developer see a tool's real answer shape.
 */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return /^\d{4}-\d\d-\d\d(T[\d:.]+Z?)?$/.test(v) || v.length <= 3 ? v : `<text:${v.length}>`;
  if (Array.isArray(v)) return depth > 4 ? "<list>" : v.slice(0, 2).map((x) => shapeOf(x, depth + 1));
  if (v && typeof v === "object") {
    return depth > 5 ? "<object>" : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  }
  return v;
}
