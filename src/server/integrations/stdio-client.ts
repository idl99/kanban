import { toolAnswer } from "./mcp-client";
import type { ToolClient } from "./types";

const PROTOCOL = "2025-03-26";

export interface StdioServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/**
 * A client for an MCP server that runs on this computer (stdio, newline-delimited JSON-RPC), started the way Claude
 * starts it. It runs in its own process group with a time limit, and close() kills the whole group, so a server
 * that starts helpers can't leave them behind.
 */
export class StdioMcpClient implements ToolClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private ready: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stderr = "";

  constructor(private server: StdioServer, private timeoutMs = 60_000) {}

  private start() {
    try {
      this.proc = Bun.spawn([this.server.command, ...this.server.args], {
        cwd: this.server.cwd, env: this.server.env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true,
      });
    } catch (e) {
      throw new Error(`Could not start ${this.server.command}: ${(e as Error).message}`);
    }
    this.timer = setTimeout(() => this.fail(new Error("The program took too long to answer")), this.timeoutMs);
    void this.read(this.proc.stdout as ReadableStream<Uint8Array>);
    void new Response(this.proc.stderr as ReadableStream).text().then((t) => (this.stderr = t.slice(-2000)), () => {});
    void this.proc.exited.then((code) => this.fail(new Error(`The program stopped (exit ${code})${this.stderr.trim() ? `: ${this.stderr.trim().split("\n").pop()}` : ""}`)));
  }

  private async read(out: ReadableStream<Uint8Array>) {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of out) {
        buf += dec.decode(chunk, { stream: true });
        for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
          let msg: any;
          try {
            msg = JSON.parse(buf.slice(0, i));
          } catch {
            continue;
          }
          const w = typeof msg?.id === "number" ? this.waiting.get(msg.id) : undefined;
          if (!w) continue;
          this.waiting.delete(msg.id);
          if (msg.error) w.reject(new Error(String(msg.error.message ?? "The program refused the request")));
          else w.resolve(msg.result);
        }
      }
    } catch {}
  }

  private fail(e: Error) {
    for (const w of this.waiting.values()) w.reject(e);
    this.waiting.clear();
  }

  private send(msg: unknown) {
    const stdin = this.proc!.stdin as import("bun").FileSink;
    stdin.write(JSON.stringify(msg) + "\n");
    stdin.flush();
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const p = new Promise<any>((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    this.send({ jsonrpc: "2.0", id, method, params });
    return p;
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      this.start();
      await this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "ckanban", version: "1" } });
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    })();
    return this.ready;
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
    await this.init();
    return (await this.request("tools/list", {})).tools ?? [];
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.init();
    return toolAnswer(name, await this.request("tools/call", { name, arguments: args }));
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    const p = this.proc;
    if (!p) return;
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {
      p.kill("SIGKILL");
    }
  }
}
