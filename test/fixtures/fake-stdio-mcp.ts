#!/usr/bin/env bun
// A fake MCP server that runs on this computer (stdio), like one in Claude's own settings. FAKE_GREETING is read from
// its environment (Claude's settings for it set it), and every call is appended to FAKE_STDIO_LOG.
import { appendFileSync } from "node:fs";

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
    const msg = JSON.parse(buf.slice(0, i));
    if (process.env.FAKE_STDIO_LOG) appendFileSync(process.env.FAKE_STDIO_LOG, JSON.stringify(msg.method) + "\n");
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "stdio", version: "1" } } });
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "greet" }] } });
    else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ greeting: process.env.FAKE_GREETING ?? "", args: msg.params.arguments }) }] } });
  }
}
