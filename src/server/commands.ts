import { readdirSync, readFileSync, statSync } from "node:fs";
import { atomicWrite } from "./store";
import { homedir } from "node:os";
import { join, relative } from "node:path";

/**
 * Slash commands a ticket chat can run, like typing `/name` in Claude Code: skills, custom commands
 * and a few built-ins. The board lists them for the composer's `/` picker and decides how to send a
 * message that starts with one (see slashMessage).
 */
export type CommandKind = "skill" | "command" | "builtin";
/** claude: bundled with Claude Code (only known from a run's init event); board: the board runs it itself. */
export type CommandSource = "user" | "project" | "plugin" | "claude" | "board";

export interface SlashCommand {
  name: string;
  kind: CommandKind;
  source: CommandSource;
  description: string;
  /** Runs inside Claude Code without a model turn (no replay of the message, no reply from Claude). */
  local?: boolean;
  /** `user-invocable: false`: only Claude may use it, so it isn't offered (kept while listing so its name stays taken). */
  hidden?: boolean;
}

/**
 * Built-ins offered in the picker. compact/context run natively in `claude -p`. model is handled by the
 * board: Claude Code's own /model only lasts for one process, while every board message is a new one.
 */
export const BUILTINS: SlashCommand[] = [
  { name: "compact", kind: "builtin", source: "claude", local: true, description: "Summarise the conversation to free up context" },
  { name: "context", kind: "builtin", source: "claude", local: true, description: "Show how much context the conversation uses" },
  { name: "model", kind: "builtin", source: "board", description: "Switch the model for this ticket's next runs (e.g. /model sonnet)" },
  { name: "effort", kind: "builtin", source: "board", description: "Set how hard Claude thinks on this ticket's next runs (e.g. /effort high)" },
];

export const BOARD_COMMANDS = new Set(BUILTINS.filter((c) => c.source === "board").map((c) => c.name));

/**
 * Built-ins that would switch or end Claude Code's session behind the board's back (the board tracks one
 * session per ticket): refused instead of sent. A fresh conversation is a new ticket.
 */
export const REFUSED_COMMANDS = new Set(["clear", "resume", "exit", "quit"]);

/**
 * Claude Code built-ins that only make sense in its terminal UI. Typed in a terminal session they are stored
 * in the transcript, but the ticket chat doesn't show them (compact, context and model it does: the chat runs those).
 */
export const TERMINAL_COMMANDS = new Set([
  "add-dir", "agents", "auto-mode-setup", "autocompact", "bashes", "bug", "clear", "color", "config", "cost", "doctor",
  "effort", "exit", "export", "fast", "feedback", "focus", "heapdump", "help", "hooks", "ide", "import", "init", "insights",
  "install-github-app", "keybindings", "login", "logout", "mcp", "memory", "migrate-installer", "output-style", "permissions",
  "plugin", "plugins", "privacy-settings", "quit", "recap", "release-notes", "reload-plugins", "reload-skills", "rename",
  "resume", "rewind", "sandbox", "status", "statusline", "tasks", "terminal-setup", "theme", "todos", "upgrade", "usage",
  "usage-credits", "extra-usage", "vim",
]);

/** Model aliases `claude --model` takes; full ids (claude-…) work too. */
const MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku", "opusplan"];

/** A model name `/model` accepts, or null. `[1m]` (1M context) may follow an alias or id. */
export function validModel(name: string): boolean {
  const base = name.toLowerCase().replace(/\[1m\]$/, "");
  return MODEL_ALIASES.includes(base) || /^claude-[a-z0-9][a-z0-9.-]*$/.test(base);
}

/** Reasoning effort levels `claude --effort` takes. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function validEffort(name: string): boolean {
  return (EFFORTS as readonly string[]).includes(name);
}

export const EFFORT_HELP = `${EFFORTS.join(", ")}, or default`;

export const MODEL_HELP = `${MODEL_ALIASES.join(", ")}, a full model id (claude-…), or default`;

interface Dirs {
  configDir?: string;
}

function configDirOf(d: Dirs): string {
  return d.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** `description` (and `name`) from a markdown file's YAML frontmatter; the first text line when there is none. */
export function frontmatter(text: string): { name?: string; description: string; userInvocable?: boolean } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const out: { name?: string; description: string; userInvocable?: boolean } = { description: "" };
  if (m) {
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const flag = /^user-invocable:\s*["']?(true|false)["']?\s*$/i.exec(lines[i]);
      if (flag) out.userInvocable = flag[1].toLowerCase() === "true";
      const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
      if (!kv) continue;
      let v = kv[2].trim();
      // Folded/literal block (description: > or |): the indented lines that follow.
      if (/^[>|][-+]?$/.test(v)) {
        const block: string[] = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
        v = block.join(" ");
      }
      v = v.replace(/^(["'])([\s\S]*)\1$/, "$2");
      if (kv[1] === "name") out.name = v;
      else out.description = v;
    }
  }
  if (!out.description) {
    const body = m ? text.slice(m[0].length) : text;
    out.description = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  }
  out.description = out.description.replace(/\s+/g, " ").trim();
  return out;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `<dir>/<name>/SKILL.md` skills. Claude Code names them after the folder, whatever the frontmatter's name says. */
function scanSkills(dir: string, source: CommandSource, prefix = ""): SlashCommand[] {
  if (!isDir(dir)) return [];
  const out: SlashCommand[] = [];
  for (const d of readdirSync(dir).sort()) {
    const text = readText(join(dir, d, "SKILL.md"));
    if (text === null) continue;
    const fm = frontmatter(text);
    out.push({ name: prefix + d, kind: "skill", source, description: fm.description, ...(fm.userInvocable === false ? { hidden: true } : {}) });
  }
  return out;
}

/** `<dir>/**\/*.md` custom commands; subfolders become `folder:name`, as in Claude Code. */
function scanCommands(dir: string, source: CommandSource, prefix = ""): SlashCommand[] {
  if (!isDir(dir)) return [];
  const out: SlashCommand[] = [];
  const walk = (d: string, depth: number) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (isDir(p)) {
        if (depth < 3) walk(p, depth + 1);
        continue;
      }
      if (!f.endsWith(".md")) continue;
      const text = readText(p);
      if (text === null) continue;
      const name = relative(dir, p).slice(0, -3).split(/[\\/]/).join(":");
      const fm = frontmatter(text);
      out.push({ name: prefix + name, kind: "command", source, description: fm.description, ...(fm.userInvocable === false ? { hidden: true } : {}) });
    }
  };
  walk(dir, 0);
  return out;
}

/** Install folders of the enabled plugins that apply to `projects` (user-wide or installed for one of them). */
function pluginDirs(configDir: string, projects: string[]): { name: string; dir: string }[] {
  const enabled: Record<string, unknown> = { ...readJson(join(configDir, "settings.json"))?.enabledPlugins };
  for (const p of projects) {
    for (const f of ["settings.json", "settings.local.json"]) Object.assign(enabled, readJson(join(p, ".claude", f))?.enabledPlugins);
  }
  const installed = readJson(join(configDir, "plugins", "installed_plugins.json"))?.plugins ?? {};
  const out: { name: string; dir: string }[] = [];
  for (const [key, entries] of Object.entries<any>(installed)) {
    if (enabled[key] !== true || !Array.isArray(entries)) continue;
    const entry = entries.find((e) => e?.scope === "user") ?? entries.find((e) => typeof e?.projectPath === "string" && projects.includes(e.projectPath));
    if (!entry || typeof entry.installPath !== "string") continue;
    const name = readJson(join(entry.installPath, ".claude-plugin", "plugin.json"))?.name ?? key.split("@")[0];
    out.push({ name: String(name), dir: entry.installPath });
  }
  return out;
}

/**
 * Skills bundled with Claude Code (code-review, simplify, …): the same in every folder, but only a run's init
 * event names them. Kept for all tickets and saved (see useBundledFile), so the picker has them after a restart.
 */
let bundled: string[] | null = null;
let bundledFile: string | null = null;
/** The skills the last init event reported (per folder): an unchanged list needs no new scan of the disk. */
const lastInit = new Map<string, string>();

/** Where bundled skill names are saved (<store root>/claude-commands.json); the board sets it at start. */
export function useBundledFile(file: string | null): void {
  bundledFile = file;
  bundled = null;
  lastInit.clear();
  cache.clear();
}

function bundledSkills(): string[] {
  if (bundled) return bundled;
  const v = bundledFile ? readJson(bundledFile)?.bundledSkills : null;
  bundled = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return bundled;
}

/**
 * A run's init event: its skills that the folder scan doesn't know (and aren't a plugin's `name:skill`) are
 * Claude Code's own. Only names it also offers as slash commands count, so skills only Claude may use stay out.
 */
export function rememberInit(cwd: string, ev: any, opts: Dirs & { projects?: string[] } = {}): void {
  if (ev?.type !== "system" || ev.subtype !== "init") return;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const offered = new Set(strings(ev.slash_commands));
  const candidates = [...new Set(strings(ev.skills))].filter((n) => offered.has(n) && !n.includes(":") && !TERMINAL_COMMANDS.has(n)).sort();
  // Every run starts with an init event; most report what the last one did.
  const key = candidates.join("\n");
  if (lastInit.get(cwd) === key) return;
  lastInit.set(cwd, key);
  const known = new Set(scan(cwd, opts).map((c) => c.name));
  const names = candidates.filter((n) => !known.has(n));
  cache.clear();
  if (names.join("\n") === bundledSkills().join("\n")) return;
  bundled = names;
  if (!bundledFile) return;
  try {
    atomicWrite(bundledFile, JSON.stringify({ bundledSkills: names }, null, 2));
  } catch (e) {
    console.error("couldn't save bundled Claude Code skills", e);
  }
}

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; list: SlashCommand[] }>();

/** Built-ins, project, user and plugin skills and commands found on disk (hidden ones included). */
function scan(cwd: string, opts: Dirs & { projects?: string[] }): SlashCommand[] {
  const configDir = configDirOf(opts);
  const projects = [...new Set([cwd, ...(opts.projects ?? [])])];
  const byName = new Map<string, SlashCommand>();
  const add = (list: SlashCommand[]) => {
    for (const c of list) if (c.name && !byName.has(c.name)) byName.set(c.name, c);
  };
  add(BUILTINS);
  add(scanSkills(join(cwd, ".claude", "skills"), "project"));
  add(scanCommands(join(cwd, ".claude", "commands"), "project"));
  add(scanSkills(join(configDir, "skills"), "user"));
  add(scanCommands(join(configDir, "commands"), "user"));
  for (const p of pluginDirs(configDir, projects)) {
    add(scanSkills(join(p.dir, "skills"), "plugin", `${p.name}:`));
    add(scanCommands(join(p.dir, "commands"), "plugin", `${p.name}:`));
  }
  return [...byName.values()];
}

/**
 * Everything `/` can run in `cwd`: built-ins, then project, user and plugin skills and commands
 * (project wins over user on the same name), plus Claude Code's bundled skills. Skills only Claude may use are left out.
 * projects: folders whose project settings and plugins apply (the worktree and the board's main checkout).
 */
export function listCommands(cwd: string, opts: Dirs & { projects?: string[]; fresh?: boolean } = {}): SlashCommand[] {
  const hit = cache.get(cwd);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const found = scan(cwd, opts);
  const taken = new Set(found.map((c) => c.name));
  const extra: SlashCommand[] = bundledSkills().filter((n) => !taken.has(n)).map((name) => ({ name, kind: "skill", source: "claude", description: "" }));
  const list = [...found, ...extra].filter((c) => !c.hidden);
  cache.set(cwd, { at: Date.now(), list });
  return list;
}

/** `/name rest` at the start of a message: name and the arguments after it. Paths like `/Users/x` don't count. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z0-9][\w.:-]*)(?=\s|$)([\s\S]*)$/.exec(text.trim());
  return m ? { name: m[1], args: m[2].trim() } : null;
}

/** The command a chat message runs, or null when it is plain text (unknown `/word` included). */
export function slashMessage(text: string, commands: SlashCommand[]): { command: SlashCommand; args: string; text: string } | null {
  const p = parseSlash(text);
  if (!p) return null;
  const command = commands.find((c) => c.name === p.name);
  return command ? { command, args: p.args, text: p.args ? `/${p.name} ${p.args}` : `/${p.name}` } : null;
}

/**
 * Claude Code stores (and replays) a slash command as tags:
 * `<command-message>x</command-message><command-name>/x</command-name><command-args>a b</command-args>`.
 * Returns `/x a b`, or null for any other text.
 */
export function commandText(text: string): string | null {
  const name = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text)?.[1];
  if (!name || !text.trimStart().startsWith("<command-")) return null;
  const args = (/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "").trim();
  return args ? `/${name} ${args}` : `/${name}`;
}

/** Output of a local command (/compact, /context) as Claude Code stores it, without the tags and colour codes. */
export function localCommandOutput(text: string): string | null {
  const m = /^\s*<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/.exec(text);
  return m ? m[2].replace(/\x1b\[[0-9;]*m/g, "").trim() : null;
}
