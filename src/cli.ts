#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sha256, sumFor } from "./checksum";
import { boardPort, ClientError } from "./client";
import { serveStdio } from "./mcp-server";
import { runArtifactJob } from "./server/artifact";
import { LABEL, PLIST_PATH, plistXml } from "./server/launchd";
import { RESTART_MAX_WAIT_MS } from "./server/board";
import { startDaemon } from "./server/main";
import { AgentError } from "./server/agents";
import { defaultRoot, Store } from "./server/store";
import { qrTerminal, RemoteAccess, RemoteError, remoteListenPort, type RemoteStatus } from "./server/remote";
import { latestRelease } from "./server/update";
import { IS_BINARY, VERSION } from "./server/version";
import { mcpCommand, profilesCommand, ticketCommand, TICKET_USAGE } from "./ticket-cli";

const USAGE = `ckanban — kanban board for Claude Code

Usage:
  ckanban dev          Run the server in the foreground
  ckanban start        Same as dev (used by launchd)
  ckanban install      Install and start the launchd background daemon (macOS)
  ckanban restart      Restart the daemon once active runs finish (after pulling or building changes)
                       --now: restart at once (cut-off replies resume after the restart)
  ckanban uninstall    Stop and remove the launchd daemon
  ckanban open         Open the board in your browser
  ckanban update       Update to the latest release and restart the daemon
  ckanban remote on|off|status
                       Phone access over Tailscale (tailnet only, your login only)
  ckanban artifact publish <file> [--url <artifact url>] [--title <title>]
                       Publish a page to claude.ai (works from headless board runs)
  ckanban artifact read <url> [--out <file>]
                       Save an artifact's page source to a local file
${TICKET_USAGE}
  ckanban --version    Print the version
`;

async function sh(cmd: string[]): Promise<number> {
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  return p.exited;
}

function boardUrl(): string {
  return `http://localhost:${boardPort()}`;
}

/** Board commands print the error alone (no stack) and exit 1. */
async function board(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof ClientError || e instanceof AgentError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}

async function install() {
  const root = defaultRoot();
  mkdirSync(root, { recursive: true });
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  // Common tool locations first-class, so the daemon finds claude/git/gh even from a minimal shell.
  const extra = [join(homedir(), ".local/bin"), join(homedir(), ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const pathDirs = [...new Set([...(process.env.PATH ?? "").split(":").filter(Boolean), ...extra])];
  writeFileSync(PLIST_PATH, plistXml({
    programArgs: IS_BINARY ? [process.execPath] : [process.execPath, join(import.meta.dir, "cli.ts")],
    path: pathDirs.join(":"),
    logFile: join(root, "daemon.log"),
    home: homedir(),
  }));
  const domain = `gui/${process.getuid!()}`;
  await quiet(["launchctl", "bootout", `${domain}/${LABEL}`]);
  // bootout returns before the old job is gone; bootstrap fails until it is.
  for (let i = 0; i < 50 && (await quiet(["launchctl", "print", `${domain}/${LABEL}`])) === 0; i++) await Bun.sleep(100);
  let code = 1;
  for (let i = 0; i < 5 && code !== 0; i++) {
    code = await quiet(["launchctl", "bootstrap", domain, PLIST_PATH]);
    if (code !== 0) await Bun.sleep(500);
  }
  if (code !== 0) {
    console.error("launchctl bootstrap failed");
    process.exit(code);
  }
  console.log(`Installed ${PLIST_PATH}\nBoard: ${boardUrl()}\nLogs: ${join(root, "daemon.log")}`);
}

async function quiet(cmd: string[]): Promise<number> {
  return Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).exited;
}

/**
 * Ask the daemon to restart once no run is active (so a reply or ticket mid-run isn't cut off).
 * Returns how many runs it waits for, or null when the daemon can't be asked (not up, or an older version).
 */
async function gracefulRestart(): Promise<number | null> {
  try {
    const res = await fetch(`${boardUrl()}/api/restart`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return Number(((await res.json()) as { running?: number }).running) || 0;
  } catch {
    return null;
  }
}

async function restart(now: boolean) {
  const target = `gui/${process.getuid!()}/${LABEL}`;
  if ((await quiet(["launchctl", "print", target])) !== 0) {
    console.error("daemon not installed; run: ckanban install");
    process.exit(1);
  }
  const waiting = now ? null : await gracefulRestart();
  if (waiting === null) {
    const code = await sh(["launchctl", "kickstart", "-k", target]);
    if (code !== 0) process.exit(code);
    console.log(`Restarted. Board: ${boardUrl()}`);
  } else if (waiting === 0) {
    console.log(`Restarting. Board: ${boardUrl()}`);
  } else {
    console.log(`Restart pending: waiting for ${waiting} active run${waiting === 1 ? "" : "s"} to finish (at most ${RESTART_MAX_WAIT_MS / 60_000} min).
New runs, chat replies and Planning interviews start after the restart. Use \`ckanban restart --now\` to restart at once.`);
  }
}

async function update() {
  if (!IS_BINARY) {
    console.log("Running from source: use `git pull && bun install && bun run build:web && ckanban restart`.");
    return;
  }
  const rel = await latestRelease();
  if (!rel) {
    console.error("Could not reach GitHub to check for updates.");
    process.exit(1);
  }
  if (rel.version === VERSION) {
    console.log(`Already on the latest version (v${VERSION}).`);
    return;
  }
  const asset = rel.assets.find((a) => a.name === `ckanban-darwin-${process.arch}`);
  if (!asset) {
    console.error(`No build for darwin-${process.arch} in release v${rel.version}.`);
    process.exit(1);
  }
  const sumsAsset = rel.assets.find((a) => a.name === "SHA256SUMS");
  if (!sumsAsset) {
    console.error(`Release v${rel.version} has no SHA256SUMS, so the download can't be verified. Not updated.`);
    process.exit(1);
  }
  console.log(`Updating v${VERSION} → v${rel.version}…`);
  const [res, sumsRes] = await Promise.all([fetch(asset.url), fetch(sumsAsset.url)]);
  if (!res.ok || !sumsRes.ok) {
    const bad = res.ok ? sumsRes : res;
    console.error(`Download failed: ${bad.status} ${bad.statusText}`);
    process.exit(1);
  }
  const bin = await res.arrayBuffer();
  const want = sumFor(await sumsRes.text(), asset.name);
  const got = sha256(bin);
  if (!want || want !== got) {
    console.error(want
      ? `Checksum mismatch for ${asset.name}: expected ${want}, got ${got}. The download may be corrupt or tampered with. Not updated.`
      : `SHA256SUMS has no entry for ${asset.name}. Not updated.`);
    process.exit(1);
  }
  const tmp = `${process.execPath}.new`;
  await Bun.write(tmp, bin);
  chmodSync(tmp, 0o755);
  renameSync(tmp, process.execPath);
  const running = (await quiet(["launchctl", "print", `gui/${process.getuid!()}/${LABEL}`])) === 0;
  const waiting = running ? await gracefulRestart() : null;
  if (running && waiting === null) await quiet(["launchctl", "kickstart", "-k", `gui/${process.getuid!()}/${LABEL}`]);
  console.log(`Updated to v${rel.version}.${!running ? "" : waiting ? ` Daemon restarts once ${waiting} active run${waiting === 1 ? "" : "s"} finish; then refresh the board.` : " Daemon restarted; refresh the board."}`);
}

async function uninstall() {
  await sh(["launchctl", "bootout", `gui/${process.getuid!()}/${LABEL}`]);
  rmSync(PLIST_PATH, { force: true });
  console.log("Uninstalled ckanban daemon");
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function artifact(args: string[]) {
  const [action, target] = args;
  const opts = { bin: process.env.CKANBAN_CLAUDE_BIN, model: process.env.CKANBAN_ARTIFACT_MODEL };
  if (action === "publish" && target) {
    const file = resolve(target);
    if (!existsSync(file)) {
      console.error(`no such file: ${file}`);
      process.exit(1);
    }
    const r = await runArtifactJob({ kind: "publish", file, url: flag(args, "--url"), title: flag(args, "--title") }, opts);
    if (!r.ok) {
      console.error(`artifact publish failed: ${r.error}`);
      process.exit(1);
    }
    // Same wording as the Artifact tool, so the board lists the page on the ticket.
    if (r.kind === "publish") console.log(r.text);
    return;
  }
  if (action === "read" && target) {
    const r = await runArtifactJob({ kind: "read", url: target }, opts);
    if (!r.ok) {
      console.error(`artifact read failed: ${r.error}`);
      process.exit(1);
    }
    if (r.kind !== "read") return;
    const out = resolve(flag(args, "--out") ?? join(tmpdir(), `artifact-${target.split("/").pop()}.html`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, r.html);
    console.log(`Saved ${target} to ${out}`);
    return;
  }
  console.error("usage: ckanban artifact publish <file> [--url <artifact url>] [--title <title>]\n       ckanban artifact read <url> [--out <file>]");
  process.exit(1);
}

/** `ckanban remote on|off|status`: writes remote.json, which the daemon picks up on its next request. */
async function remoteCommand(action: string | undefined) {
  const access = new RemoteAccess(defaultRoot(), () => remoteListenPort(boardPort(), new Store(defaultRoot()).config().remotePort));
  const show = (st: RemoteStatus) => {
    if (!st.enabled) {
      console.log("Phone access is off.");
      if (st.warning) console.error(`Warning: ${st.warning}`);
      return;
    }
    console.log(`Phone access is on: ${st.url}`);
    console.log(`Only ${st.allowedLogin} can open it, from devices on your tailnet (never public).`);
    console.log("");
    console.log(qrTerminal(st.url!));
  };
  try {
    if (action === "on") show(await access.on());
    else if (action === "off") show(await access.off());
    else if (action === "status" || action === undefined) show(access.status());
    else {
      console.error("usage: ckanban remote on|off|status");
      process.exit(1);
    }
  } catch (e) {
    if (!(e instanceof RemoteError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}

const cmd = process.argv[2];
switch (cmd) {
  case "dev":
  case "start":
    await startDaemon();
    break;
  case "install":
    await install();
    break;
  case "restart":
    await restart(process.argv.includes("--now"));
    break;
  case "uninstall":
    await uninstall();
    break;
  case "open":
    await sh(["open", boardUrl()]);
    break;
  case "update":
    await update();
    break;
  case "remote":
    await remoteCommand(process.argv[3]);
    break;
  case "artifact":
    await artifact(process.argv.slice(3));
    break;
  case "profiles":
    await board(() => profilesCommand(process.argv.slice(3)));
    break;
  case "ticket":
  case "tickets":
    await board(() => ticketCommand(process.argv.slice(3)));
    break;
  case "mcp":
    if (process.argv.length === 3) await serveStdio();
    else await board(() => mcpCommand(process.argv.slice(3)));
    break;
  case "--version":
  case "-v":
  case "version":
    console.log(VERSION);
    break;
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
