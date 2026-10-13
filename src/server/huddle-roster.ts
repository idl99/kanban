// Huddle rosters and @mentions: plain helpers shared by the daemon (huddle.ts) and the MCP server.
import { MAIN_PRESET } from "./huddle-presets";
import type { HuddleMode, HuddleWorkspace } from "./types";

export const DEFAULT_MAX_PARTICIPANTS = 8;
/** Set on a huddle agent's claude process: "<huddle id>/<handle>/<token>". The token proves who is calling. */
export const HUDDLE_AGENT_ENV = "CKANBAN_HUDDLE_AGENT";
/** The MCP server/CLI forwards HUDDLE_AGENT_ENV to the daemon in this header. */
export const HUDDLE_HEADER = "x-ckanban-huddle-agent";
/** Where a request comes from: "ui" (the board's web UI) or "mcp" (BoardClient: the MCP server and CLI). Recorded on posts. */
export const SOURCE_HEADER = "x-ckanban-source";
/** The host ticket's own session: the coordinator. */
export const MAIN_HANDLE = "main";
/** The user, posting from the board. */
export const USER_HANDLE = "you";
/** Handles no participant can take. */
export const RESERVED_HANDLES = new Set([MAIN_HANDLE, USER_HANDLE, "all", "system", "current"]);
/** Agents that may not edit tracked files run without these tools. */
export const NO_EDIT_TOOLS = "Edit,Write,NotebookEdit";
/** Where a huddle's summary goes, relative to the host ticket's outputs folder: one per huddle, so rounds don't overwrite each other. */
export const summaryFile = (hid: string) => `huddles/${hid}/summary.md`;
/** The single summary file older huddles wrote; still read for closed huddles that have no summary of their own. */
export const LEGACY_SUMMARY_FILE = "huddle-summary.md";
const MAX_COUNT = 8;

/** One line of a roster: `count` participants made from a preset (or a free-form role with its own prompt). */
export interface RosterEntry {
  /** Preset name (built-in or the board's, see huddle-presets.ts). */
  preset?: string;
  role?: string;
  count?: number;
  focus?: string;
  model?: string | null;
  mode?: HuddleMode;
  workspace?: HuddleWorkspace;
  lead?: boolean;
  /** May edit tracked files (only applies in its own worktree). Default: the preset's, else true for an own worktree. */
  canEdit?: boolean;
  /** Handle (or handle prefix when count > 1). Default: the preset or role name. */
  handle?: string;
  /** Extra instructions on top of the preset's. */
  prompt?: string;
}

const isText = (v: unknown): v is string => typeof v === "string" && !!v.trim();

/** Heading of the ticket section a Planning chat writes when the user wants a huddle (see reviewHuddleRequest). */
export const REVIEW_HUDDLE_HEADING = "## Review huddle";

/**
 * The huddle a ticket asks for: its `## Review huddle` section, written in Planning instead of a huddle that starts
 * before the work. The ticket's run starts it with start_huddle once the work is done (even with Auto huddles off).
 * template: a `Template: x` line; maxCostUsd: a `Budget: ~$40` line. Null when the ticket has no such section.
 */
export function reviewHuddleRequest(body: string): { text: string; template?: string; maxCostUsd?: number } | null {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s+review huddle\s*$/i.test(l.trim()));
  if (start < 0) return null;
  const level = lines[start].trim().match(/^#+/)![0].length;
  const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l.trim()) && l.trim().match(/^#+/)![0].length <= level);
  const text = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  // Only a line labelled "Template:" / "Budget:" (list markers and bold allowed), not the word inside the check text.
  const template = text.match(/^[\s>*-]*\**template\**\s*:\**\s*`?([a-z0-9][\w-]*)`?/im)?.[1];
  const budget = Number(text.match(/^[\s>*-]*\**budget\b[^:\n]*:\**[^$\n]*\$\s*(\d[\d,]*(?:\.\d+)?)/im)?.[1]?.replace(/,/g, ""));
  return { text, ...(template ? { template } : {}), ...(budget > 0 ? { maxCostUsd: budget } : {}) };
}

export function handleBase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "agent";
}

/**
 * What's wrong with one roster entry, or null. `presets`: the board's preset names (built-ins included);
 * without it only the shape is checked (the daemon checks the name).
 */
export function rosterEntryError(e: any, at = "", presets?: string[]): string | null {
  if (!e || typeof e !== "object") return `${at}each entry must be an object`;
  if (e.preset !== undefined && !isText(e.preset)) return `${at}preset must be a preset name`;
  if (isText(e.preset) && e.preset.trim() === MAIN_PRESET) return `${at}"${MAIN_PRESET}" is the coordinator's preset (the host ticket's session joins as @main by itself)`;
  if (isText(e.preset) && presets && !presets.includes(e.preset.trim())) {
    return `${at}unknown preset "${e.preset}" (presets: ${presets.filter((n) => n !== MAIN_PRESET).join(", ")}; or give a role and a prompt instead)`;
  }
  if (e.preset === undefined && !isText(e.role)) return `${at}give a preset or a role`;
  if (e.role !== undefined && !isText(e.role)) return `${at}role must be text`;
  if (e.count !== undefined && (!Number.isInteger(e.count) || e.count < 1 || e.count > MAX_COUNT)) return `${at}count must be a whole number from 1 to ${MAX_COUNT}`;
  if (e.mode !== undefined && e.mode !== "tagged" && e.mode !== "monitor") return `${at}mode must be tagged or monitor`;
  if (e.workspace !== undefined && e.workspace !== "shared" && e.workspace !== "own") return `${at}workspace must be shared or own`;
  for (const k of ["focus", "model", "handle", "prompt"]) {
    if (e[k] !== undefined && e[k] !== null && typeof e[k] !== "string") return `${at}${k} must be text`;
  }
  for (const k of ["lead", "canEdit"]) {
    if (e[k] !== undefined && typeof e[k] !== "boolean") return `${at}${k} must be true or false`;
  }
  if (isText(e.handle) && RESERVED_HANDLES.has(handleBase(e.handle))) return `${at}handle "${e.handle}" is reserved`;
  return null;
}

/** What's wrong with a roster (propose_huddle, starting a huddle), or null. */
export function rosterError(roster: unknown, max = DEFAULT_MAX_PARTICIPANTS, presets?: string[]): string | null {
  if (!Array.isArray(roster) || !roster.length) return "roster must be a non-empty list";
  for (const [i, e] of roster.entries()) {
    const err = rosterEntryError(e, `entry ${i + 1}: `, presets);
    if (err) return err;
  }
  // The coordinator (@main) counts too.
  const total = 1 + roster.reduce((n: number, e: any) => n + (e.count ?? 1), 0);
  if (total > max) return `that is ${total} participants with @main, over the limit of ${max}`;
  return null;
}

/** Most a budget Claude proposes for a huddle (propose_huddle) may be; same cap as start_huddle. */
export const PROPOSED_MAX_COST_USD = 100;

/** propose_huddle's maxCostUsd, capped: undefined when not given, null when it isn't a positive amount. */
export function proposedBudget(v: unknown): number | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return Math.min(v, PROPOSED_MAX_COST_USD);
}

/** Text where a @handle is quoted rather than addressed: code spans and blocks, block quotes and "quoted" text. */
const QUOTED_RE = /```[\s\S]*?(?:```|(?![\s\S]))|`[^`\n]*`|^[ \t]*>.*$|"[^"\n]*"|\u201c[^\u201d\n]*\u201d/gm;

/**
 * @handles in a message, lowercased; "all" for @all. An email address or path is not a mention, and neither is a
 * handle inside code or quotes (someone quoting a message doesn't wake the people it tags).
 */
export function parseMentions(text: string): string[] {
  const out = new Set<string>();
  const plain = text.replace(QUOTED_RE, " ");
  for (const m of plain.matchAll(/(^|[^\w@./-])@([a-z0-9][a-z0-9_-]*)/gi)) out.add(m[2].toLowerCase().replace(/[-_]+$/, ""));
  return [...out];
}

/**
 * One message as a line of a digest or huddle_read. The text can't pass for another entry: lines after the first are
 * indented, and a line starting like an entry ("[#12]", "(system)") is escaped.
 */
export function huddleLine(m: { seq: number; from: string; text: string; kind: string }): string {
  const text = m.text
    // Any line break a reader might honour (\r, U+2028/2029), so none can start a fake entry.
    .split(/\r\n|\r|\n|\u2028|\u2029/)
    .map((l, i) => (i ? "    " : "") + l.replace(/^(\s*)(\[#\d+\]|\(system\))/i, "$1\\$2"))
    .join("\n");
  return m.kind === "system" ? `[#${m.seq}] (system) ${text}` : `[#${m.seq}] @${m.from}${m.kind === "finding" ? " (finding)" : ""}: ${text}`;
}
