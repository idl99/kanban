// `ckanban profiles`, `ckanban ticket ...` and `ckanban mcp ...`: the board from a terminal or another agent.
import { readFileSync } from "node:fs";
import {
  assertCanChange, BoardClient, bugReportText, ClientError, parseMode, parseStatus, profileList, resolveProfile, runProfile,
  ticketLine, ticketText, type TicketPatch,
} from "./client";
import { AGENT_IDS, AgentRegistry, type AgentId } from "./server/agents";
import { normalizeTags } from "./server/tags";

export const TICKET_USAGE = `  ckanban profiles     List boards (profiles) and their folders
  ckanban ticket list [--status <s>]
  ckanban ticket show <id>
  ckanban ticket create --title <t> [--body <md> | --body-file <f>] [--status <s>] [--mode interview|auto] [--needs <r1,r2>] [--tags <t1,t2>]
  ckanban ticket update <id> [--title <t>] [--body <md> | --body-file <f>] [--status <s>] [--mode <m>] [--needs <r1,r2>] [--tags <t1,t2>]
  ckanban ticket move <id> <status>
  ckanban ticket chat <id> <message>
  ckanban ticket comment <id> <text>
  ckanban ticket stop <id>
  ckanban ticket delete <id>
  ckanban ticket report-bug [<id>] --title <t> [--body <md> | --body-file <f>] [--no-logs]
                       File a ckanban bug as a GitHub issue (with <id>: attach that
                       ticket's details and last run log). Needs gh, else prints a link.
                       Ticket commands act on the board whose folder contains the current
                       directory; --profile <slug> picks another. --json prints raw JSON.
                       --body - / --body-file - read the description from stdin.
  ckanban mcp          Run the board's MCP server on stdio (for Claude Code, Codex, ...)
  ckanban mcp install [--claude] [--codex]
                       Register the MCP server with Claude Code and/or Codex (default: both)
  ckanban mcp uninstall [--claude] [--codex]
  ckanban mcp status   Show where the MCP server is registered`;

const BOOLEAN_FLAGS = new Set(["json", "claude", "codex", "no-logs"]);

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

/** `--name value`, `--name=value` and boolean flags; everything else is positional. `--` ends flags. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--") || a.length === 2) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq > 0 ? eq : undefined);
    if (eq > 0) flags[name] = a.slice(eq + 1);
    else if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
    else {
      if (i + 1 >= argv.length) throw new ClientError(`--${name} needs a value`);
      flags[name] = argv[++i];
    }
  }
  return { positional, flags };
}

/** --needs emulator,gpu → ["emulator", "gpu"]; --needs "" clears the list. */
function needsFlag(p: ParsedArgs): string[] | undefined {
  const v = flagStr(p, "needs");
  if (v === undefined) return undefined;
  return v.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

/** --tags post,xhs → ["post", "xhs"]; --tags "" clears the list. */
function tagsFlag(p: ParsedArgs): string[] | undefined {
  const v = flagStr(p, "tags");
  return v === undefined ? undefined : normalizeTags(v.split(","));
}

function flagStr(p: ParsedArgs, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === "string" ? v : undefined;
}

function readStdin(): string {
  return readFileSync(0, "utf8");
}

/** --body / --body-file (either may be "-" for stdin). */
export function bodyFrom(p: ParsedArgs, stdin: () => string = readStdin): string | undefined {
  const body = flagStr(p, "body");
  const file = flagStr(p, "body-file");
  if (body !== undefined && file !== undefined) throw new ClientError("use --body or --body-file, not both");
  if (body !== undefined) return body === "-" ? stdin() : body;
  if (file !== undefined) return file === "-" ? stdin() : readFileSync(file, "utf8");
  return undefined;
}

export interface CliIo {
  out: (s: string) => void;
  client: BoardClient;
  cwd: string;
  env: Record<string, string | undefined>;
  stdin?: () => string;
}

const defaultIo = (): CliIo => ({ out: (s) => console.log(s), client: new BoardClient(), cwd: process.cwd(), env: process.env });

function need(v: string | undefined, usage: string): string {
  if (!v) throw new ClientError(`usage: ckanban ${usage}`);
  return v;
}

export async function profilesCommand(argv: string[], io: CliIo = defaultIo()): Promise<void> {
  const p = parseArgs(argv);
  const ps = await io.client.listProfiles();
  io.out(p.flags.json ? JSON.stringify(ps, null, 2) : profileList(ps));
}

export async function ticketCommand(argv: string[], io: CliIo = defaultIo()): Promise<void> {
  const p = parseArgs(argv);
  const [action, id, ...rest] = p.positional;
  const json = !!p.flags.json;
  const print = (data: unknown, text: string) => io.out(json ? JSON.stringify(data, null, 2) : text);
  const known = ["list", "show", "create", "update", "move", "chat", "comment", "stop", "delete", "report-bug"];
  if (!action || !known.includes(action)) throw new ClientError(`usage:\n${TICKET_USAGE}`);
  // Filing a bug doesn't touch the board (and needs no board without a ticket id), so runs may do it.
  if (action === "report-bug") return reportBug(p, id, io);
  if (!["list", "show"].includes(action)) assertCanChange(io.env);
  const slug = resolveProfile(await io.client.listProfiles(), {
    explicit: flagStr(p, "profile") ?? runProfile(io.env), cwd: io.cwd,
  }).slug;
  const c = io.client;

  switch (action) {
    case "list": {
      let ts = await c.listTickets(slug);
      const status = flagStr(p, "status");
      if (status) {
        const s = parseStatus(status);
        ts = ts.filter((t) => t.status === s);
      }
      return print(ts, ts.length ? ts.map(ticketLine).join("\n") : `No tickets on ${slug}${status ? ` in ${status}` : ""}.`);
    }
    case "show": {
      const tid = need(id, "ticket show <id>");
      const [t, comments] = await Promise.all([c.getTicket(slug, tid), c.listComments(slug, tid)]);
      return print({ ...t, comments }, ticketText(t, comments));
    }
    case "create": {
      // `ticket create "Title"` works too.
      const title = (flagStr(p, "title") ?? [id, ...rest].filter(Boolean).join(" ")).trim();
      if (!title) throw new ClientError("usage: ckanban ticket create --title <t> [--body <md>]");
      const status = flagStr(p, "status");
      const mode = flagStr(p, "mode");
      const t = await c.createTicket(slug, {
        title,
        body: bodyFrom(p, io.stdin) ?? "",
        status: status ? parseStatus(status) : "backlog",
        mode: mode ? parseMode(mode) : "interview",
        ...(needsFlag(p)?.length ? { needs: needsFlag(p) } : {}),
        ...(tagsFlag(p)?.length ? { tags: tagsFlag(p) } : {}),
      });
      return print(t, `Created ${t.id} on ${slug} in ${t.status} (${t.mode} mode): ${t.title}`);
    }
    case "update":
    case "move": {
      const tid = need(id, action === "move" ? "ticket move <id> <status>" : "ticket update <id> [--title ...]");
      const patch: TicketPatch = {};
      if (action === "move") patch.status = parseStatus(need(rest[0] ?? flagStr(p, "status"), "ticket move <id> <status>"));
      else {
        const title = flagStr(p, "title");
        if (title?.trim()) patch.title = title.trim();
        const body = bodyFrom(p, io.stdin);
        if (body !== undefined) patch.body = body;
        const status = flagStr(p, "status");
        if (status) patch.status = parseStatus(status);
        const mode = flagStr(p, "mode");
        if (mode) patch.mode = parseMode(mode);
        const needs = needsFlag(p);
        if (needs) patch.needs = needs;
        const tags = tagsFlag(p);
        if (tags) patch.tags = tags;
        if (!Object.keys(patch).length) throw new ClientError("nothing to change: pass --title, --body, --status, --mode, --needs or --tags");
      }
      const t = await c.updateTicket(slug, tid, patch);
      return print(t, `Updated ${ticketLine(t)}`);
    }
    case "chat": {
      const tid = need(id, "ticket chat <id> <message>");
      const t = await c.chat(slug, tid, need(rest.join(" ").trim() || flagStr(p, "message"), "ticket chat <id> <message>"));
      return print(t, `Sent to ${t.id}${t.running ? "; Claude is working on it." : "."}`);
    }
    case "comment": {
      const tid = need(id, "ticket comment <id> <text>");
      const cm = await c.comment(slug, tid, need(rest.join(" ").trim() || flagStr(p, "text"), "ticket comment <id> <text>"));
      return print(cm, `Commented on ${tid}.`);
    }
    case "stop": {
      const tid = need(id, "ticket stop <id>");
      const r = await c.stop(slug, tid);
      return print(r, r.stopped ? `Stopped the run on ${tid}.` : `${tid} had no run to stop.`);
    }
    case "delete": {
      const tid = need(id, "ticket delete <id>");
      await c.deleteTicket(slug, tid);
      return print({ deleted: tid }, `Deleted ${tid}.`);
    }
  }
}

async function reportBug(p: ParsedArgs, id: string | undefined, io: CliIo): Promise<void> {
  const usage = "ticket report-bug [<id>] --title <t> [--body <md> | --body-file <f>] [--no-logs]";
  const title = need(flagStr(p, "title")?.trim(), usage);
  const slug = id
    ? resolveProfile(await io.client.listProfiles(), { explicit: flagStr(p, "profile") ?? runProfile(io.env), cwd: io.cwd }).slug
    : undefined;
  const r = await io.client.reportBug({
    title,
    description: bodyFrom(p, io.stdin) ?? "",
    profile: slug,
    ticketId: id,
    include: p.flags["no-logs"] ? ["env", "ticket"] : ["env", "ticket", "log"],
    source: runProfile(io.env) ? "ai" : "cli",
  });
  io.out(p.flags.json ? JSON.stringify(r, null, 2) : bugReportText(r));
}

/** --claude / --codex, or both when neither is given. */
export function agentsFrom(p: ParsedArgs): AgentId[] {
  const picked = AGENT_IDS.filter((a) => p.flags[a]);
  return picked.length ? picked : AGENT_IDS;
}

export async function mcpCommand(argv: string[], out: (s: string) => void = console.log, registry = new AgentRegistry()): Promise<void> {
  const p = parseArgs(argv);
  const [action] = p.positional;
  if (action === "install" || action === "uninstall") {
    for (const id of agentsFrom(p)) {
      const label = id === "claude" ? "Claude Code" : "Codex";
      if (action === "install") {
        await registry.install(id);
        out(`${label}: registered "ckanban" → ${registry.serverArgv.join(" ")}`);
      } else {
        await registry.uninstall(id);
        out(`${label}: removed "ckanban"`);
      }
    }
    return;
  }
  if (action === "status") {
    for (const s of await registry.status()) {
      const state = !s.installed ? "not registered" : s.current ? "registered" : `registered with another command (${s.command})`;
      out(`${s.label}: ${state}${s.available ? "" : " (CLI not found)"}  [${s.configPath}]`);
    }
    return;
  }
  throw new ClientError(`usage:\n${TICKET_USAGE.split("\n").filter((l) => /ckanban mcp|^\s{20,}Register/.test(l)).join("\n")}`);
}
