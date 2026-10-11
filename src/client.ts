// Talks to the local daemon's HTTP API for the `ckanban ticket` CLI and the `ckanban mcp` server.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { HuddlePresetView } from "./server/huddle-presets";
import { HUDDLE_AGENT_ENV, HUDDLE_HEADER, SOURCE_HEADER, type RosterEntry } from "./server/huddle-roster";
import type { HuddleTemplateView } from "./server/huddle-templates";
import { RUN_HEADER } from "./server/scheduler";
import { defaultRoot, Store } from "./server/store";
import { STATUSES, type HuddleFinding, type HuddleLearning, type HuddleMessage, type HuddleMode, type Status, type TicketMode } from "./server/types";

export class ClientError extends Error {}

export const DAEMON_DOWN = "ckanban daemon not running, run `ckanban install` or `ckanban dev`";

/** Set on every board run's claude process ("<profile>/<ticket id>"). */
export const RUN_ENV = "CKANBAN_TICKET";

export function boardPort(): number {
  return Number(process.env.CKANBAN_PORT) || new Store(defaultRoot()).config().port;
}

export interface ProfileInfo {
  name: string;
  slug: string;
  path: string;
  baseBranch: string;
  running?: number;
}

export interface TicketInfo {
  id: string;
  title: string;
  status: Status;
  mode?: TicketMode;
  body: string;
  running?: boolean;
  outcome: string | null;
  prUrl: string | null;
  branch: string | null;
  lastActivity: string | null;
  runStartedAt?: string | null;
  error: string | null;
  scheduleId?: string | null;
  /** Planner ticket whose plan runs this one. */
  parentId?: string | null;
  planKey?: string | null;
  dependsOn?: string[];
  /** Exclusive resources (e.g. emulator): tickets needing the same one never run at the same time. */
  needs?: string[];
  resources?: { holding: boolean; waitingFor: string[] } | null;
  /** Plan child waiting on the user: the plan won't start it until then. */
  userWait?: string | null;
  plan?: { state: string; maxConcurrent: number } | null;
  /** ⭐ Important: reviewed in an auto huddle before landing. */
  important?: boolean;
  autoHuddle?: { state: "waiting" | "live"; reason: string; template: string; huddleId?: string | null } | null;
  createdAt: string;
  updatedAt: string;
  attention?: { kind: string } | null;
}

export interface ScheduleInfo {
  id: string;
  name: string;
  title: string;
  body: string;
  mode: TicketMode;
  cron: string;
  enabled: boolean;
  skipIfRunning: boolean;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  summary: string;
  active: boolean;
}

export interface ScheduleInput {
  name?: string;
  title?: string;
  body?: string;
  mode?: TicketMode;
  cron?: string;
  enabled?: boolean;
  skipIfRunning?: boolean;
}

export interface ScheduleHistoryInfo {
  at: string;
  kind: "fired" | "skipped" | "error" | "edited";
  trigger?: string;
  ticketId?: string | null;
  message?: string;
  action?: string;
  fields?: string[];
  by?: "user" | { ticketId: string };
  previous?: { title?: string; body?: string; cron?: string };
  ticket: { id: string; title: string; status: Status; outcome: string | null; running: boolean } | null;
}

export interface CronPreviewInfo {
  valid: boolean;
  error: string | null;
  summary: string | null;
  next: string[];
}

export interface CommentInfo {
  id: string;
  author: string;
  text: string;
  at: string;
}

export interface TicketPatch {
  title?: string;
  body?: string;
  status?: Status;
  mode?: TicketMode;
  dependsOn?: string[];
  needs?: string[];
  important?: boolean;
  /** null takes the ticket out of its plan. */
  parentId?: null;
}

export interface AdoptReply {
  adopted: TicketInfo[];
  skipped: { id: string; reason: string }[];
}

export interface HuddleParticipantInfo {
  handle: string;
  role: string;
  mode: HuddleMode;
  lead: boolean;
  canEdit: boolean;
  workspace: string;
  status: string;
  /** done / blocked: why. */
  statusReason?: string | null;
  kind: string;
  focus?: string;
  ticketId?: string | null;
  running: boolean;
}

export interface HuddleInfo {
  id: string;
  hostTicket: string;
  hostTitle: string | null;
  status: string;
  maxParticipants: number;
  maxCostUsd?: number;
  participants: HuddleParticipantInfo[];
  findings: HuddleFinding[];
  seq: number;
  /** Live, nobody working, no unanswered tags, no open findings; idleSince: the last message or turn. */
  quiet?: boolean;
  idleSince?: string | null;
  closeRequest?: { by: string; at: string; reason: string } | null;
  /** Pinned brief (goal, decisions). */
  brief?: { text: string; by: string; at: string } | null;
}

/** A lesson an agent proposes when it turns done: a rule worth reusing, its evidence, and where it applies. */
export interface HuddleLesson {
  text: string;
  evidence?: string;
  scope?: "general" | "repo";
}

/** A participant's own huddle status: done, blocked (with a reason) or active again. */
export type HuddleStatusChange = "done" | "blocked" | "active";

/** A huddle with a page of its messages; `you` is the caller's own handle. */
export interface HuddlePage {
  huddle: HuddleInfo;
  you: string;
  messages: HuddleMessage[];
  hasMore: boolean;
}

/** Who calls the huddle API from a run: its ticket (CKANBAN_TICKET) and, for a huddle agent, CKANBAN_HUDDLE_AGENT. */
export interface HuddleCaller {
  run?: string | null;
  agent?: string | null;
}

export function huddleCaller(env: Record<string, string | undefined>): HuddleCaller {
  return { run: env[RUN_ENV] ?? null, agent: env[HUDDLE_AGENT_ENV] ?? null };
}

export interface BugReportRequest {
  title: string;
  description: string;
  profile?: string;
  ticketId?: string;
  include?: ("env" | "ticket" | "log")[];
  source: "ai" | "cli";
}

export interface BugReportReply {
  url: string | null;
  fallbackUrl: string;
  error: string | null;
  screenshots: string[];
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class BoardClient {
  private base: string;

  constructor(port = boardPort(), private fetchFn: Fetch = fetch) {
    // 127.0.0.1, not localhost: the daemon only listens on IPv4 and checks the Host header.
    this.base = `http://127.0.0.1:${port}`;
  }

  get url(): string {
    return this.base;
  }

  private async req<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    let res: Response;
    const headers = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra };
    try {
      res = await this.fetchFn(this.base + path, {
        method,
        headers: Object.keys(headers).length ? headers : undefined,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ClientError(DAEMON_DOWN);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) throw new ClientError(data?.error ?? `${method} ${path} failed: ${res.status}`);
    return data as T;
  }

  private t(slug: string, id?: string): string {
    const base = `/api/profiles/${encodeURIComponent(slug)}/tickets`;
    return id ? `${base}/${encodeURIComponent(id)}` : base;
  }

  listProfiles = () => this.req<ProfileInfo[]>("GET", "/api/profiles");
  listTickets = (slug: string) => this.req<TicketInfo[]>("GET", this.t(slug));
  getTicket = (slug: string, id: string) => this.req<TicketInfo>("GET", this.t(slug, id));
  // `run` (a board run's CKANBAN_TICKET): the daemon only lets a running plan's planner change its own children.
  createTicket = (
    slug: string,
    input: { title: string; body?: string; status?: Status; mode?: TicketMode; planKey?: string; dependsOn?: string[]; needs?: string[] },
    run?: string | null,
  ) => this.req<TicketInfo>("POST", this.t(slug), input, this.by(run));
  // From a run, only the planner's own plan, and only with planner rights (see Board.plannerRights).
  planAction = (slug: string, id: string, action: "start" | "resume", run?: string | null) =>
    this.req<TicketInfo>("POST", `${this.t(slug, id)}/plan`, { action }, this.by(run));
  adopt = (slug: string, id: string, ids: string[], run?: string | null) => this.req<AdoptReply>("POST", `${this.t(slug, id)}/adopt`, { ids }, this.by(run));
  updateTicket = (slug: string, id: string, patch: TicketPatch, run?: string | null) => this.req<TicketInfo>("PATCH", this.t(slug, id), patch, this.by(run));
  deleteTicket = (slug: string, id: string) => this.req<void>("DELETE", this.t(slug, id));
  chat = (slug: string, id: string, text: string, run?: string | null) => this.req<TicketInfo>("POST", `${this.t(slug, id)}/chat`, { text }, this.by(run));
  stop = (slug: string, id: string, run?: string | null) => this.req<{ stopped: boolean }>("POST", `${this.t(slug, id)}/stop`, {}, this.by(run));
  listComments = (slug: string, id: string) => this.req<CommentInfo[]>("GET", `${this.t(slug, id)}/comments`);
  comment = (slug: string, id: string, text: string, run?: string | null) =>
    this.req<CommentInfo>("POST", `${this.t(slug, id)}/comments`, { text }, this.by(run));
  reportBug = (input: BugReportRequest) => this.req<BugReportReply>("POST", "/api/bug-report", input);

  private s(slug: string, id?: string): string {
    const base = `/api/profiles/${encodeURIComponent(slug)}/schedules`;
    return id ? `${base}/${encodeURIComponent(id)}` : base;
  }
  /** `run` is the board run's CKANBAN_TICKET, so the daemon credits the change to that ticket. */
  private by = (run?: string | null): Record<string, string> => (run ? { [RUN_HEADER]: run } : {});

  listSchedules = (slug: string) => this.req<ScheduleInfo[]>("GET", this.s(slug));
  createSchedule = (slug: string, input: ScheduleInput, run?: string | null) =>
    this.req<ScheduleInfo>("POST", this.s(slug), input, this.by(run));
  updateSchedule = (slug: string, id: string, patch: ScheduleInput, run?: string | null) =>
    this.req<ScheduleInfo>("PATCH", this.s(slug, id), patch, this.by(run));
  deleteSchedule = (slug: string, id: string, run?: string | null) => this.req<void>("DELETE", this.s(slug, id), undefined, this.by(run));
  runSchedule = (slug: string, id: string) =>
    this.req<{ entry: ScheduleHistoryInfo; schedule: ScheduleInfo }>("POST", `${this.s(slug, id)}/run`, {});
  scheduleHistory = (slug: string, id: string) => this.req<ScheduleHistoryInfo[]>("GET", `${this.s(slug, id)}/history`);
  cronPreview = (expr: string) => this.req<CronPreviewInfo>("GET", `/api/cron/preview?expr=${encodeURIComponent(expr)}`);

  // Huddle role presets (teammates): built-ins merged with the global ones and the board's own.
  private hp = (slug: string, name?: string) =>
    `/api/profiles/${encodeURIComponent(slug)}/huddle-presets${name ? `/${encodeURIComponent(name)}` : ""}`;
  listHuddlePresets = (slug: string) => this.req<HuddlePresetView[]>("GET", this.hp(slug));
  /** c: the calling run (a run may only add new presets). */
  saveHuddlePreset = (slug: string, preset: Record<string, unknown>, c: HuddleCaller = {}) => this.req<HuddlePresetView>("POST", this.hp(slug), preset, this.as(c));
  /** scope: the level to delete at (default: the one in effect). */
  deleteHuddlePreset = (slug: string, name: string, c: HuddleCaller = {}, scope?: "board" | "global") =>
    this.req<{ reset: boolean; presets: HuddlePresetView[] }>("DELETE", `${this.hp(slug, name)}${scope ? `?scope=${scope}` : ""}`, undefined, this.as(c));

  // Whole-huddle templates (roster and rules): built-ins merged with the board's own.
  listHuddleTemplates = (slug: string) => this.req<HuddleTemplateView[]>("GET", `/api/profiles/${encodeURIComponent(slug)}/huddle-templates`);

  // Huddles. The daemon decides who the caller is from these headers, never from the request body.
  private h(slug: string, hid: string): string {
    return `/api/profiles/${encodeURIComponent(slug)}/huddles/${encodeURIComponent(hid)}`;
  }
  private as = (c: HuddleCaller): Record<string, string> => ({ [SOURCE_HEADER]: "mcp", ...this.by(c.run), ...(c.agent ? { [HUDDLE_HEADER]: c.agent } : {}) });
  /** hid "current": the caller's own huddle. */
  huddleRead = (slug: string, hid: string, q: { since?: number; limit?: number }, c: HuddleCaller) => {
    const qs = new URLSearchParams();
    if (q.since !== undefined) qs.set("since", String(q.since));
    if (q.limit !== undefined) qs.set("limit", String(q.limit));
    return this.req<HuddlePage>("GET", `${this.h(slug, hid)}${qs.size ? `?${qs}` : ""}`, undefined, this.as(c));
  };
  /** status: the sender is done or blocked (reason) with this message. */
  huddlePost = (slug: string, hid: string, text: string, kind: "message" | "finding", c: HuddleCaller, status?: { status: HuddleStatusChange; reason?: string; lessons?: HuddleLesson[] }) =>
    this.req<HuddleMessage>("POST", `${this.h(slug, hid)}/messages`, { text, kind, ...status }, this.as(c));
  /** lessons (status done): proposed for the user to review as role notes. */
  huddleStatus = (slug: string, hid: string, status: HuddleStatusChange, reason: string | undefined, c: HuddleCaller, lessons?: HuddleLesson[]) =>
    this.req<HuddleParticipantInfo>("POST", `${this.h(slug, hid)}/status`, { status, reason, ...(lessons?.length ? { lessons } : {}) }, this.as(c));
  /** start_huddle: the host ticket's own unattended run starts its auto huddle, or waits for the board's slot. */
  startAutoHuddle = (slug: string, input: { reason: string; template?: string; roster?: RosterEntry[]; maxCostUsd?: number }, c: HuddleCaller) =>
    this.req<{ waiting: boolean; template: string; huddle: HuddleInfo | null }>("POST", `/api/profiles/${encodeURIComponent(slug)}/huddles/auto`, input, this.as(c));
  huddleCloseRequest = (slug: string, hid: string, reason: string, c: HuddleCaller) =>
    this.req<HuddleInfo>("POST", `${this.h(slug, hid)}/close-request`, { reason }, this.as(c));
  huddleMode = (slug: string, hid: string, handle: string, mode: HuddleMode, c: HuddleCaller) =>
    this.req<HuddleInfo>("PATCH", `${this.h(slug, hid)}/participants/${encodeURIComponent(handle)}`, { mode }, this.as(c));
  huddleAdd = (slug: string, hid: string, entry: RosterEntry, c: HuddleCaller) =>
    this.req<{ added: HuddleParticipantInfo[]; huddle: HuddleInfo }>("POST", `${this.h(slug, hid)}/participants`, entry, this.as(c));
  huddleFindings = (slug: string, hid: string, action: "add" | "resolve" | "list", arg: { text?: string; id?: string }, c: HuddleCaller) =>
    this.req<HuddleFinding[]>("POST", `${this.h(slug, hid)}/findings`, { action, ...arg }, this.as(c));
  /** A huddle agent proposes a teammate: it waits under the huddle's Learnings until the user saves it. */
  huddleProposeTeammate = (slug: string, hid: string, input: Record<string, unknown>, c: HuddleCaller) =>
    this.req<HuddleLearning>("POST", `${this.h(slug, hid)}/teammates`, input, this.as(c));
  /** Set the pinned brief ("" clears it). */
  huddleBrief = (slug: string, hid: string, text: string, c: HuddleCaller) => this.req<HuddleInfo>("PUT", `${this.h(slug, hid)}/brief`, { text }, this.as(c));
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Main checkout of the git repo `dir` is in (differs from `dir` inside a worktree), or null. */
export function mainCheckout(dir: string): string | null {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, stdout: "pipe", stderr: "ignore" });
    if (r.exitCode !== 0) return null;
    const common = r.stdout.toString().trim();
    if (!common || !isAbsolute(common)) return null;
    return real(dirname(common));
  } catch {
    return null;
  }
}

/** The profile with the deepest `path` containing `dir`, or null. */
export function deepestProfile<P extends { path: string }>(profiles: P[], dir: string): P | null {
  let best: P | null = null;
  let bestLen = -1;
  for (const p of profiles) {
    const path = real(p.path);
    if (contains(path, dir) && path.length > bestLen) {
      best = p;
      bestLen = path.length;
    }
  }
  return best;
}

export function profileList(profiles: ProfileInfo[]): string {
  if (!profiles.length) return "No profiles yet; add one on the board first.";
  return "Profiles:\n" + profiles.map((p) => `  ${p.slug}  (${p.name}, ${p.path})`).join("\n");
}

/**
 * Picks the board to act on: an explicit slug (or name), else the profile whose folder contains
 * `cwd` (worktrees count as their main checkout), else fails listing the profiles.
 */
export function resolveProfile(
  profiles: ProfileInfo[], opts: { explicit?: string | null; cwd: string; main?: (dir: string) => string | null },
): ProfileInfo {
  const want = opts.explicit?.trim();
  if (want) {
    const p = profiles.find((x) => x.slug === want) ?? profiles.find((x) => x.name.toLowerCase() === want.toLowerCase());
    if (!p) throw new ClientError(`no profile "${want}". ${profileList(profiles)}`);
    return p;
  }
  const cwd = real(opts.cwd);
  const hit = deepestProfile(profiles, cwd);
  if (hit) return hit;
  const main = (opts.main ?? mainCheckout)(cwd);
  const viaMain = main && main !== cwd ? deepestProfile(profiles, main) : null;
  if (viaMain) return viaMain;
  throw new ClientError(`no profile matches ${cwd}; pass a profile. ${profileList(profiles)}`);
}

/** Profile the current board run belongs to, from CKANBAN_TICKET. */
export function runProfile(env: Record<string, string | undefined> = process.env): string | null {
  const v = env[RUN_ENV];
  return v ? v.split("/")[0] || null : null;
}

/** Board runs may read the board but not change it, so a run can't create or start other runs. */
export function assertCanChange(env: Record<string, string | undefined> = process.env): void {
  if (env[RUN_ENV]) {
    throw new ClientError(
      `changing the board is disabled inside a board run (${RUN_ENV}=${env[RUN_ENV]}), so runs can't create or start other runs. ` +
      "Reading tickets still works; ask the user to make this change on the board.",
    );
  }
}

export function parseStatus(s: unknown): Status {
  const v = String(s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((STATUSES as string[]).includes(v)) return v as Status;
  throw new ClientError(`invalid status "${s}"; use one of: ${STATUSES.join(", ")}`);
}

export function parseMode(s: unknown): TicketMode {
  const v = String(s ?? "").trim().toLowerCase();
  if (v === "interview" || v === "auto") return v;
  throw new ClientError(`invalid mode "${s}"; use interview or auto`);
}

function state(t: TicketInfo): string {
  const bits: string[] = [t.status];
  if (t.running) bits.push("running");
  else if (t.outcome) bits.push(t.outcome);
  if (t.attention?.kind && !t.running) bits.push(`waiting: ${t.attention.kind}`);
  return bits.join(", ");
}

export function ticketLine(t: TicketInfo): string {
  const extra = [t.parentId ? `in plan ${t.parentId}` : null, t.needs?.length ? `needs ${t.needs.join(", ")}` : null].filter(Boolean);
  return `${t.id}  [${state(t)}]  ${t.important ? "⭐ " : ""}${t.title}${extra.length ? `  (${extra.join("; ")})` : ""}`;
}

export function ticketText(t: TicketInfo, comments: CommentInfo[] = []): string {
  const lines = [
    `${t.title}`,
    `id: ${t.id}`,
    `status: ${state(t)}`,
    `mode: ${t.mode ?? "auto"}`,
  ];
  if (t.scheduleId) lines.push(`schedule: ${t.scheduleId} (created by this schedule; see list_schedules)`);
  if (t.parentId) lines.push(`plan: child of ${t.parentId}${t.planKey ? ` (key ${t.planKey})` : ""}`);
  if (t.dependsOn?.length) lines.push(`depends on: ${t.dependsOn.join(", ")}`);
  if (t.needs?.length) {
    const r = t.resources;
    const now = r?.holding ? " (in use by this ticket)" : r?.waitingFor.length ? ` (waiting for ${r.waitingFor.join(", ")})` : "";
    lines.push(`needs: ${t.needs.join(", ")}${now}`);
  }
  if (t.userWait) lines.push(`waiting on the user: ${t.userWait}`);
  if (t.branch) lines.push(`branch: ${t.branch}`);
  if (t.prUrl) lines.push(`pr: ${t.prUrl}`);
  if (t.lastActivity) lines.push(`activity: ${t.lastActivity}`);
  if (t.error) lines.push(`error: ${t.error}`);
  lines.push("", t.body.trim() || "(no description)");
  if (comments.length) {
    lines.push("", "Comments:");
    for (const c of comments) lines.push(`- ${c.author} (${c.at}): ${c.text}`);
  }
  return lines.join("\n");
}

/** What a bug report did, for the CLI and MCP: the issue URL, or the browser link to finish it. */
export function bugReportText(r: BugReportReply): string {
  const shots = r.screenshots.length
    ? `\n${r.screenshots.length} screenshot(s) from the ticket were not uploaded; ask the user to drag them into a comment on the issue.`
    : "";
  if (r.url) return `Created ${r.url}${shots}`;
  return `Could not create the issue: ${r.error}\nOpen this link to file it in the browser instead (title and body are prefilled):\n${r.fallbackUrl}${shots}`;
}
