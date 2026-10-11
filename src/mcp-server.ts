// `ckanban mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0) exposing the board as tools.
// Hand-rolled instead of @modelcontextprotocol/sdk: we only need initialize, tools/list and tools/call.
import {
  assertCanChange, BoardClient, bugReportText, ClientError, huddleCaller, parseMode, parseStatus, profileList, resolveProfile, RUN_ENV, runProfile,
  ticketLine, ticketText, type HuddlePage, type ScheduleHistoryInfo, type ScheduleInfo, type ScheduleInput, type TicketPatch,
} from "./client";
import { BUILTIN_PRESETS, MAIN_PRESET, presetLine, presetName } from "./server/huddle-presets";
import { HUDDLE_AGENT_ENV, huddleLine, rosterEntryError, rosterError } from "./server/huddle-roster";
import { BUILTIN_TEMPLATES, templateLine } from "./server/huddle-templates";
import { teammateProposal } from "./server/teammate-proposal";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactJob, type ArtifactOutcome, runArtifactJob } from "./server/artifact";
import { STATUSES } from "./server/types";
import { REPO, VERSION } from "./server/version";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const PROFILE = {
  type: "string",
  description: "Board (profile) slug. Omit to use the board whose folder contains the current working directory.",
};
const ID = { type: "string", description: "Ticket id, e.g. t_20261001_abcd (from list_tickets)." };
const STATUS = {
  type: "string",
  enum: STATUSES,
  description: "Column. backlog: idea, nothing runs. planning: Claude interviews the user in the board chat. " +
    "ready: queued, Claude starts working as soon as a slot is free. in_progress/review/done: usually set by the board.",
};
const SCHEDULE_ID = { type: "string", description: "Schedule id (from list_schedules)." };
const CRON = {
  type: "string",
  description: "5-field cron (minute hour day-of-month month day-of-week) in this computer's local time. " +
    "Examples: \"0 9 * * 1-5\" weekdays 09:00, \"0 3 * * *\" daily 03:00, \"0 9 * * 1\" Mondays 09:00, \"*/30 * * * *\" every 30 minutes, \"0 * * * *\" hourly.",
};
const SCHEDULE_FIELDS = {
  name: { type: "string", description: "Short name shown in the Schedules list, e.g. \"Nightly dependency audit\"." },
  title: { type: "string", description: "Title of each ticket it creates. {date} and {time} are filled in, e.g. \"Dependency audit {date}\"." },
  body: {
    type: "string",
    description: "The prompt each ticket gets, in markdown. It runs unattended with no access to this conversation, " +
      "so make it self-contained: goal, context (files, commands), steps, what done looks like.",
  },
  cron: CRON,
  mode: {
    type: "string", enum: ["auto", "interview"],
    description: "auto: Claude just does it (right for unattended runs). interview: each ticket waits for the user's answers first. Default: auto.",
  },
  enabled: { type: "boolean", description: "false pauses the schedule (no runs, no catch-up when resumed). Default: true." },
  skipIfRunning: { type: "boolean", description: "Skip a run while the previous ticket from this schedule is still queued or running. Default: true." },
};

const DEPENDS_ON = {
  type: "array", items: { type: "string" },
  description: "Sibling child tickets (ticket id or key) that must be done before a running plan starts this one. Replaces the list.",
};

function depList(args: any): string[] | undefined {
  if (args?.dependsOn === undefined) return undefined;
  if (!Array.isArray(args.dependsOn)) throw new ClientError("dependsOn must be a list of ticket ids or keys");
  return args.dependsOn.filter((d: unknown) => typeof d === "string" && d.trim()).map((d: string) => d.trim());
}

const NEEDS = {
  type: "array", items: { type: "string" },
  description:
    "Exclusive resources this ticket's runs use, e.g. [\"emulator\"]: tickets that need the same one never run at the same time " +
    "(on any board), in any order. Use it for a shared device instead of chaining dependsOn. Replaces the list; [] clears it.",
};

function needsList(args: any): string[] | undefined {
  if (args?.needs === undefined) return undefined;
  if (!Array.isArray(args.needs) || args.needs.some((n: unknown) => typeof n !== "string")) throw new ClientError("needs must be a list of resource names, e.g. [\"emulator\"]");
  return args.needs.map((n: string) => n.trim().toLowerCase()).filter(Boolean);
}

/** The ticket a board run belongs to ("<profile>/<ticket id>" in CKANBAN_TICKET), or null outside runs. */
function runTicketId(ctx: ToolContext): string | null {
  return ctx.env[RUN_ENV]?.split("/")[1] || null;
}

const MODE = {
  type: "string",
  enum: ["interview", "auto"],
  description: "interview: Claude asks the user clarifying questions before working. auto: Claude just does it.",
};

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** MCP tool hints; readOnlyHint lets Claude Code call it in plan mode (the planning chat). */
  annotations?: { readOnlyHint?: boolean };
  /** Changes the board: refused inside board runs, unless allowInRun. */
  changes: boolean;
  /**
   * Schedule edits only affect future fire times (the user can pause them), so board runs may make them,
   * including a scheduled run refining its own schedule. Every edit is credited to the run's ticket in the history.
   */
  allowInRun?: boolean;
  /** Inside a board run the daemon decides: only a running plan's planner may use it, on its own child tickets. */
  plannerScope?: boolean;
  run(args: any, ctx: ToolContext): Promise<string>;
}

export interface ToolContext {
  client: Pick<BoardClient,
    | "listProfiles" | "listTickets" | "getTicket" | "createTicket" | "updateTicket" | "deleteTicket" | "chat" | "stop" | "listComments"
    | "comment" | "reportBug" | "listSchedules" | "createSchedule" | "updateSchedule" | "deleteSchedule" | "runSchedule"
    | "scheduleHistory" | "cronPreview" | "adopt" | "planAction" | "huddleRead" | "huddlePost" | "huddleMode" | "huddleAdd" | "huddleFindings"
    | "huddleStatus" | "huddleCloseRequest" | "startAutoHuddle"
    | "listHuddlePresets" | "saveHuddlePreset" | "deleteHuddlePreset" | "listHuddleTemplates" | "huddleBrief" | "huddleProposeTeammate">;
  cwd: string;
  env: Record<string, string | undefined>;
  main?: (dir: string) => string | null;
  now?: () => number;
  /** Runs an artifact publish/read (tests pass a fake). Default: runArtifactJob. */
  artifact?: (job: ArtifactJob, timeoutMs: number) => Promise<ArtifactOutcome>;
}

/** How long an artifact job may take: 3 minutes, or less when MCP_TOOL_TIMEOUT would cut the call off sooner. */
export function artifactWaitMs(env: Record<string, string | undefined>): number {
  const wait = 180_000;
  const limit = Number(env.MCP_TOOL_TIMEOUT);
  if (!Number.isFinite(limit) || limit < 1000) return wait;
  return Math.max(1000, Math.min(wait, limit - 5_000));
}

/** File name for a published page: the artifact id when updating (so updates overwrite it), else the title. */
export function artifactFileName(url: string | undefined, title: string | undefined, now: number): string {
  const id = url?.match(/\/artifact\/([A-Za-z0-9-]+)/)?.[1];
  const slug = (id ?? title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || `artifact-${now}`}.html`;
}

function runArtifact(job: ArtifactJob, ctx: ToolContext): Promise<ArtifactOutcome> {
  const timeoutMs = artifactWaitMs(ctx.env);
  if (ctx.artifact) return ctx.artifact(job, timeoutMs);
  return runArtifactJob(job, { bin: ctx.env.CKANBAN_CLAUDE_BIN, model: ctx.env.CKANBAN_ARTIFACT_MODEL, timeoutMs });
}

const ARTIFACT_URL = { type: "string", description: "claude.ai artifact link, e.g. https://claude.ai/artifact/AbC123." };

// The board's stand-in for the Artifact tool, which headless runs don't get. readOnlyHint lets the planning
// chat (plan mode) use them: publishing only writes the page to the ticket's outputs folder, never the project.
const ARTIFACT_TOOLS: Tool[] = [
  {
    name: "read_artifact",
    description:
      "Read a claude.ai artifact and return its page source (HTML). Use it to look at an artifact, or before publish_artifact " +
      "with its url to update it: edit the returned HTML and publish the whole page. Takes a minute or two.",
    inputSchema: { type: "object", properties: { url: ARTIFACT_URL }, required: ["url"] },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const url = str(args, "url")!.trim();
      const r = await runArtifact({ kind: "read", url }, ctx);
      if (!r.ok) throw new ClientError(`artifact read failed: ${r.error}`);
      if (r.kind !== "read") throw new ClientError("artifact read failed: no page source");
      return r.html;
    },
  },
  {
    name: "publish_artifact",
    description:
      "Publish a complete HTML page as a claude.ai artifact and return its link. Pass url to update that artifact " +
      "(same link, new version): read_artifact it first and send the full edited page, not a diff. " +
      "The page is also saved in the ticket's outputs folder. Takes a minute or two.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "The full page source (a complete HTML document)." },
        url: { ...ARTIFACT_URL, description: "Artifact to update (keeps its link). Omit to publish a new page." },
        title: { type: "string", description: "Page title (optional)." },
      },
      required: ["html"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const html = str(args, "html")!;
      const url = str(args, "url", false)?.trim();
      const title = str(args, "title", false)?.trim();
      const dir = join(ctx.env.CKANBAN_OUTPUT_DIR || join(tmpdir(), "ckanban-artifacts"), "artifacts");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, artifactFileName(url, title, (ctx.now ?? Date.now)()));
      writeFileSync(file, html);
      const r = await runArtifact({ kind: "publish", file, url, title }, ctx);
      if (!r.ok) throw new ClientError(`artifact publish failed: ${r.error}`);
      if (r.kind !== "publish") throw new ClientError("artifact publish failed: no link came back");
      // Same wording as the Artifact tool, so the board lists the page on the ticket.
      return r.text;
    },
  },
];

async function slugFor(args: any, ctx: ToolContext): Promise<string> {
  const explicit = typeof args?.profile === "string" && args.profile.trim() ? args.profile : runProfile(ctx.env);
  return resolveProfile(await ctx.client.listProfiles(), { explicit, cwd: ctx.cwd, main: ctx.main }).slug;
}

function str(args: any, key: string, required = true): string | undefined {
  const v = args?.[key];
  if (typeof v === "string" && v.trim()) return v;
  if (required) throw new ClientError(`${key} is required`);
  return undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO time as local "2026-10-01 09:00" (schedules run in this computer's local time). */
export function localTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function scheduleLine(s: ScheduleInfo): string {
  const state = [s.enabled ? "active" : "paused"];
  if (s.active) state.push("running");
  const bits = [`${s.id}  [${state.join(", ")}]  ${s.name}: ${s.summary} (${s.cron})`];
  if (s.enabled && s.nextRunAt) bits.push(`next ${localTime(s.nextRunAt)}`);
  if (s.lastFiredAt) bits.push(`last ticket ${localTime(s.lastFiredAt)}`);
  if (s.lastError) bits.push(`last run failed to start: ${s.lastError}`);
  return bits.join("; ");
}

function scheduleText(s: ScheduleInfo): string {
  return [
    scheduleLine(s),
    `ticket title: ${s.title}`,
    `mode: ${s.mode}, skip while previous runs: ${s.skipIfRunning ? "yes" : "no"}`,
    "", s.body.trim() || "(no prompt)",
  ].join("\n");
}

function historyLine(e: ScheduleHistoryInfo): string {
  const t = e.ticket ? `${e.ticket.id} "${e.ticket.title}" [${e.ticket.running ? "running" : [e.ticket.status, e.ticket.outcome].filter(Boolean).join(", ")}]` : null;
  const at = localTime(e.at);
  if (e.kind === "fired") return `${at}  fired (${e.trigger}): ${t ?? `${e.ticketId} (deleted)`}`;
  if (e.kind === "skipped") return `${at}  skipped (${e.trigger}): previous ticket ${e.ticketId ?? ""} still queued or running`;
  if (e.kind === "error") return `${at}  could not create the ticket (${e.trigger}): ${e.message}`;
  const by = !e.by || e.by === "user" ? "the user" : `ticket ${e.by.ticketId}`;
  const fields = e.fields?.length ? ` ${e.fields.join(", ")}` : "";
  const prev = e.previous ? Object.entries(e.previous).map(([k, v]) => `\n    previous ${k}: ${String(v).replace(/\s+/g, " ").slice(0, 300)}`).join("") : "";
  return `${at}  ${e.action}${fields} by ${by}${prev}`;
}

function scheduleInput(args: any, partial: boolean): ScheduleInput {
  const out: ScheduleInput = {};
  for (const k of ["name", "title", "body", "cron"] as const) {
    if (typeof args?.[k] === "string") out[k] = args[k];
    else if (!partial && k !== "body") throw new ClientError(`${k} is required`);
  }
  if (args?.mode !== undefined) out.mode = parseMode(args.mode);
  for (const k of ["enabled", "skipIfRunning"] as const) {
    if (args?.[k] === undefined) continue;
    if (typeof args[k] !== "boolean") throw new ClientError(`${k} must be true or false`);
    out[k] = args[k];
  }
  return out;
}

const SCHEDULE_TOOLS: Tool[] = [
  {
    name: "list_schedules",
    description:
      "List a board's schedules (recurring tickets): id, active/paused, when it fires (plain English + cron), next run, last ticket, errors. " +
      "Check this before create_schedule to avoid duplicates.",
    inputSchema: { type: "object", properties: { profile: PROFILE } },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const ss = await ctx.client.listSchedules(slug);
      return ss.length ? `Schedules on board ${slug}:\n${ss.map(scheduleLine).join("\n")}` : `Board ${slug} has no schedules.`;
    },
  },
  {
    name: "create_schedule",
    description:
      "Create a schedule: at each cron time the board creates a ticket from it and Claude starts working on it right away, unattended. " +
      "Use it when the user wants something done regularly (nightly audit, weekly changelog, daily CI check). " +
      "Runs happen only while the ckanban daemon is running; one missed run is caught up when it starts. " +
      "Returns the schedule id and its next run times.",
    inputSchema: { type: "object", properties: { profile: PROFILE, ...SCHEDULE_FIELDS }, required: ["name", "title", "body", "cron"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const s = await ctx.client.createSchedule(slug, scheduleInput(args, false), ctx.env[RUN_ENV]);
      const p = await ctx.client.cronPreview(s.cron).catch(() => null);
      const next = p?.next.length ? `\nNext runs: ${p.next.map(localTime).join(", ")}` : "";
      return `Created schedule ${s.id} on board ${slug}: ${s.name}, ${s.summary} (${s.cron}), ${s.mode} mode.${next}\n` +
        "The user can see, pause or edit it in the board's Schedules dialog.";
    },
  },
  {
    name: "update_schedule",
    description:
      "Change a schedule: any of name, title, prompt (body), cron, mode, skipIfRunning; enabled false/true pauses/resumes it. " +
      "Only the fields you pass change. A run created by a schedule may update its own schedule (e.g. refine its prompt); " +
      "the old prompt is kept in the schedule's history.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: SCHEDULE_ID, ...SCHEDULE_FIELDS }, required: ["id"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const patch = scheduleInput(args, true);
      if (!Object.keys(patch).length) throw new ClientError("nothing to change: pass name, title, body, cron, mode, enabled or skipIfRunning");
      const s = await ctx.client.updateSchedule(slug, str(args, "id")!, patch, ctx.env[RUN_ENV]);
      return `Updated: ${scheduleLine(s)}`;
    },
  },
  {
    name: "delete_schedule",
    description: "Delete a schedule (tickets it already created stay). Only when the user asked; to stop it for a while, pause it with update_schedule enabled=false.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: SCHEDULE_ID }, required: ["id"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      await ctx.client.deleteSchedule(slug, id, ctx.env[RUN_ENV]);
      return `Deleted schedule ${id}.`;
    },
  },
  {
    name: "run_schedule",
    description: "Fire a schedule now: creates its ticket and starts it, without moving the next scheduled run. Not available inside board runs.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: SCHEDULE_ID }, required: ["id"] },
    // Starts a run immediately, so like create_ticket it stays off-limits to board runs.
    changes: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const { entry } = await ctx.client.runSchedule(slug, str(args, "id")!);
      if (entry.kind === "fired") return `Started: created ticket ${entry.ticketId}, Claude is working on it.`;
      if (entry.kind === "skipped") return `Skipped: the previous ticket ${entry.ticketId ?? ""} from this schedule is still queued or running.`;
      throw new ClientError(`could not create the ticket: ${entry.message}`);
    },
  },
  {
    name: "schedule_history",
    description: "Show a schedule's settings and history, newest first: tickets it created with their status, skips, errors, and edits (who changed what, with the previous prompt).",
    inputSchema: {
      type: "object",
      properties: { profile: PROFILE, id: SCHEDULE_ID, limit: { type: "number", description: "Entries to show. Default: 20." } },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      const [all, h] = await Promise.all([ctx.client.listSchedules(slug), ctx.client.scheduleHistory(slug, id)]);
      const s = all.find((x) => x.id === id);
      const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20));
      const lines = h.slice(0, limit).map(historyLine);
      return `${s ? scheduleText(s) : `Schedule ${id}`}\n\nHistory:\n${lines.length ? lines.join("\n") : "(not run yet)"}`;
    },
  },
];

// --- Planning chat cards ----------------------------------------------------------------------
// The board's planning chat renders these calls (from the session transcript) as a form or cards.
// The tools only check the input, so a bad call comes back to Claude as an error to fix.

const MAX_TITLE = 80;
const SHOWN = "Shown to the user as a card. End your turn and wait for their reply.";

const isText = (v: unknown): v is string => typeof v === "string" && !!v.trim();

function titleError(title: unknown, where: string): string | null {
  if (!isText(title)) return `${where}title is required`;
  if (title.trim().length >= MAX_TITLE) return `${where}title must be under ${MAX_TITLE} characters (it has ${title.trim().length})`;
  return null;
}

/** Checks ask_questions input; returns what's wrong, or null when it's fine. */
export function questionsError(args: any): string | null {
  const qs = args?.questions;
  if (!Array.isArray(qs) || qs.length < 1) return "questions must be a non-empty list";
  for (const [i, q] of qs.entries()) {
    const at = `question ${i + 1}: `;
    if (!isText(q?.question)) return `${at}question text is required`;
    const opts = q.options;
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > 8) return `${at}give 2-8 options`;
    if (opts.some((o: any) => !isText(o?.label))) return `${at}every option needs a label`;
    const rec = opts.filter((o: any) => o?.recommended === true).length;
    if (rec !== 1) return `${at}mark exactly one option recommended (found ${rec})`;
    if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean") return `${at}multiSelect must be true or false`;
  }
  return null;
}

/** Checks propose_ticket input; returns what's wrong, or null when it's fine. */
export function proposalError(args: any): string | null {
  return titleError(args?.title, "") ?? (isText(args?.description) ? null : "description is required");
}

/** Checks propose_tickets input; returns what's wrong, or null when it's fine. */
export function ticketsError(args: any): string | null {
  const ts = args?.tickets;
  if (!Array.isArray(ts) || !ts.length) return "tickets must be a non-empty list";
  const keys = new Set<string>();
  for (const [i, t] of ts.entries()) {
    const at = `ticket ${i + 1}: `;
    if (!isText(t?.key)) return `${at}key is required`;
    if (keys.has(t.key.trim())) return `${at}key "${t.key.trim()}" is used twice; keys must be unique`;
    keys.add(t.key.trim());
    const e = titleError(t.title, at) ?? (isText(t.description) ? null : `${at}description is required`);
    if (e) return e;
  }
  for (const [i, t] of ts.entries()) {
    if (t.dependsOn === undefined) continue;
    if (!Array.isArray(t.dependsOn) || t.dependsOn.some((d: unknown) => typeof d !== "string")) return `ticket ${i + 1}: dependsOn must be a list of keys`;
    const bad = t.dependsOn.find((d: string) => !keys.has(d.trim()) || d.trim() === t.key.trim());
    if (bad !== undefined) return `ticket ${i + 1}: dependsOn "${bad}" is not the key of another ticket in this list (keys: ${[...keys].join(", ")})`;
  }
  for (const [i, t] of ts.entries()) {
    if (t.needs === undefined) continue;
    if (!Array.isArray(t.needs) || t.needs.some((n: unknown) => typeof n !== "string")) return `ticket ${i + 1}: needs must be a list of resource names, e.g. ["emulator"]`;
  }
  return null;
}

const TITLE = { type: "string", description: "Short, specific title (under 80 characters)." };

/** Teammate (huddle role preset) fields, shared by save_huddle_preset and propose_teammate. */
const PRESET_FIELDS = {
  name: { type: "string", description: "Preset name, also the default @handle, e.g. \"a11y\" (lowercase letters, digits, dashes)." },
  prompt: { type: "string", description: "What this role does in a huddle: its job, what to look at, how to report." },
  role: { type: "string", description: "Label shown in the huddle, e.g. \"Accessibility tester\". Default: from the name." },
  model: { type: "string", description: "Default model, e.g. sonnet. Empty: the board's." },
  mode: { type: "string", enum: ["tagged", "monitor"], description: "tagged: sleeps until @mentioned. monitor: gets every new message. Default tagged; monitor for a lead." },
  lead: { type: "boolean", description: "May add participants and manage the findings list. Default false." },
  canEdit: { type: "boolean", description: "May edit tracked files (only in its own worktree). Default: true for workspace own." },
  workspace: { type: "string", enum: ["shared", "own"], description: "shared: read-only in the host ticket's worktree. own: its own worktree and branch. Default shared." },
};

const PROPOSE_INSTEAD = "Nothing was saved: inside a board or huddle run only the user saves teammates. Call propose_teammate with the same fields and a one-line why; " +
  "the user saves it with one click (in a ticket chat it shows as a card, in a huddle under Learnings).";

const PLANNING_TOOLS: Tool[] = [
  {
    name: "ask_questions",
    description:
      "Board planning chat only: ask the user questions as a form in the board's ticket chat (they can also add free text). " +
      "Their answers come back as the user's next message. Ask every open question that matters, 2-8 options each, exactly one option recommended; " +
      "multiSelect true only when several options can apply. Put a one-line intro in your reply; don't repeat the questions as text. " +
      "Nothing is created or changed. After the call, end your turn and wait for the answers.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array", minItems: 1,
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              options: {
                type: "array", minItems: 2, maxItems: 8,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    description: { type: "string", description: "Short note on what this option means." },
                    recommended: { type: "boolean", description: "true on exactly one option." },
                    mockup: { type: "string", description: "File name of the mockup this option stands for (e.g. a-two-buttons.html); the form links to its preview." },
                  },
                  required: ["label"],
                },
              },
              multiSelect: { type: "boolean", description: "Several options can apply. Default: false." },
            },
            required: ["question", "options"],
          },
        },
      },
      required: ["questions"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args) {
      const e = questionsError(args);
      if (e) throw new ClientError(`${e}. Fix it and call ask_questions again.`);
      return SHOWN.replace("a card", "a form");
    },
  },
  {
    name: "propose_ticket",
    description:
      "Board planning chat only: propose an improved title and markdown description for this ticket. " +
      "The board shows it as a card; the user clicks Apply to replace the ticket's title and description. " +
      "Write the description self-contained (## Goal, ## Context, ## Scope, ## Requirements, ## Acceptance criteria, ## Open questions): " +
      "Claude works on it later without this chat. Nothing is created or changed by the call.",
    inputSchema: {
      type: "object",
      properties: { title: TITLE, description: { type: "string", description: "Markdown description." } },
      required: ["title", "description"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args) {
      const e = proposalError(args);
      if (e) throw new ClientError(`${e}. Fix it and call propose_ticket again.`);
      return SHOWN;
    },
  },
  {
    name: "propose_branch",
    description:
      "Board ticket chat (any column): offer to branch this ticket, like Claude Code's /branch. Use it when the user asks to branch, fork, " +
      "or try another direction in parallel without losing this one. The board shows a card with a Branch button; the user's click creates " +
      "\"Branch: <title>\" in Planning with a copy of this conversation and its own git branch off this ticket's branch (committed work only). " +
      "Nothing is created by the call; don't start the other direction yourself.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "One short line: what the branch is for (e.g. try SQLite instead of Postgres)." } },
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args) {
      if (args?.reason !== undefined && typeof args.reason !== "string") throw new ClientError("reason must be a string. Fix it and call propose_branch again.");
      return SHOWN;
    },
  },
  {
    name: "propose_delete",
    description:
      "Board ticket chat: ask the user to delete tickets on this ticket's board (delete_ticket is refused inside board runs). Only when the user asked for it. " +
      "The board shows a card with each ticket's title, id and column, your reason, and Cancel / Delete buttons; deleting removes the ticket's " +
      "worktree, branch and chat and can't be undone. This ticket itself can't be proposed. Nothing is deleted by the call.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, minItems: 1, description: "Ticket ids to delete, e.g. [\"t_20261001_abcd\"]." },
        reason: { type: "string", description: "One short line: why they can go (e.g. replaced by t_20261001_wxyz)." },
      },
      required: ["ids", "reason"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const ids = Array.isArray(args?.ids) ? [...new Set(args.ids.filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim()))] as string[] : [];
      if (!ids.length) throw new ClientError("ids must be a non-empty list of ticket ids. Fix it and call propose_delete again.");
      if (typeof args?.reason !== "string" || !args.reason.trim()) throw new ClientError("reason is required. Fix it and call propose_delete again.");
      const own = runTicketId(ctx);
      if (own && ids.includes(own)) throw new ClientError(`${own} is this chat's own ticket and can't be proposed for deletion; ask the user to delete it from the board.`);
      // Always this chat's board: the card can only delete tickets there.
      const slug = await slugFor({}, ctx);
      const known = new Set((await ctx.client.listTickets(slug)).map((t) => t.id));
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length === ids.length) throw new ClientError(`no such ticket on board ${slug}: ${missing.join(", ")}. Check list_tickets.`);
      return SHOWN + (missing.length ? ` Not on board ${slug}, shown as skipped: ${missing.join(", ")}.` : "");
    },
  },
  {
    name: "propose_teammate",
    description:
      "Board ticket chat (any column) or huddle agent: propose a teammate (huddle role preset) when no existing one fits the job, e.g. \"a teammate that watches X\". " +
      "Call list_huddle_presets first: reuse a teammate that fits; giving an existing name proposes a change to it (fields you leave out keep its values). " +
      "In a ticket chat the board shows a card; the user saves it for all boards or this board, edits it first, or dismisses it. " +
      "From a huddle agent it goes to the huddle's Learnings for the user to review. Nothing is saved by the call.",
    inputSchema: {
      type: "object",
      properties: {
        ...PRESET_FIELDS,
        why: { type: "string", description: "One line: why no existing teammate fits (e.g. no teammate watches a web inbox; @researcher only reads and reports)." },
      },
      required: ["name", "prompt", "why"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const { profile: _p, ...input } = args ?? {};
      try {
        teammateProposal(input);
      } catch (e) {
        throw new ClientError(`${(e as Error).message}. Fix it and call propose_teammate again.`);
      }
      if (!ctx.env[HUDDLE_AGENT_ENV]) return SHOWN;
      // A huddle agent: its session is no ticket chat, so the proposal waits under the huddle's Learnings.
      const slug = await slugFor({}, ctx);
      const l = await ctx.client.huddleProposeTeammate(slug, "current", input, huddleCaller(ctx.env));
      return `Proposed teammate @${l.teammate?.name ?? input.name}: the user reviews it under the huddle's Learnings and saves it with one click. Nothing is saved until then; carry on with your work.`;
    },
  },
  {
    name: "propose_tickets",
    description:
      "Board ticket chat (any column): propose new tickets, e.g. splitting the work or follow-ups, linked to this ticket as their parent. Call list_tickets first to avoid duplicates. " +
      "The board shows one card per ticket; the user clicks Create to add it to Backlog, linked to this ticket. " +
      "Each description must be self-contained (goal, context with relevant files, acceptance criteria). " +
      "key is a short unique name; dependsOn lists keys that must be finished first: give one to tickets that build on each other or likely edit the same files. " +
      "needs lists exclusive resources (e.g. [\"emulator\"]): tickets that need the same one never run at the same time, in any order. " +
      "Nothing is created by the call.",
    inputSchema: {
      type: "object",
      properties: {
        tickets: {
          type: "array", minItems: 1,
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "Short unique name, e.g. api." },
              title: TITLE,
              description: { type: "string", description: "Markdown description." },
              dependsOn: { type: "array", items: { type: "string" }, description: "Keys of tickets in this list that must be finished first." },
              needs: { type: "array", items: { type: "string" }, description: "Exclusive resources its runs use, e.g. [\"emulator\"]." },
            },
            required: ["key", "title", "description"],
          },
        },
      },
      required: ["tickets"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args) {
      const e = ticketsError(args);
      if (e) throw new ClientError(`${e}. Fix it and call propose_tickets again.`);
      return SHOWN;
    },
  },
];

// ---- Huddles: several Claude sessions working on one ticket in a shared room (see src/server/huddle.ts) ----

const HUDDLE = {
  type: "string",
  description: "Huddle id (h_...). Omit inside a board run to use your own huddle; required outside one.",
};
const BUILTIN_NAMES = BUILTIN_PRESETS.filter((p) => p.name !== MAIN_PRESET).map((p) => p.name);
const ROSTER_ENTRY = {
  type: "object",
  properties: {
    preset: {
      type: "string",
      description: `Role preset name: built-ins ${BUILTIN_NAMES.join(", ")}, plus the board's own (list_huddle_presets shows them all with their prompts). ` +
        "It sets the role, prompt, model, mode, lead, canEdit and workspace defaults; the fields below override them.",
    },
    role: { type: "string", description: "Free-text role when no preset fits, e.g. \"Accessibility tester\" (give its prompt too). With a preset: overrides its label." },
    count: { type: "integer", minimum: 1, maximum: 8, description: "How many of this role (handles get -1, -2, ...). Default 1." },
    focus: { type: "string", description: "What exactly this participant should look at." },
    model: { type: "string", description: "Model, e.g. sonnet. Default: the board's." },
    mode: { type: "string", enum: ["tagged", "monitor"], description: "tagged: sleeps until @mentioned. monitor: gets every new message. Default: the preset's; monitor when this entry sets lead true (leads watch every message and wake on any tag)." },
    workspace: {
      type: "string", enum: ["shared", "own"],
      description: "shared: works in the host ticket's worktree, read-only (review, QA). own: a new git worktree off the host's branch where it may edit (several agents writing code in parallel).",
    },
    lead: { type: "boolean", description: "May add participants and manage the findings list." },
    canEdit: { type: "boolean", description: "May edit tracked files; only applies with workspace own. Default: the preset's (true for a free-text role in its own worktree)." },
    prompt: { type: "string", description: "Instructions: with a preset, added to its prompt; with a free-text role, its whole job." },
    handle: { type: "string", description: "Handle for @mentions. Default: the preset or role." },
  },
};

/** Inside a run: its own huddle unless one is named; outside: the named one, as the user. */
function huddleId(args: any, ctx: ToolContext): string {
  const id = str(args, "huddle", false);
  if (id) return id.trim();
  if (!ctx.env[RUN_ENV]) throw new ClientError("huddle is required outside a board run");
  return "current";
}

/** since: reading on from a message, so only the new messages (the brief, roster and findings are left out). */
export function huddlePageText(p: HuddlePage, since?: number): string {
  const h = p.huddle;
  const head = `Huddle ${h.id} on ticket ${h.hostTicket}${h.hostTitle ? ` "${h.hostTitle}"` : ""}: ${h.status}. You are @${p.you}.`;
  if (since !== undefined) {
    const lines = [head, "", p.messages.length ? `Messages after #${since}:` : `No messages after #${since}.`, ...p.messages.map(huddleLine)];
    if (p.hasMore) lines.push("", `More messages: call huddle_read with since=${p.messages.at(-1)?.seq ?? 0}.`);
    return lines.join("\n");
  }
  const lines = [
    head,
    ...(h.brief?.text ? ["", `Pinned brief (by @${h.brief.by}):`, ...h.brief.text.split("\n").map((l) => `    ${l}`)] : []),
    "",
    `Participants (${h.participants.filter((x) => x.kind !== "human").length}/${h.maxParticipants}):`,
    ...h.participants.map((x) =>
      `- @${x.handle}: ${x.role}${x.lead ? ", lead" : ""}, ${x.mode}, ${x.status}${x.statusReason ? ` (${x.statusReason})` : ""}${x.focus ? ` (focus: ${x.focus})` : ""}`),
  ];
  if (h.quiet) lines.push("", `The huddle is quiet${h.idleSince ? ` since ${h.idleSince}` : ""}: nobody is working, no tag is unanswered and no finding is open.`);
  if (h.closeRequest) lines.push("", `@${h.closeRequest.by} asked the user to close the huddle: ${h.closeRequest.reason}`);
  const open = h.findings.filter((f) => f.status === "open");
  if (h.findings.length) {
    lines.push("", `Findings (${open.length} open of ${h.findings.length}):`, ...h.findings.map((f) => `- ${f.id} [${f.status}${f.resolvedBy ? ` by @${f.resolvedBy}` : ""}] ${f.text} (by @${f.by})`));
  }
  lines.push("", p.messages.length ? "Messages:" : "No messages.");
  for (const m of p.messages) lines.push(huddleLine(m));
  if (p.hasMore) lines.push("", `More messages: call huddle_read with since=${p.messages.at(-1)?.seq ?? 0}.`);
  return lines.join("\n");
}

/** Lessons an agent may propose when it turns done (huddle-notes.ts); the user alone saves them as role notes. */
const LESSONS = {
  type: "array",
  maxItems: 3,
  description:
    "Optional, with status done: up to 3 lessons worth reusing in future huddles of your role. Each is a short rule (max 200 characters), " +
    "with evidence (a message #n or a file) and scope general (any repo) or repo (this repo only). The user reviews them; only the user saves them. None is fine.",
  items: {
    type: "object",
    properties: {
      text: { type: "string", description: "The rule, e.g. \"Check UI changes in light and dark mode.\"" },
      evidence: { type: "string", description: "Why: a message #n or a file." },
      scope: { type: "string", enum: ["general", "repo"] },
    },
    required: ["text", "evidence", "scope"],
  },
};

const HUDDLE_TOOLS: Tool[] = [
  {
    name: "huddle_post",
    description:
      "Post a message in your huddle. Tag who should act with @handle (@all for everyone; only leads, @main and the user can wake everyone): " +
      "tagged participants sleep until someone tags them, monitor-mode ones see every message. Every @handle in the text wakes that participant " +
      "(except inside code or quotes), so write a handle without @ when you only refer to someone. The board stamps you as the sender. " +
      "kind finding marks a bug or problem you found.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The message, with @mentions." },
        kind: { type: "string", enum: ["message", "finding"], description: "Default message." },
        status: { type: "string", enum: ["done", "blocked"], description: "Optional: with this message you are done or blocked (give reason). Same as huddle_status. done means your job is finished. Don't mark yourself done while you wait for others; just end your turn. Leads are woken by any tag." },
        reason: { type: "string", description: "status: why (required for blocked)." },
        lessons: LESSONS,
        huddle: HUDDLE, profile: PROFILE,
      },
      required: ["text"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const status = args?.status === "done" || args?.status === "blocked" ? { status: args.status, reason: str(args, "reason", false), ...(args?.lessons ? { lessons: args.lessons } : {}) } : undefined;
      const m = await ctx.client.huddlePost(slug, huddleId(args, ctx), str(args, "text")!, args?.kind === "finding" ? "finding" : "message", huddleCaller(ctx.env), status);
      return `Posted #${m.seq} as @${m.from}${m.mentions.length ? `; woke ${m.mentions.map((x) => `@${x}`).join(", ")}` : ""}.${status ? ` You are now ${status.status}.` : ""}`;
    },
  },
  {
    name: "huddle_status",
    description:
      "Set your own huddle status. done: your job is finished; you sleep until a lead, @main or the user tags you. Don't mark yourself done while you wait for others; just end your turn. Leads are woken by any tag. " +
      "blocked: you can't go on (give reason); @main is told (the user, when you are @main). active: back at work.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["done", "blocked", "active"] },
        reason: { type: "string", description: "What you finished, or what blocks you (required for blocked)." },
        lessons: LESSONS,
        huddle: HUDDLE, profile: PROFILE,
      },
      required: ["status"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const status = args?.status === "done" || args?.status === "blocked" || args?.status === "active" ? args.status : null;
      if (!status) throw new ClientError("status must be done, blocked or active");
      const slug = await slugFor(args, ctx);
      const lessons = Array.isArray(args?.lessons) ? args.lessons : undefined;
      const p = await ctx.client.huddleStatus(slug, huddleId(args, ctx), status, str(args, "reason", false), huddleCaller(ctx.env), lessons);
      const n = lessons?.length ?? 0;
      return `@${p.handle} is now ${p.status}${p.statusReason ? ` (${p.statusReason})` : ""}.${n ? ` ${n} lesson${n === 1 ? "" : "s"} sent to the user for review.` : ""}`;
    },
  },
  {
    name: "huddle_close",
    description:
      "@main and leads: ask the user to close the huddle once its work is done. First write the summary to outputs/huddles/<huddle id>/summary.md " +
      "in the host ticket's outputs folder (what was decided, the findings and their state, what is left). This tags the user; only the user closes the huddle. " +
      "Exception: @main of an auto huddle (start_huddle) closes it at once.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "One line: why the huddle can close." }, huddle: HUDDLE, profile: PROFILE },
      required: ["reason"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const h = await ctx.client.huddleCloseRequest(slug, huddleId(args, ctx), str(args, "reason")!, huddleCaller(ctx.env));
      if (h.status === "closed") return "Closed the auto huddle. Finish the run as usual (land the work if you haven't, then the result line).";
      return "Asked the user to close the huddle. Only they close it; until then the huddle stays open.";
    },
  },
  {
    name: "huddle_read",
    description: "Read your huddle: the pinned brief, the roster, the findings and recent messages. With `since`, only the messages after that #seq " +
      "(no roster or findings), in full: since=n-1 shows message #n that a digest cut short.",
    inputSchema: {
      type: "object",
      properties: { since: { type: "integer", description: "Only messages after this #seq." }, huddle: HUDDLE, profile: PROFILE },
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const since = Number.isInteger(args?.since) ? args.since : undefined;
      return huddlePageText(await ctx.client.huddleRead(slug, huddleId(args, ctx), { since, limit: 60 }, huddleCaller(ctx.env)), since);
    },
  },
  {
    name: "huddle_brief",
    description:
      "Leads, @main and the user: set the huddle's pinned brief, the goal and the decisions so far (max 2,000 characters). It heads every digest each " +
      "participant gets, so keep it short and current; empty text clears it. Replaces the whole brief: include what should stay.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The whole brief: goal, decisions, constraints. Empty clears it." }, huddle: HUDDLE, profile: PROFILE },
      required: ["text"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      if (typeof args?.text !== "string") throw new ClientError("text is required (empty text clears the brief)");
      const slug = await slugFor(args, ctx);
      const h = await ctx.client.huddleBrief(slug, huddleId(args, ctx), args.text, huddleCaller(ctx.env));
      return h.brief ? `Pinned brief updated (${h.brief.text.length} characters).` : "Pinned brief cleared.";
    },
  },
  {
    name: "huddle_mode",
    description: "Switch your own huddle mode. tagged: you sleep until someone @mentions you. monitor: every new message reaches you between your turns.",
    inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["tagged", "monitor"] }, huddle: HUDDLE, profile: PROFILE }, required: ["mode"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const mode = args?.mode === "monitor" ? "monitor" : args?.mode === "tagged" ? "tagged" : null;
      if (!mode) throw new ClientError("mode must be tagged or monitor");
      const slug = await slugFor(args, ctx);
      const hid = huddleId(args, ctx);
      const me = await ctx.client.huddleRead(slug, hid, { limit: 1 }, huddleCaller(ctx.env));
      if (me.you === "you") throw new ClientError("outside a board run you are the user; change a participant's mode on the board");
      await ctx.client.huddleMode(slug, me.huddle.id, me.you, mode, huddleCaller(ctx.env));
      return `@${me.you} is now in ${mode} mode.`;
    },
  },
  {
    name: "huddle_add_participant",
    description:
      "Add participants to your huddle (leads and @main only). Give a preset (list_huddle_presets) or a free-text role with a prompt, how many, and their focus. " +
      "The huddle has a participant limit; when it is full the call fails: then ask the user (tag @you) instead of working around it.",
    inputSchema: { type: "object", properties: { ...ROSTER_ENTRY.properties, huddle: HUDDLE, profile: PROFILE }, required: ["focus"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const { huddle: _h, profile: _p, ...entry } = args ?? {};
      const e = rosterEntryError(entry);
      if (e) throw new ClientError(`${e}. Fix it and call huddle_add_participant again.`);
      const slug = await slugFor(args, ctx);
      const r = await ctx.client.huddleAdd(slug, huddleId(args, ctx), entry, huddleCaller(ctx.env));
      return `Added ${r.added.map((p) => `@${p.handle} (${p.role}, ${p.mode})`).join(", ")}; they start now. ` +
        `${r.huddle.participants.filter((p) => p.kind !== "human").length}/${r.huddle.maxParticipants} participants.`;
    },
  },
  {
    name: "huddle_findings",
    description:
      "The huddle's pinned findings list. list: everyone. add (text) and resolve (id): leads and @main only; " +
      "others post their findings to their lead with huddle_post.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "resolve", "list"] },
        text: { type: "string", description: "add: the finding, with file:line or steps to reproduce." },
        id: { type: "string", description: "resolve: finding id, e.g. f2." },
        huddle: HUDDLE, profile: PROFILE,
      },
      required: ["action"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const action = args?.action === "add" || args?.action === "resolve" || args?.action === "list" ? args.action : null;
      if (!action) throw new ClientError("action must be add, resolve or list");
      const slug = await slugFor(args, ctx);
      const fs = await ctx.client.huddleFindings(slug, huddleId(args, ctx), action, { text: str(args, "text", false), id: str(args, "id", false) }, huddleCaller(ctx.env));
      if (!fs.length) return "No findings yet.";
      return fs.map((f) => `- ${f.id} [${f.status}${f.resolvedBy ? ` by @${f.resolvedBy}` : ""}] ${f.text} (by @${f.by})`).join("\n");
    },
  },
  {
    name: "propose_huddle",
    description:
      "Board ticket chat (the ticket's own session, as coordinator): propose a huddle, a room where helper Claude sessions (reviewer, QA testers, a QA lead...) " +
      "work on this ticket with you and talk to each other; you join as @main. The board shows the roster as a card; nothing starts until the user presses Start. " +
      "For each entry choose workspace: shared (read-only in this ticket's worktree) for review and QA, own (its own worktree and branch) when several agents would edit code in parallel. " +
      "A lead (e.g. qa-lead) gathers findings so you are woken with one consolidated list. Keep it small (limit 8 including you). Nothing starts by the call. " +
      `Or give a template (a whole roster with its rules: rounds, budget, report format; built-in: ${BUILTIN_TEMPLATES.map((t) => t.name).join(", ")}; list_huddle_presets lists the board's) ` +
      "and leave out roster to use the template's.",
    inputSchema: {
      type: "object",
      properties: {
        roster: { type: "array", minItems: 1, items: ROSTER_ENTRY, description: "The participants. Optional with a template (its roster is used)." },
        template: { type: "string", description: "Template name, e.g. design-review: its roster (unless you give one), budget and rules." },
        reason: { type: "string", description: "One line: what the huddle is for." },
      },
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      // The board's presets, when the daemon is reachable; otherwise only the shape is checked here and the daemon checks names at Start.
      const slug = await slugFor(args, ctx).catch(() => null);
      const names = slug ? await ctx.client.listHuddlePresets(slug).then((ps) => ps.map((p) => p.name), () => undefined) : undefined;
      const template = typeof args?.template === "string" && args.template.trim() ? args.template.trim() : null;
      if (args?.template !== undefined && args?.template !== null && !template) throw new ClientError("template must be a template name");
      if (template) {
        // Checked here when the daemon is reachable; otherwise the daemon checks it at Start.
        const known = slug ? await ctx.client.listHuddleTemplates(slug).then((ts) => ts.map((t) => t.name), () => null) : null;
        if (known && !known.includes(template)) throw new ClientError(`unknown template "${template}" (templates: ${known.join(", ")}). Fix it and call propose_huddle again.`);
        if (args?.roster === undefined) return SHOWN;
      }
      const e = rosterError(args?.roster, undefined, names);
      if (e) throw new ClientError(`${e}. Fix it and call propose_huddle again.`);
      return SHOWN;
    },
  },
  {
    name: "start_huddle",
    description:
      "Unattended board runs only (Ready / In Progress work, plan children, schedule runs) on a board with Auto huddles on: start a review huddle on your own ticket " +
      "yourself, before landing important or risky work, instead of proposing one. Same inputs as propose_huddle plus a required reason (posted on the ticket). " +
      "Default template: auto-review-important for ⭐ tickets, else auto-review. After it starts, end your turn: the board keeps the ticket In Progress and wakes you " +
      "with the findings. If another auto huddle is live on the board, the ticket waits for the slot and the board wakes you when it frees. " +
      "Refused in chats and Planning, when the setting is off, or when the ticket already has a huddle: use propose_huddle then.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "One line: why this work needs a review (⭐ important, or the risk: user-facing, data, security, payments, migrations)." },
        template: { type: "string", description: "auto-review, or auto-review-important for ⭐ tickets and security/data/payments/migration risks." },
        roster: { type: "array", minItems: 1, items: ROSTER_ENTRY, description: "Optional custom roster instead of a template." },
        maxCostUsd: { type: "number", description: "Optional budget in USD when the ticket asks for one (capped at $100). Default: the template's budget." },
        profile: PROFILE,
      },
      required: ["reason"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      if (!ctx.env[RUN_ENV]) throw new ClientError("start_huddle only works inside an unattended board run; propose a huddle with propose_huddle instead");
      const reason = str(args, "reason")!;
      const template = typeof args?.template === "string" && args.template.trim() ? args.template.trim() : undefined;
      if (args?.roster !== undefined) {
        const e = rosterError(args.roster, undefined, undefined);
        if (e) throw new ClientError(`${e}. Fix it and call start_huddle again.`);
      }
      const maxCostUsd = args?.maxCostUsd === undefined || args?.maxCostUsd === null ? undefined : Number(args.maxCostUsd);
      const slug = await slugFor(args, ctx);
      const r = await ctx.client.startAutoHuddle(slug, { reason, template, roster: args?.roster, maxCostUsd }, huddleCaller(ctx.env));
      if (r.waiting) {
        return "Another auto huddle is running on this board, so this ticket waits for the huddle slot. End your turn now with a short note (no landing); " +
          "the board keeps the ticket In Progress and wakes you when the slot frees.";
      }
      const h = r.huddle!;
      return `Auto huddle ${h.id} started (${r.template}${h.maxCostUsd !== undefined ? `, budget $${h.maxCostUsd.toFixed(2)}` : ""}) with ${h.participants.filter((p) => p.kind === "agent").map((p) => `@${p.handle}`).join(", ")}; you are @main. ` +
        "Don't land yet: end your turn now with a short note. The board keeps the ticket In Progress and wakes you with the QA lead's consolidated findings.";
    },
  },
  {
    name: "list_huddle_presets",
    description: "List the board's teammates (huddle role presets: built-ins, the user's for all boards and the board's own) with their prompt, default model, mode, lead, canEdit and workspace, and the huddle templates. " +
      "Use the preset names in propose_huddle and huddle_add_participant, the template names in propose_huddle.",
    inputSchema: { type: "object", properties: { profile: PROFILE } },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const [ps, ts] = await Promise.all([ctx.client.listHuddlePresets(slug), ctx.client.listHuddleTemplates(slug).catch(() => [])]);
      return `Teammates (huddle presets) on board ${slug}:\n${ps.map(presetLine).join("\n")}` +
        (ts.length ? `\n\nHuddle templates (whole rosters with rules; use with propose_huddle template):\n${ts.map(templateLine).join("\n")}` : "");
    },
  },
  {
    name: "save_huddle_preset",
    description:
      `Create or change a teammate (huddle role preset) for the user, outside board runs. Saving a built-in's name (${BUILTIN_PRESETS.map((p) => p.name).join(", ")}) ` +
      "overrides it; delete_huddle_preset resets it. scope board (default) saves it for this board only, global for every board. Fields you leave out keep the existing teammate's values. " +
      "Inside a board or huddle run it saves nothing: use propose_teammate, and the user saves it with one click.",
    inputSchema: {
      type: "object",
      properties: {
        ...PRESET_FIELDS,
        scope: { type: "string", enum: ["board", "global"], description: "board: this board only (default). global: every board." },
        profile: PROFILE,
      },
      required: ["name", "prompt"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      // Only the user saves teammates; a run proposes one (the daemon refuses runs too).
      if (ctx.env[RUN_ENV] || ctx.env[HUDDLE_AGENT_ENV]) return PROPOSE_INSTEAD;
      const { profile: _p, ...input } = args ?? {};
      const slug = await slugFor(args, ctx);
      const p = await ctx.client.saveHuddlePreset(slug, input, huddleCaller(ctx.env));
      const where = p.source === "global" ? "for all boards" : `on board ${slug}`;
      return `Saved preset "${p.name}" ${where}${p.base ? ` (overrides the ${p.base === "builtin" ? "built-in" : "all-boards version"})` : ""}:\n${presetLine(p)}`;
    },
  },
  {
    name: "delete_huddle_preset",
    description: "Delete a teammate (huddle role preset), or reset a changed one to the version below it (all boards, then built-in). Built-ins themselves can't be deleted. Not from a board or huddle run (ask the user).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Preset name." },
        scope: { type: "string", enum: ["board", "global"], description: "The level to delete at. Default: the version in effect on this board." },
        profile: PROFILE,
      },
      required: ["name"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const name = str(args, "name")!.trim();
      const scope = args?.scope === "global" || args?.scope === "board" ? args.scope : undefined;
      const r = await ctx.client.deleteHuddlePreset(slug, name, huddleCaller(ctx.env), scope);
      const now = r.presets.find((p) => p.name === presetName(name));
      return r.reset && now ? `Reset "${name}": board ${slug} now uses the ${now.source === "builtin" ? "built-in" : "all-boards"} version.` : `Deleted preset "${name}".`;
    },
  },
];

export const TOOLS: Tool[] = [
  {
    name: "list_profiles",
    description: "List the kanban boards (profiles) and the repo folder each one belongs to.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(_args, ctx) {
      const ps = await ctx.client.listProfiles();
      return profileList(ps);
    },
  },
  {
    name: "list_tickets",
    description: "List tickets on a board with id, column and title. Call this before create_ticket to avoid duplicates.",
    inputSchema: { type: "object", properties: { profile: PROFILE, status: { ...STATUS, description: "Only this column." } } },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      let ts = await ctx.client.listTickets(slug);
      if (args?.status) {
        const s = parseStatus(args.status);
        ts = ts.filter((t) => t.status === s);
      }
      return ts.length ? `Board ${slug}:\n${ts.map(ticketLine).join("\n")}` : `Board ${slug}: no tickets${args?.status ? ` in ${args.status}` : ""}.`;
    },
  },
  {
    name: "get_ticket",
    description: "Show one ticket: description, column, run state, branch/PR and comments.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID }, required: ["id"] },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      const [t, comments] = await Promise.all([ctx.client.getTicket(slug, id), ctx.client.listComments(slug, id)]);
      return ticketText(t, comments);
    },
  },
  {
    name: "create_ticket",
    description:
      "Create a ticket on the board. Check list_tickets first so you don't add a duplicate. " +
      "Write a self-contained description in markdown (## Goal, ## Context with relevant files, ## Acceptance criteria), " +
      "because another Claude session will work on it later without this conversation. " +
      "Leave status and mode at their defaults (backlog, interview) unless the user explicitly asks to start work or skip the interview.",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE,
        title: { type: "string", description: "Short, specific title (under 80 characters)." },
        body: { type: "string", description: "Markdown description." },
        status: { ...STATUS, description: `${STATUS.description} Default: backlog.` },
        mode: { ...MODE, description: `${MODE.description} Default: interview.` },
        key: { type: "string", description: "Planner only: short name siblings can use in dependsOn." },
        dependsOn: DEPENDS_ON,
        needs: NEEDS,
      },
      required: ["title"],
    },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const deps = depList(args);
      const needs = needsList(args);
      const t = await ctx.client.createTicket(slug, {
        title: str(args, "title")!.trim(),
        body: typeof args?.body === "string" ? args.body : "",
        status: args?.status ? parseStatus(args.status) : "backlog",
        mode: args?.mode ? parseMode(args.mode) : "interview",
        ...(str(args, "key", false) ? { planKey: str(args, "key")!.trim() } : {}),
        ...(deps ? { dependsOn: deps } : {}),
        ...(needs?.length ? { needs } : {}),
      }, ctx.env[RUN_ENV]);
      return `Created ${t.id} on board ${slug} in ${t.status} (${t.mode} mode): ${t.title}`;
    },
  },
  {
    name: "update_ticket",
    description:
      "Edit a ticket's title, description, column, mode, dependsOn, needs or ⭐ important. Moving it to ready starts a Claude run, " +
      "moving it to planning starts the interview in the board chat (same as dragging it on the board). " +
      "A planner can take one of its children out of its plan with release: true.",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE, id: ID, title: { type: "string" }, body: { type: "string", description: "New markdown description (replaces the old one)." },
        status: STATUS, mode: MODE, dependsOn: DEPENDS_ON, needs: NEEDS,
        important: {
          type: "boolean",
          description: "⭐ Important: unattended runs review the work in an auto huddle before landing it. Set it only when the user says the task is very important; " +
            "a ticket's own run (its chat included) may set it on that ticket.",
        },
        release: { type: "boolean", description: "true: take the ticket out of its plan (it keeps its column; its dependsOn and key are cleared)." },
      },
      required: ["id"],
    },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const patch: TicketPatch = {};
      if (typeof args?.title === "string" && args.title.trim()) patch.title = args.title.trim();
      if (typeof args?.body === "string") patch.body = args.body;
      if (args?.status) patch.status = parseStatus(args.status);
      if (args?.mode) patch.mode = parseMode(args.mode);
      const deps = depList(args);
      if (deps) patch.dependsOn = deps;
      const needs = needsList(args);
      if (needs) patch.needs = needs;
      if (args?.release === true) patch.parentId = null;
      if (typeof args?.important === "boolean") patch.important = args.important;
      if (!Object.keys(patch).length) throw new ClientError("nothing to change: pass title, body, status, mode, dependsOn, needs, important or release");
      const t = await ctx.client.updateTicket(slug, str(args, "id")!, patch, ctx.env[RUN_ENV]);
      return `Updated ${t.id}: ${ticketLine(t)}`;
    },
  },
  {
    name: "move_ticket",
    description: "Move a ticket to another column. ready starts a Claude run; planning starts the interview in the board chat.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID, status: STATUS }, required: ["id", "status"] },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const t = await ctx.client.updateTicket(slug, str(args, "id")!, { status: parseStatus(str(args, "status")) }, ctx.env[RUN_ENV]);
      return `Moved ${t.id} to ${t.status}${t.running ? " (Claude is working on it)" : ""}.`;
    },
  },
  {
    name: "adopt_tickets",
    description:
      "Manager mode: make existing tickets on this board children of this ticket, so its plan runs them (use when the user asks you, in this " +
      "ticket's chat, to manage, run or take over tickets). Find them with list_tickets first. Tickets in another plan, finished ones, this " +
      "ticket and its parents are skipped with a reason. Adopted tickets keep their column, mode, dependsOn and needs; nothing starts until " +
      "the plan starts (plan_control). Then set dependsOn (ticket ids) and needs with update_ticket. Tell the user what was adopted and skipped. " +
      "Inside a board run it only works in a reply to the user's own message in this ticket's chat.",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE,
        ids: { type: "array", items: { type: "string" }, description: "Ticket ids to adopt, e.g. [\"t_20261001_abcd\"]." },
        id: { ...ID, description: "Adopting ticket. Default: the ticket of this board run." },
      },
      required: ["ids"],
    },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id", false) ?? runTicketId(ctx);
      if (!id) throw new ClientError("id is required outside a board run");
      if (!Array.isArray(args?.ids) || !args.ids.some((x: unknown) => typeof x === "string" && x.trim())) throw new ClientError("ids must be a non-empty list of ticket ids");
      const r = await ctx.client.adopt(slug, id, args.ids.filter((x: unknown) => typeof x === "string"), ctx.env[RUN_ENV]);
      const lines = [
        r.adopted.length ? `Adopted ${r.adopted.length}:\n${r.adopted.map((t) => `- ${ticketLine(t)}`).join("\n")}` : "Adopted none.",
        ...(r.skipped.length ? [`Skipped ${r.skipped.length}:\n${r.skipped.map((x) => `- ${x.id}: ${x.reason}`).join("\n")}`] : []),
        "Nothing starts until the plan starts: set dependsOn / needs with update_ticket, then call plan_control.",
      ];
      return lines.join("\n\n");
    },
  },
  {
    name: "plan_control",
    description:
      "Start or resume this ticket's plan, so the board runs its child tickets unattended: in dependency order, a few at a time, one ticket per " +
      "exclusive resource (needs) at a time, never a child waiting on the user. Use it when the user asked you to run, manage or take over the " +
      "tickets. Pausing, finishing and how many run at once stay with the user (Plan tab). Inside a board run it works for the ticket's own plan " +
      "only: in a reply to the user's message in this ticket's chat, or while the plan runs.",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE,
        action: { type: "string", enum: ["start", "resume"], description: "start a new plan, or resume a paused or stuck one (both work either way)." },
        id: { ...ID, description: "Planner ticket. Default: the ticket of this board run." },
      },
      required: ["action"],
    },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id", false) ?? runTicketId(ctx);
      if (!id) throw new ClientError("id is required outside a board run");
      const action = args?.action === "resume" ? "resume" : args?.action === "start" ? "start" : null;
      if (!action) throw new ClientError("action must be start or resume");
      const t = await ctx.client.planAction(slug, id, action, ctx.env[RUN_ENV]);
      const p = t.plan;
      return `Plan of ${t.id} is ${p?.state ?? "not started"}${p ? ` (${p.maxConcurrent} at a time)` : ""}. ` +
        "The board starts children itself and wakes this ticket when one needs a decision; end your reply now.";
    },
  },
  {
    name: "chat_ticket",
    description:
      "Send a message to the Claude session working on a ticket (or start one), like typing in the board's ticket chat. " +
      "Answering a question form or applying a proposed ticket can only be done in the board UI.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID, message: { type: "string" } }, required: ["id", "message"] },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const t = await ctx.client.chat(slug, str(args, "id")!, str(args, "message")!, ctx.env[RUN_ENV]);
      return `Sent to ${t.id}. ${t.running ? "Claude is working on it" : `Ticket is in ${t.status}`}; read the reply later with get_ticket or on the board.`;
    },
  },
  {
    name: "stop_ticket",
    description: "Stop the Claude run working on a ticket.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID }, required: ["id"] },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      const r = await ctx.client.stop(slug, id, ctx.env[RUN_ENV]);
      return r.stopped ? `Stopped the run on ${id}.` : `${id} had no run to stop.`;
    },
  },
  {
    name: "comment_ticket",
    description: "Add a comment to a ticket. Claude reads new comments at the start of its next run.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID, text: { type: "string" } }, required: ["id", "text"] },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      await ctx.client.comment(slug, id, str(args, "text")!, ctx.env[RUN_ENV]);
      return `Commented on ${id}.`;
    },
  },
  {
    name: "delete_ticket",
    description: "Delete a ticket and its worktree. Only do this when the user asked for it.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID }, required: ["id"] },
    changes: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      await ctx.client.deleteTicket(slug, id);
      return `Deleted ${id}.`;
    },
  },
  {
    name: "report_bug",
    description:
      `File a bug in ckanban itself as a GitHub issue on ${REPO}. ` +
      "Only use it when the user asks to report a ckanban bug, never on your own initiative. " +
      "Before calling, show the user the title and description you will send and wait for a yes. " +
      "Write the description in markdown with: what happened, steps to reproduce (numbered), expected vs actual. " +
      "Pass ticketId to attach that ticket's details, last run result and log tail (home and data paths and secrets are hidden). " +
      "Screenshots can't be uploaded: tell the user to drag them into a comment on the issue. " +
      "Returns the issue URL, or a prefilled link to finish it in the browser when gh is missing or logged out.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short summary of the bug (under 80 characters)." },
        description: { type: "string", description: "Markdown: what happened, steps to reproduce, expected vs actual." },
        ticketId: { ...ID, description: "Ticket the bug showed up on (optional): its context is attached." },
        includeLogs: { type: "boolean", description: "Attach the tail of the ticket's last run log. Default: true." },
        profile: PROFILE,
      },
      required: ["title", "description"],
    },
    // Doesn't change the board, so it works from a board run's ticket chat too.
    changes: false,
    async run(args, ctx) {
      const ticketId = str(args, "ticketId", false);
      const slug = ticketId ? await slugFor(args, ctx) : undefined;
      const include: ("env" | "ticket" | "log")[] = ["env", "ticket"];
      if (args?.includeLogs !== false) include.push("log");
      const r = await ctx.client.reportBug({
        title: str(args, "title")!.trim(), description: str(args, "description")!, profile: slug, ticketId, include, source: "ai",
      });
      return bugReportText(r);
    },
  },
  ...PLANNING_TOOLS,
  ...HUDDLE_TOOLS,
  ...ARTIFACT_TOOLS,
  ...SCHEDULE_TOOLS,
];

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
  if (!tool) return text(`unknown tool ${name}`, true);
  try {
    if (tool.changes && !tool.allowInRun && !tool.plannerScope) assertCanChange(ctx.env);
    return text(await tool.run(args ?? {}, ctx));
  } catch (e) {
    return text((e as Error).message, true);
  }
}

type JsonRpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

/** Handles one JSON-RPC message; returns the response, or null for notifications. */
export async function handleMessage(msg: JsonRpc, ctx: ToolContext): Promise<object | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  const isRequest = msg.id !== undefined && msg.id !== null;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "ckanban", version: VERSION },
        instructions:
          "Tools for the user's local ckanban board. Use them when the user asks to put work on the board, " +
          "find what to do next, or check on, start or steer tickets. Tickets you create land in Backlog in interview mode by default. " +
          "Schedules (create_schedule etc.) make the board create and run a ticket on a cron, for work the user wants done regularly. " +
          "ask_questions, propose_ticket, propose_tickets, propose_branch and propose_teammate are for the board's ticket chats: they show a form or cards to the user.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
    case "tools/call":
      return reply(await callTool(String(msg.params?.name ?? ""), msg.params?.arguments, ctx));
    default:
      return isRequest ? fail(-32601, `method not found: ${msg.method}`) : null;
  }
}

export async function serveStdio(ctx: ToolContext = { client: new BoardClient(), cwd: process.cwd(), env: process.env }): Promise<void> {
  const write = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
  const decoder = new TextDecoder();
  let buf = "";
  const pending: Promise<void>[] = [];
  const handle = (line: string) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    for (const m of msgs) {
      pending.push(handleMessage(m, ctx).then((r) => {
        if (r) write(r);
      }, (e) => {
        if (m?.id !== undefined) write({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: (e as Error).message } });
      }));
    }
  };
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf);
  await Promise.all(pending);
}
