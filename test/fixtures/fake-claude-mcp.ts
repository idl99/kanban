#!/usr/bin/env bun
// Fake `claude mcp …` for tests. State lives in FAKE_MCP_STATE (JSON: name → status line), argv log in FAKE_ARGS_FILE.
// FAKE_LOGIN=fail makes `login` exit 1, FAKE_ADD=fail makes `add` exit 1.
// FAKE_LIST_MS makes `list` print the state it read at start only after that many ms (a slow health check).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_ARGS_FILE) appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args) + "\n");
const file = process.env.FAKE_MCP_STATE!;
const state: Record<string, { target: string; status: string }> = JSON.parse(readFileSync(file, "utf8"));
const save = () => writeFileSync(file, JSON.stringify(state));
const [, cmd, name] = args;

if (cmd === "list") {
  if (process.env.FAKE_LIST_MS) await Bun.sleep(Number(process.env.FAKE_LIST_MS));
  console.log("Checking MCP server health…\n");
  for (const [n, s] of Object.entries(state)) console.log(`${n}: ${s.target} - ${s.status}`);
} else if (cmd === "get") {
  if (!state[name]) {
    console.error(`No MCP server named "${name}".`);
    process.exit(1);
  }
  console.log(`${name}:\n  Scope: User config\n  Status: ${state[name].status}\n  Type: http`);
} else if (cmd === "login") {
  if (process.env.FAKE_LOGIN === "fail") {
    console.error("OAuth discovery failed");
    process.exit(1);
  }
  console.log(`Visit this URL to authorize:\n  https://auth.example.com/authorize?x=1\n`);
  state[name].status = "✔ Connected";
  save();
} else if (cmd === "logout") {
  state[name].status = "! Needs authentication";
  save();
} else if (cmd === "add") {
  if (process.env.FAKE_ADD === "fail") {
    console.error("add failed");
    process.exit(1);
  }
  const i = args.indexOf("--transport");
  const rest = args.slice(i + 2);
  const n = rest[0];
  const dd = rest.indexOf("--");
  state[n] = { target: dd >= 0 ? rest.slice(dd + 1).join(" ") : `${rest[1]} (HTTP)`, status: "✔ Connected" };
  save();
} else if (cmd === "remove") {
  delete state[name];
  save();
}
