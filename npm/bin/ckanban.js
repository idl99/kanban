#!/usr/bin/env node
// `npx ckanban`: installs the ckanban Mac app the first time, then passes any command on to it.
// Env: CKANBAN_VERSION=0.14.0 (default: this package's version)  CKANBAN_BIN_DIR=~/.local/bin
//      CKANBAN_NO_DAEMON=1 (don't start the background service)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetName, binDir, installBinary, isInstalled } from "../lib/install.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const dir = binDir();
const app = join(dir, "ckanban");

function run(cmdArgs) {
  const r = spawnSync(app, cmdArgs, { stdio: "inherit" });
  return r.status ?? 1;
}

function check(cmd, hint) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0 || (console.warn(`! ${hint}`), false);
}

async function setup() {
  await installBinary({ version: process.env.CKANBAN_VERSION || pkg.version, dir });
  check("claude", "Claude Code not found. Install it first: https://claude.com/claude-code");
  if (!process.env.CKANBAN_NO_DAEMON) {
    if (run(["install"]) !== 0) process.exit(1);
    await new Promise((r) => setTimeout(r, 1000));
    run(["open"]);
  }
  if (!(process.env.PATH ?? "").split(":").includes(dir)) {
    console.warn(`! ${dir} is not on your PATH. Add this to ~/.zshrc:  export PATH="${dir}:$PATH"`);
  }
  console.log(process.env.CKANBAN_NO_DAEMON ? "\nDone. Start the board with: ckanban install" : "\nDone. Board: http://localhost:7777\nUpdate later with: ckanban update");
}

if (!assetName()) {
  console.error(process.platform === "darwin" ? `ckanban has no build for this Mac's chip (${process.arch}).` : "ckanban currently supports macOS only.");
  process.exit(1);
}

try {
  if (!isInstalled(dir)) {
    await setup();
    if (args.length === 0) process.exit(0);
  }
  // Already installed: plain `npx ckanban` opens the board, anything else goes to the app.
  process.exit(run(args.length ? args : ["open"]));
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
