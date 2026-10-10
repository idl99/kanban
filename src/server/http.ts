import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, normalize } from "node:path";
import { runArtifactJob, type ArtifactJob, type ArtifactOutcome } from "./artifact";
import { ConflictError, recoveryFor, type Board } from "./board";
import { claudeDefaults, listClaudeProjects, listSessions, liveSessionMatch, pickFolder, processCommands } from "./claude";
import type { Bus, BusEvent } from "./events";
import { listCommands } from "./commands";
import { DiffError, ticketDiff } from "./diff";
import { detectBaseBranch, isGitRepo, resolveBaseBranch, which } from "./git";
import { checkPr, mergePr, PrError, REFRESH_MIN_MS, refreshPr, sendFailures, type PrDeps } from "./prpoller";
import { resumeCommand } from "./prompts";
import { cronError, describeCron, nextRuns, parseCron } from "./cron";
import { RUN_HEADER, ScheduleError, Scheduler } from "./scheduler";
import { SnippetError, Snippets } from "./snippets";
import { QuestionError, Questions } from "./questions";
import { HuddleError, Huddles, type Caller } from "./huddle";
import { HuddleSessionCache, participantSession, participantTool } from "./huddle-session";
import { HUDDLE_HEADER, SOURCE_HEADER } from "./huddle-roster";
import { NOTES_CAP } from "./huddle-notes";
import { byWaitingAge, huddleAsk, huddleBusy, ticketAttention, userWaitReason } from "./attention";
import { isComplete, MAX_RETRIES, planActive } from "./plan";
import { BugReportError, draftReport, submitReport, type BugBlockId, type BugSource, type GhRunner } from "./bugreport";
import { AttachmentError, attachmentFile, attachmentType, IMAGE_TYPES, saveAttachment } from "./attachments";
import { FileError, listDir, openWithSystem, readFileForView } from "./files";
import { McpError, McpManager } from "./mcp";
import { AGENT_IDS, AgentError, AgentRegistry, type AgentId } from "./agents";
import { SessionCache } from "./session";
import { ptySupported, ShellManager, type PtyKind, type Shell } from "./shell";
import { AGENT_STEP_TAIL, settleAgent } from "./subagents";
import type { TerminalWatcher } from "./terminals";
import { attachmentHeader, canCopyFile, copyFileToClipboard, markdownPage, markdownTitle, revealFile, ShareError } from "./share";
import { UpdateChecker } from "./update";
import { ClaudeLogIndex, readWindows, recordWindow, ticketRuns, ticketUsage, UsageCache, windowsNeeded } from "./ticket-usage";
import { fetchUsage, type UsageResult } from "./usage";
import type { Store } from "./store";
import { STATUSES, type Profile, type ScheduleEditor, type Status, type Ticket } from "./types";
import { nowIso, slugify } from "./util";
import { applyDetection, detectSetup } from "./worktree-setup";

export interface ServerDeps {
  store: Store;
  bus: Bus;
  board: Board;
  port: number;
  webDir: string;
  /** gh stand-ins for the PR box (tests). */
  pr?: PrDeps;
  /** URL path → embedded file (standalone binary). When non-empty, used instead of webDir. */
  assets?: Record<string, string>;
  sessions?: SessionCache;
  updates?: UpdateChecker;
  terminals?: TerminalWatcher;
  shells?: ShellManager;
  mcp?: McpManager;
  scheduler?: Scheduler;
  agents?: AgentRegistry;
  questions?: Questions;
  huddles?: Huddles;
  /** Restart the daemon once no run is active (POST /api/restart); missing when not running as the daemon. */
  restart?: () => { running: number; alreadyPending: boolean };
  /** Runs `gh` for bug reports (tests pass a fake). */
  gh?: GhRunner;
  /** Claude plan usage for the header pill (tests pass a fake). */
  usage?: () => Promise<UsageResult>;
  /** Machine-wide Claude Code cost, for a ticket's share of the 5h window (tests pass one on a fixture folder). */
  claudeLogs?: ClaudeLogIndex;
  /** Publishes output files as claude.ai pages (tests pass a fake). */
  publishArtifact?: (job: ArtifactJob) => Promise<ArtifactOutcome>;
}

/** A Share menu publish in progress, or the error of the last one, per output file. Not persisted. */
interface ShareJob {
  file: string;
  state: "publishing" | "failed";
  error?: string;
  at: string;
}

interface ShellSocket {
  kind: PtyKind;
  slug: string;
  /** Profile display name (the quick chat tells Claude which board it is on). */
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  shell?: Shell;
  unsubscribe?: () => void;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
const DEFAULT_MAX_PARALLEL = 5;
/** Output extensions served with their image type (raster only) so the Outputs tab can preview them. */
const OUTPUT_IMAGE_TYPES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(IMAGE_TYPES).map(([t, e]) => [e, t])),
  jpeg: "image/jpeg",
};

export function isAllowedRequest(req: Request, port: number): boolean {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (!LOCAL_HOSTS.some((h) => host === `${h}:${port}`)) return false;
  const origin = req.headers.get("origin");
  if (req.method !== "GET" && req.method !== "HEAD" && origin) {
    if (!LOCAL_HOSTS.some((h) => origin === `http://${h}:${port}`)) return false;
  }
  return true;
}

/** WebSocket upgrades are GETs, so they need their own Origin check (browsers always send one). */
export function isAllowedSocket(req: Request, port: number): boolean {
  const origin = req.headers.get("origin");
  return isAllowedRequest(req, port) && !!origin && LOCAL_HOSTS.some((h) => origin === `http://${h}:${port}`);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function body(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export function createServer(deps: ServerDeps) {
  const { store, bus, board } = deps;
  const sessions = deps.sessions ?? new SessionCache();
  const huddleSessions = new HuddleSessionCache();
  const updates = deps.updates ?? new UpdateChecker();
  const shells = deps.shells ?? new ShellManager();
  const mcp = deps.mcp ?? new McpManager(bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude" });
  const scheduler = deps.scheduler ?? new Scheduler(board, store, bus);
  const agents = deps.agents ?? new AgentRegistry();
  const questions = deps.questions ?? new Questions(store, board);
  const huddles = deps.huddles ?? new Huddles(store, board, bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude" });
  const snippets = new Snippets(store, bus);
  const windowsFile = join(store.root, "usage-windows.json");
  const usage = new UsageCache(deps.usage ?? fetchUsage, (r) => recordWindow(windowsFile, r));
  const claudeLogs = deps.claudeLogs ?? new ClaudeLogIndex();
  const publishArtifact = deps.publishArtifact ?? ((job: ArtifactJob) => runArtifactJob(job));
  // "<profile>/<ticket>" -> jobs by output file.
  const shareJobs = new Map<string, Map<string, ShareJob>>();

  const profileOr404 = (slug: string): Profile => {
    const p = store.getProfile(slug);
    if (!p) throw new HttpError(404, `profile ${slug} not found`);
    return p;
  };
  const ticketOr404 = (slug: string, id: string): Ticket => {
    const t = store.getTicket(slug, id);
    if (!t) throw new HttpError(404, `ticket ${id} not found`);
    return t;
  };
  /**
   * Board runs send RUN_HEADER ("<profile>/<ticket id>") with ticket changes. Runs can't change the board, except:
   * - a Planning chat answering the user's message (Board.userRequestRights) acts for the user on any ticket of its
   *   board but its own: returned as `requester`;
   * - a planner on its own child tickets: any run of a running plan, or a reply to the user's message in the
   *   planner's chat (Board.plannerRights): returned as `planner`.
   * Returns {} for the user. Huddle agents run as their host ticket but get neither.
   */
  const runRights = (req: Request, slug: string, target?: Ticket): { planner?: Ticket; requester?: Ticket } => {
    const h = req.headers.get(RUN_HEADER);
    if (!h) return {};
    const [runSlug, runId] = h.split("/");
    const mine = runSlug === slug && !!runId && !req.headers.get(HUDDLE_HEADER);
    const requester = mine ? board.userRequestRights(slug, runId) : null;
    if (requester) {
      if (target?.id === requester.id) {
        throw new HttpError(403, `${target.id} is this Planning chat's own ticket: ask the user to move, edit or stop it themselves ` +
          "(changing it from here would end this reply or start its work)");
      }
      return { requester };
    }
    const planner = mine ? board.plannerRights(slug, runId) : null;
    if (!planner) {
      throw new HttpError(403, "changing the board is disabled inside a board run, so runs can't create or start other runs; " +
        "only a Planning chat answering the user's message may change other tickets, and a planner its own child tickets: " +
        "while its plan runs, or when the user asked for it in the planner's own chat");
    }
    if (target && target.parentId !== planner.id) {
      throw new HttpError(403, `${target.id} is not a child ticket of plan ${planner.id}; the planner may only change its own child tickets`);
    }
    return { planner };
  };
  /** How a change made for the user from a Planning chat is credited on the changed ticket. */
  const byRequest = (requester: Ticket) => `by the Planning chat of ${requester.id} (user request)`;
  /** The board run's ticket (RUN_HEADER), null outside runs; a run may only reach tickets on its own board. */
  const runTicket = (req: Request, slug: string): string | null => {
    const h = req.headers.get(RUN_HEADER);
    if (!h) return null;
    const [runSlug, runId] = h.split("/");
    if (runSlug !== slug || !runId) throw new HttpError(403, `tickets can only talk to tickets on their own board (${runSlug})`);
    return runId;
  };
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : undefined;
  /** hosts: the board's open huddles by host ticket, when the caller already has them (one read per board). */
  const view = (p: Profile, t: Ticket, hosts = board.hostHuddles(p.slug)) => {
    const running = board.isRunning(p.slug, t.id);
    const session = t.sessionId ? sessions.summary(t.sessionId) : null;
    const huddle = hosts.get(t.id);
    return {
      ...t,
      running,
      /** Its run takes one of the board's maxParallel slots (Planning and peer replies don't). */
      holdsSlot: running && board.holdsSlot(p.slug, t.id),
      resumeCommand: t.sessionId ? resumeCommand(t.workdir ?? t.worktree ?? p.path, t.sessionId) : null,
      session,
      /** Absolute outputs folder, so the Share menu can show where a file is. */
      outputDir: store.outputsPath(p.slug, t.id),
      shareJobs: [...(shareJobs.get(`${p.slug}/${t.id}`)?.values() ?? [])],
      canCopyFile: canCopyFile() || !!process.env.CKANBAN_OSASCRIPT_BIN,
      /** Linked session is open in a terminal right now (board chat still works, UI warns). */
      terminalOpen: deps.terminals?.isOpen(p.slug, t.id) ?? false,
      /** The last run's error has a one-click fix (Start fresh session / Take over here). */
      recovery: running ? null : recoveryFor(t.error),
      /** Ticket.needs: holds them now, or which ones another ticket holds while this one would start. */
      resources: board.resourceState(p.slug, t),
      /** A plan child waiting on the user (never started by the plan until then). */
      userWait: t.parentId && !isComplete(t) ? userWaitReason(t, session) : null,
      attention: ticketAttention(store, p.slug, t, session, running, huddle),
      /** Its own huddle is working on it: the card shows "Huddle · n working" instead of an outcome badge. */
      huddleBusy: !running && t.status !== "in_progress" && huddleBusy(huddle) && !huddleAsk(huddle),
    };
  };

  const emitTicket = (slug: string, id: string) => {
    const t = store.getTicket(slug, id);
    if (t) bus.emit({ type: "ticket.updated", profile: slug, ticket: t });
  };

  /**
   * Publish an output file as a claude.ai page in the background (the helper takes a minute or two).
   * Markdown is rendered to a standalone page first. Publishing the same file again updates its link.
   */
  function startPublish(slug: string, id: string, name: string, file: string): ShareJob {
    const key = `${slug}/${id}`;
    const jobs = shareJobs.get(key) ?? new Map<string, ShareJob>();
    shareJobs.set(key, jobs);
    if (jobs.get(name)?.state === "publishing") throw new HttpError(409, "this file is already being published");
    const job: ShareJob = { file: name, state: "publishing", at: nowIso() };
    jobs.set(name, job);
    emitTicket(slug, id);
    const fail = (error: string) => {
      jobs.set(name, { file: name, state: "failed", error, at: nowIso() });
      emitTicket(slug, id);
    };
    (async () => {
      let tmp: string | null = null;
      try {
        const existing = store.getTicket(slug, id)?.shareLinks?.find((l) => l.file === name)?.url;
        let page = file;
        let title: string | undefined;
        if (/\.(md|markdown)$/i.test(name)) {
          const md = readFileSync(file, "utf8");
          const dir = join(store.root, "share-tmp");
          mkdirSync(dir, { recursive: true });
          tmp = page = join(dir, `${crypto.randomUUID()}.html`);
          writeFileSync(tmp, markdownPage(md, name));
          title = markdownTitle(md, name);
        } else if (!/\.html?$/i.test(name)) {
          return fail("only Markdown and HTML files can be published");
        }
        const r = await publishArtifact({ kind: "publish", file: page, ...(existing ? { url: existing } : {}), ...(title ? { title } : {}) });
        if (!r.ok) return fail(r.error);
        if (r.kind !== "publish") return fail("unexpected helper result");
        const t = store.getTicket(slug, id);
        if (!t) return;
        const links = (t.shareLinks ?? []).filter((l) => l.file !== name);
        jobs.delete(name);
        store.updateTicket(slug, id, { shareLinks: [...links, { file: name, url: r.url, at: nowIso() }] });
        emitTicket(slug, id);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      } finally {
        if (tmp) rmSync(tmp, { force: true });
      }
    })();
    return job;
  }

  async function api(req: Request, url: URL): Promise<Response | undefined> {
    const parts = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
    const m = req.method;
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

    // Image uploads send the raw bytes. image/* types are not CORS-safelisted, so they preflight like JSON does.
    if (parts[0] === "attachments") {
      if (m === "POST" && parts.length === 1) {
        if (!IMAGE_TYPES[type]) throw new HttpError(415, "only PNG, JPEG, GIF and WebP images are supported");
        try {
          const name = saveAttachment(store.attachmentsDir, type, new Uint8Array(await req.arrayBuffer()));
          return json({ url: `/api/attachments/${name}`, path: join(store.attachmentsDir, name) }, 201);
        } catch (e) {
          if (e instanceof AttachmentError) throw new HttpError(e.status, e.message);
          throw e;
        }
      }
      if (m === "GET" && parts.length === 2) {
        const file = attachmentFile(store.attachmentsDir, parts[1]);
        if (!file) throw new HttpError(404, "attachment not found");
        return new Response(Bun.file(file), {
          headers: {
            "content-type": attachmentType(parts[1])!,
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox",
            "cache-control": "private, max-age=31536000, immutable",
          },
        });
      }
      throw new HttpError(404, "not found");
    }

    // Only JSON mutations: blocks HTML <form> posts (text/plain, urlencoded) that skip CORS preflight.
    if ((m === "POST" || m === "PATCH" || m === "PUT") && type !== "application/json") {
      throw new HttpError(415, "content-type must be application/json");
    }

    if (parts[0] === "health" && m === "GET") {
      const [claude, git, gh] = await Promise.all([
        which(process.env.CKANBAN_CLAUDE_BIN ?? "claude"), which("git"), which("gh"),
      ]);
      return json({ claude, git, gh, pty: ptySupported() });
    }

    if (parts[0] === "events" && m === "GET") return sse(req);
    if (parts[0] === "version" && m === "GET") return json(await updates.status());
    if (parts[0] === "usage" && m === "GET") return json(await usage.get(0));
    // How every teammate (huddle preset) and template was used, from the huddles on every board.
    if (parts[0] === "team-usage" && m === "GET") return json(huddles.usage());
    if (parts[0] === "inbox" && m === "GET") {
      // Every board: tickets that need the user (the same rule as the cards' "Your turn"), oldest first.
      const out = [];
      for (const p of store.listProfiles()) {
        const hosts = board.hostHuddles(p.slug);
        for (const t of store.listTickets(p.slug)) {
          const att = view(p, t, hosts).attention;
          if (att) out.push({ profile: p.slug, profileName: p.name, id: t.id, title: t.title, attention: att });
        }
      }
      return json(out.sort(byWaitingAge));
    }

    if (parts[0] === "tickets" && parts.length === 1 && m === "GET") {
      // ⌘K command bar: a light row per ticket on every board (search runs in the browser). Long texts are
      // capped: the bar only needs enough to find a word and show a snippet around it.
      const cap = (s: string | null) => (s && s.length > 4000 ? s.slice(0, 4000) : s ?? "");
      const out = [];
      for (const p of store.listProfiles()) {
        for (const t of store.listTickets(p.slug)) {
          out.push({
            profile: p.slug, profileName: p.name, id: t.id, title: t.title, status: t.status,
            running: board.isRunning(p.slug, t.id), updatedAt: t.updatedAt,
            body: cap(t.body), summary: cap(store.lastAiComment(p.slug, t.id)), prUrl: t.prUrl,
          });
        }
      }
      return json(out);
    }

    // Connections panel: Claude Code MCP servers (always from the home dir, user scope for edits).
    if (parts[0] === "mcp") {
      const name = parts[1];
      if (parts.length === 1 && m === "GET") return json(mcp.state());
      if (parts.length === 1 && m === "POST") {
        await mcp.add(await body(req));
        return json(mcp.state(), 201);
      }
      if (parts.length === 2 && name === "refresh" && m === "POST") {
        mcp.refresh();
        return json(mcp.state(), 202);
      }
      if (parts.length === 2 && m === "DELETE") {
        await mcp.remove(name);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "login") {
        mcp.login(name);
        return json(mcp.state(), 202);
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "cancel-login") {
        mcp.cancelLogin(name);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "logout") {
        await mcp.logout(name);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "recheck") {
        const s = await mcp.recheck(name);
        if (!s) throw new HttpError(502, `couldn't check ${name}; try Refresh`);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "GET" && parts[2] === "config") return json(mcp.config(name));
      if (parts.length === 2 && m === "PUT") {
        await mcp.update(name, await body(req));
        return json(mcp.state());
      }
      throw new HttpError(404, "not found");
    }

    // Connections panel: is `ckanban mcp` registered with Claude Code / Codex, and (un)register it.
    if (parts[0] === "agents") {
      if (parts.length === 1 && m === "GET") return json(await agents.status());
      const id = parts[1] as AgentId;
      if (parts.length === 3 && m === "POST" && AGENT_IDS.includes(id) && (parts[2] === "install" || parts[2] === "uninstall")) {
        await (parts[2] === "install" ? agents.install(id) : agents.uninstall(id));
        if (id === "claude") mcp.refresh();
        return json(await agents.status());
      }
      throw new HttpError(404, "not found");
    }

    // Prompt snippets: GET ?profile=<slug> returns global ones plus that board's.
    if (parts[0] === "snippets") {
      if (parts.length === 1 && m === "GET") return json(snippets.list(url.searchParams.get("profile") ?? undefined));
      if (parts.length === 1 && m === "POST") return json(snippets.create((await body(req)) ?? {}), 201);
      if (parts.length === 2 && m === "PATCH") return json(snippets.update(parts[1], (await body(req)) ?? {}));
      if (parts.length === 2 && m === "DELETE") {
        snippets.remove(parts[1]);
        return new Response(null, { status: 204 });
      }
      throw new HttpError(404, "not found");
    }

    // Schedule form preview: is the expression valid, what it means, when it fires next.
    if (parts[0] === "cron" && parts[1] === "preview" && parts.length === 2 && m === "GET") {
      const expr = (url.searchParams.get("expr") ?? "").trim();
      const error = expr ? cronError(expr) : "cron expression is required";
      if (error) return json({ valid: false, error, summary: null, next: [] });
      return json({ valid: true, error: null, summary: describeCron(expr), next: nextRuns(parseCron(expr), new Date(), 3).map((d) => d.toISOString()) });
    }

    if (parts[0] === "claude" && parts[1] === "projects" && m === "GET") {
      const taken = new Set(store.listProfiles().map((p) => p.path));
      return json(listClaudeProjects().map((p) => ({ ...p, hasProfile: taken.has(p.path) })));
    }
    if (parts[0] === "claude" && parts[1] === "defaults" && m === "GET") return json(claudeDefaults());
    if (parts[0] === "pick-folder" && m === "POST") return json({ path: await pickFolder() });
    if (parts[0] === "restart" && parts.length === 1) {
      if (m === "GET") return json(board.restartState());
      if (m === "POST") {
        if (!deps.restart) throw new HttpError(501, "restart is only available on the daemon");
        return json(deps.restart());
      }
    }

    // Report bug: context preview, then file a GitHub issue on the ckanban repo.
    if (parts[0] === "bug-report" && m === "POST" && parts.length <= 2) {
      const b = await body(req);
      const ref = b.ticketId ? { slug: String(b.profile ?? ""), id: String(b.ticketId) } : null;
      try {
        const draft = draftReport(store, ref);
        if (parts[1] === "draft") return json(draft);
        if (parts.length !== 1) throw new HttpError(404, "not found");
        const source: BugSource = b.source === "ai" || b.source === "cli" ? b.source : "ui";
        const include = Array.isArray(b.include) ? (b.include.map(String) as BugBlockId[]) : undefined;
        const r = await submitReport(
          { title: String(b.title ?? ""), description: String(b.description ?? ""), blocks: draft.blocks, include, source },
          { dataRoot: store.root, gh: deps.gh },
        );
        return json(r, r.url ? 201 : 200);
      } catch (e) {
        if (e instanceof BugReportError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }

    if (parts[0] !== "profiles") throw new HttpError(404, "not found");

    // /profiles
    if (parts.length === 1) {
      if (m === "GET") {
        return json(store.listProfiles().map((p) => ({ ...p, pathExists: existsSync(p.path), running: board.running(p.slug) })));
      }
      if (m === "POST") {
        const b = await body(req);
        const name = String(b.name ?? "").trim();
        const path = String(b.path ?? "").trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
        if (!name) throw new HttpError(400, "name is required");
        if (!path || !existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, `path is not a directory: ${path}`);
        let slug = slugify(name);
        for (let i = 2; store.getProfile(slug); i++) slug = `${slugify(name)}-${i}`;
        const profile: Profile = {
          name, slug, path,
          // Empty when there is nothing to branch from yet (not a repo, or no commits); runs re-detect it.
          baseBranch: b.baseBranch || ((await isGitRepo(path)) ? (await resolveBaseBranch(path, await detectBaseBranch(path))) ?? "" : ""),
          maxParallel: Math.max(1, Number(b.maxParallel) || DEFAULT_MAX_PARALLEL),
          model: b.model || null,
          createdAt: nowIso(),
        };
        const saved = applyDetection(profile, await detectSetup(path));
        store.saveProfile(saved);
        bus.emit({ type: "profile.updated", slug, profile: saved });
        return json(saved, 201);
      }
    }

    const slug = parts[1];
    const profile = profileOr404(slug);

    // /profiles/:p
    if (parts.length === 2) {
      if (m === "GET") return json(profile);
      if (m === "PATCH") {
        const b = await body(req);
        const next: Profile = { ...profile };
        if (b.name !== undefined) next.name = String(b.name);
        if (b.path !== undefined) next.path = String(b.path);
        if (b.baseBranch !== undefined) next.baseBranch = String(b.baseBranch);
        if (b.maxParallel !== undefined) next.maxParallel = Math.max(1, Number(b.maxParallel) || 1);
        if (b.model !== undefined) next.model = b.model || null;
        if (b.copyFiles !== undefined) {
          if (!Array.isArray(b.copyFiles)) throw new HttpError(400, "copyFiles must be a list of paths");
          next.copyFiles = [...new Set(b.copyFiles.map((f: unknown) => String(f).trim()).filter(Boolean))] as string[];
        }
        if (b.setupCommand !== undefined) next.setupCommand = String(b.setupCommand ?? "").trim();
        if (b.cleanupCommand !== undefined) next.cleanupCommand = String(b.cleanupCommand ?? "").trim();
        if (b.setupDetected !== undefined) next.setupDetected = b.setupDetected && typeof b.setupDetected === "object" ? b.setupDetected : null;
        if (next.path !== profile.path) shells.kill(slug);
        store.saveProfile(next);
        bus.emit({ type: "profile.updated", slug, profile: next });
        board.dispatch(slug);
        return json(next);
      }
      if (m === "DELETE") {
        if (board.running(slug) > 0) throw new HttpError(409, "profile has running tickets");
        store.deleteProfile(slug);
        snippets.dropScope(slug);
        shells.kill(slug);
        bus.emit({ type: "profile.updated", slug, profile: null });
        return new Response(null, { status: 204 });
      }
    }

    // /profiles/:p/detect-setup — what worktree setup detection finds now (the settings dialog decides what to save)
    if (parts[2] === "detect-setup" && parts.length === 3 && m === "POST") return json(await detectSetup(profile.path));

    // /profiles/:p/commands — skills and commands in the profile folder (the `/` picker of new ticket and schedule descriptions)
    if (parts[2] === "commands" && parts.length === 3 && m === "GET") {
      return json(listCommands(profile.path, { projects: [profile.path] }).map(({ local, ...c }) => c));
    }

    // /profiles/:p/sessions — Claude Code sessions started in the profile folder
    if (parts[2] === "sessions" && parts.length === 3 && m === "GET") {
      const commands = await processCommands();
      const linked = new Map(store.listTickets(slug).filter((t) => t.sessionId).map((t) => [t.sessionId!, t]));
      return json(listSessions(profile.path).map((s) => ({
        ...s,
        live: liveSessionMatch(commands, s),
        ticket: linked.has(s.id) ? { id: linked.get(s.id)!.id, title: linked.get(s.id)!.title } : null,
      })));
    }

    // /profiles/:p/files?path= (one directory level) and /profiles/:p/file?path= (read-only contents)
    if ((parts[2] === "files" || parts[2] === "file") && parts.length === 3 && m === "GET") {
      const rel = url.searchParams.get("path") ?? "";
      try {
        if (parts[2] === "files") return json({ path: rel, entries: await listDir(profile.path, rel) });
        return json(readFileForView(profile.path, rel));
      } catch (e) {
        if (e instanceof FileError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    // /profiles/:p/open-file { path } — open a file from the explorer in its default app
    if (parts[2] === "open-file" && parts.length === 3 && m === "POST") {
      const rel = String((await body(req)).path ?? "");
      try {
        openWithSystem(profile.path, rel, process.env.CKANBAN_OPEN_BIN);
      } catch (e) {
        if (e instanceof FileError) throw new HttpError(e.status, e.message);
        throw e;
      }
      return json({ ok: true });
    }

    // /profiles/:p/shell — WebSocket to the profile's interactive shell
    if (parts[2] === "shell" && parts.length === 3 && m === "GET") {
      if (!ptySupported()) throw new HttpError(501, `terminal needs Bun 1.3.5 or newer (running ${Bun.version})`);
      if (!isAllowedSocket(req, server.port ?? deps.port)) throw new HttpError(403, "forbidden");
      const dim = (k: string, d: number) => Math.min(1000, Math.max(1, Number(url.searchParams.get(k)) || d));
      const data: ShellSocket = { kind: "shell", slug, name: profile.name, cwd: profile.path, cols: dim("cols", 80), rows: dim("rows", 24) };
      if (server.upgrade(req, { data })) return undefined;
      throw new HttpError(400, "expected a WebSocket upgrade");
    }

    // /profiles/:p/claude — WebSocket to the dock's quick Claude chat (interactive `claude` in the profile folder)
    if (parts[2] === "claude" && parts.length === 3 && m === "GET") {
      if (!ptySupported()) throw new HttpError(501, `terminal needs Bun 1.3.5 or newer (running ${Bun.version})`);
      if (!isAllowedSocket(req, server.port ?? deps.port)) throw new HttpError(403, "forbidden");
      const dim = (k: string, d: number) => Math.min(1000, Math.max(1, Number(url.searchParams.get(k)) || d));
      const data: ShellSocket = { kind: "claude", slug, name: profile.name, cwd: profile.path, cols: dim("cols", 80), rows: dim("rows", 24) };
      if (server.upgrade(req, { data })) return undefined;
      throw new HttpError(400, "expected a WebSocket upgrade");
    }

    // /profiles/:p/claude/session — which Claude session the quick chat runs, and whether it has messages yet
    if (parts[2] === "claude" && parts[3] === "session" && parts.length === 4 && m === "GET") {
      const pty = shells.current(slug, "claude");
      const id = pty?.sessionId ?? null;
      const summary = id ? sessions.summary(id) : null;
      return json({ sessionId: id, running: !!pty && !pty.exited, started: !!summary, title: summary?.title ?? null });
    }

    // /profiles/:p/schedules — recurring ticket templates
    if (parts[2] === "schedules") {
      // Set by the ckanban MCP tools inside a board run ("<profile>/<ticket id>"): the edit is credited to that ticket.
      const run = req.headers.get(RUN_HEADER)?.split("/")[1] ?? "";
      const by: ScheduleEditor = /^t_[a-z0-9_]+$/i.test(run) ? { ticketId: run } : "user";
      if (parts.length === 3 && m === "GET") return json(store.listSchedules(slug).map((s) => scheduler.view(slug, s)));
      if (parts.length === 3 && m === "POST") return json(scheduler.view(slug, scheduler.create(slug, (await body(req)) ?? {}, by)), 201);
      const sid = parts[3];
      if (parts.length === 4 && m === "PATCH") return json(scheduler.view(slug, scheduler.update(slug, sid, (await body(req)) ?? {}, by)));
      if (parts.length === 4 && m === "DELETE") {
        scheduler.remove(slug, sid, by);
        return new Response(null, { status: 204 });
      }
      if (parts.length === 5 && parts[4] === "history" && m === "GET") return json(scheduler.history(slug, sid));
      if (parts.length === 5 && parts[4] === "run" && m === "POST") {
        const entry = await scheduler.runNow(slug, sid);
        return json({ entry, schedule: scheduler.view(slug, scheduler.get(slug, sid)) });
      }
      throw new HttpError(404, "not found");
    }

    // /profiles/:p/questions/:q/(poll|reply) — ticket-to-ticket questions (ask_ticket / reply_ticket)
    if (parts[2] === "questions" && parts.length === 5 && m === "POST") {
      const b = await body(req);
      const runId = runTicket(req, slug);
      if (parts[4] === "poll") {
        if (!runId) throw new HttpError(403, "only the asking ticket's run can wait for a reply");
        return json(questions.poll(slug, parts[3], runId, !!b.final));
      }
      if (parts[4] === "reply") return json(await questions.reply(slug, parts[3], runId, String(b.text ?? "")));
      throw new HttpError(404, "not found");
    }

    // /profiles/:p/huddle-presets[/:name] — huddle role presets ("teammates"): built-ins merged with the global ones and
    // the board's own. Anyone reads; only the user saves or deletes (the Team tab, a proposal card, the CLI). A run (a
    // huddle agent's or a ticket's, the coordinator included) proposes one with propose_teammate instead. Body `scope`:
    // "board" (default) or "global" (every board); DELETE ?scope= defaults to the level in effect.
    if (parts[2] === "huddle-presets") {
      if (parts.length === 3 && m === "GET") return json(huddles.presets(slug));
      if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) {
        throw new HttpError(403, m === "DELETE"
          ? "a board or huddle run can't delete or reset teammates; ask the user"
          : "a board or huddle run can't save teammates; propose one with propose_teammate and the user saves it with one click");
      }
      if (parts.length === 3 && m === "POST") {
        const b = await body(req);
        return json(huddles.savePreset(slug, b, b?.scope ?? "board"), 201);
      }
      if (parts.length === 4 && m === "PUT") {
        const b = await body(req);
        return json(huddles.savePreset(slug, { ...b, name: parts[3] }, b?.scope ?? "board"));
      }
      if (parts.length === 4 && m === "DELETE") return json(huddles.deletePreset(slug, parts[3], url.searchParams.get("scope") ?? undefined));
      throw new HttpError(404, "not found");
    }

    // /profiles/:p/huddle-templates[/:name] — whole-huddle templates (roster and rules), levels as for presets. Anyone
    // reads; only the user changes them.
    if (parts[2] === "huddle-templates") {
      if (parts.length === 3 && m === "GET") return json(huddles.templates(slug));
      if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user changes huddle templates (the Team tab)");
      if (parts.length === 3 && m === "POST") {
        const b = await body(req);
        return json(huddles.saveTemplate(slug, b, b?.scope ?? "board"), 201);
      }
      if (parts.length === 4 && m === "PUT") {
        const b = await body(req);
        return json(huddles.saveTemplate(slug, { ...b, name: parts[3] }, b?.scope ?? "board"));
      }
      if (parts.length === 4 && m === "DELETE") return json(huddles.deleteTemplate(slug, parts[3], url.searchParams.get("scope") ?? undefined));
      throw new HttpError(404, "not found");
    }

    // /profiles/:p/huddle-notes[/:role/:scope] — role notes from past huddles (huddle-notes.ts). Anyone reads; only the
    // user writes them, so no agent can change what future agents are told.
    if (parts[2] === "huddle-notes") {
      if (parts.length === 3 && m === "GET") return json({ notes: huddles.notes(slug), cap: NOTES_CAP });
      if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user changes huddle role notes (the Team tab)");
      if (parts.length === 5 && m === "PUT") return json(huddles.setNotes(slug, parts[3], parts[4], (await body(req))?.notes));
      throw new HttpError(404, "not found");
    }

    // /profiles/:p/huddles — shared rooms where several Claude sessions work on a ticket (see huddle.ts)
    if (parts[2] === "huddles") return huddleApi(req, url, slug, parts.slice(3));

    // /profiles/:p/tickets
    if (parts[2] !== "tickets") throw new HttpError(404, "not found");
    if (parts.length === 3) {
      if (m === "GET") {
        const hosts = board.hostHuddles(slug);
        return json(store.listTickets(slug).map((t) => view(profile, t, hosts)));
      }
      if (m === "POST") {
        const b = await body(req);
        const title = String(b.title ?? "").trim();
        if (!title) throw new HttpError(400, "title is required");
        const { planner, requester } = runRights(req, slug);
        let status: Status = STATUSES.includes(b.status) ? b.status : "backlog";
        let mode: "auto" | "interview" = b.mode === "auto" ? "auto" : "interview";
        let parentId = typeof b.parentId === "string" && b.parentId ? b.parentId : undefined;
        const planKey = typeof b.planKey === "string" && b.planKey.trim() ? b.planKey.trim() : undefined;
        const dependsOn = strings(b.dependsOn);
        const needs = strings(b.needs);
        if (planner) {
          // A planner adds children to its own plan; the board starts them when their dependencies are done.
          const kids = store.listTickets(slug).filter((c) => c.parentId === planner.id);
          const running = planActive(planner.plan);
          // Unattended plans are capped; in the user's chat the user is there to stop it.
          const cap = running ? 2 * Math.max(1, planner.plan!.originalCount) : Infinity;
          if (kids.length >= cap) throw new HttpError(409, `child ticket limit reached (${cap}) for this plan`);
          const missing = (dependsOn ?? []).filter((d) => !kids.some((k) => k.id === d || k.planKey === d));
          if (missing.length) throw new HttpError(400, `unknown dependency ${missing.join(", ")}: use a sibling's ticket id or key`);
          // Children wait in Backlog until the plan starts them; a running plan's children skip the interview.
          [parentId, status] = [planner.id, "backlog"];
          if (running) mode = "auto";
        }
        if (parentId && !store.getTicket(slug, parentId)) throw new HttpError(400, `parent ticket ${parentId} not found`);
        let t = await board.createTicket(slug, {
          title, body: String(b.body ?? ""), status: b.sessionId && !planner ? "backlog" : status, mode, parentId, planKey, dependsOn, needs,
        });
        if (planner) store.addComment(slug, t.id, "ai", `Created by the planner of plan ${planner.id}.`);
        if (requester) store.addComment(slug, t.id, "ai", `Created ${byRequest(requester)}.`);
        if (b.sessionId && !planner) {
          try {
            await board.linkSession(slug, t.id, String(b.sessionId));
            t = await board.updateTicket(slug, t.id, { status });
          } catch (e) {
            await board.deleteTicket(slug, t.id);
            throw new HttpError(400, (e as Error).message);
          }
        }
        return json(view(profile, store.getTicket(slug, t.id)!), 201);
      }
    }

    const id = parts[3];
    ticketOr404(slug, id);

    if (parts.length === 4) {
      if (m === "GET") return json(view(profile, store.getTicket(slug, id)!));
      if (m === "PATCH") {
        const b = await body(req);
        if (b.status !== undefined && !STATUSES.includes(b.status)) throw new HttpError(400, `invalid status ${b.status}`);
        const target = store.getTicket(slug, id)!;
        const { planner, requester } = runRights(req, slug, target);
        const patch: Parameters<Board["updateTicket"]>[2] = {};
        const deps = strings(b.dependsOn);
        if (deps) patch.dependsOn = deps;
        const needs = strings(b.needs);
        if (needs) patch.needs = needs;
        if (b.parentId === null) patch.parentId = null;
        else if (b.parentId !== undefined) throw new HttpError(400, "parentId can only be cleared (null); use adopt to add a ticket to a plan");
        if (b.mode === "auto" || b.mode === "interview") patch.mode = b.mode;
        if (typeof b.expectedBody === "string") patch.expectedBody = b.expectedBody;
        if (typeof b.title === "string") patch.title = b.title;
        if (typeof b.body === "string") patch.body = b.body;
        if (b.status) patch.status = b.status;
        if (typeof b.order === "number") patch.order = b.order;
        if (b.notice === null) patch.notice = null;
        if (planner || requester) {
          delete patch.order;
          delete patch.notice;
        }
        if (planner) {
          if (patch.status === "ready" && target.status !== "ready" && target.runCount > 0) {
            try {
              board.countRetry(slug, planner.id, id, MAX_RETRIES);
            } catch (e) {
              throw new HttpError(409, (e as Error).message);
            }
          }
        }
        let t: Ticket;
        try {
          t = await board.updateTicket(slug, id, patch);
        } catch (e) {
          if (e instanceof ConflictError) throw e;
          throw new HttpError(400, (e as Error).message);
        }
        const changer = planner ?? requester;
        if (changer) {
          const what = Object.entries(patch)
            .map(([k, v]) => (k === "status" ? `moved it to ${v}` : k === "parentId" ? `released it from plan ${target.parentId}` : `changed ${k}`)).join(", ");
          if (what) store.addComment(slug, id, "ai", planner ? `Planner ${what}.` : `${what[0].toUpperCase()}${what.slice(1)} ${byRequest(changer)}.`);
        }
        return json(view(profile, t));
      }
      if (m === "DELETE") {
        if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "deleting tickets is disabled inside a board run");
        huddles.closeForTicket(slug, id);
        await board.deleteTicket(slug, id);
        return new Response(null, { status: 204 });
      }
    }

    const action = parts[4];
    if (action === "activity" && m === "GET") return json(store.readActivity(slug, id));
    if (action === "usage" && m === "GET") {
      // The usage endpoint rate-limits: a ticket view reuses an answer up to 5 minutes old.
      const plan = await usage.get(5 * 60_000);
      const activity = store.readActivity(slug, id);
      const windows = readWindows(windowsFile);
      const needed = windowsNeeded(ticketRuns(activity), windows);
      if (needed.length) await claudeLogs.refresh(Math.min(...needed.map((w) => Date.parse(w.start))));
      return json(ticketUsage({
        activity, windows, machineCost: (a, b) => claudeLogs.costBetween(a, b), windowError: "error" in plan ? plan.error : null,
      }));
    }
    if (action === "outputs" && m === "POST" && parts.length > 5) {
      // Share menu actions; the user's alone, a board run has no business with the clipboard or Finder.
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "sharing outputs is disabled inside a board run");
      const name = parts.slice(5).join("/");
      const file = store.outputPath(slug, id, name);
      if (!file) throw new HttpError(404, "output not found");
      const what = url.searchParams.get("action");
      try {
        if (what === "reveal") await revealFile(file);
        else if (what === "copy") await copyFileToClipboard(file);
        else if (what === "publish") return json(startPublish(slug, id, name, file), 202);
        else throw new HttpError(400, "action must be reveal, copy or publish");
      } catch (e) {
        if (e instanceof ShareError) throw new HttpError(e.status, e.message);
        throw e;
      }
      return json({ ok: true });
    }
    if (action === "outputs" && m === "GET") {
      if (parts.length === 5) return json(store.listOutputs(slug, id));
      const file = store.outputPath(slug, id, parts.slice(5).join("/"));
      if (!file) throw new HttpError(404, "output not found");
      const download = url.searchParams.get("download") === "1" ? { "content-disposition": attachmentHeader(basename(file)) } : {};
      // Plain text + sandbox: files are written by Claude and must never run as HTML on this origin.
      // Only raster images get their real type so the viewer can preview them; SVG stays text (it can carry scripts).
      const image = OUTPUT_IMAGE_TYPES[file.slice(file.lastIndexOf(".") + 1).toLowerCase()];
      return new Response(Bun.file(file), {
        headers: {
          "content-type": image ?? "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
          ...download,
        },
      });
    }
    if (action === "diff" && m === "GET") {
      // The Changes tab: the worktree (committed, uncommitted and untracked) against its merge-base with the base branch.
      const t = store.getTicket(slug, id)!;
      if (!t.worktree) throw new HttpError(404, "this ticket has no worktree");
      try {
        const base = profile.baseBranch || (await detectBaseBranch(t.worktree));
        return json(await ticketDiff(t.worktree, base, { ignoreWhitespace: url.searchParams.get("w") === "1" }));
      } catch (e) {
        if (e instanceof DiffError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    // What `/` runs in this ticket's chat: skills, custom commands and built-ins (the composer's picker).
    if (action === "commands" && m === "GET") {
      return json(board.commands(slug, id).map(({ local, ...c }) => c));
    }
    if (action === "conversation" && m === "GET") {
      // Read-only view of the ticket's Claude session file (terminal chat + board runs), newest last.
      const t = store.getTicket(slug, id)!;
      const parsed = t.sessionId ? sessions.get(t.sessionId) : null;
      const all = parsed?.entries ?? [];
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : all.length;
      const end = Math.max(0, Math.min(all.length, before));
      const start = Math.max(0, end - limit);
      const active = board.isRunning(slug, id);
      // Subagent rows carry only their last steps; "show all" fetches the rest (agent endpoint below).
      const entries = all.slice(start, end).map((e) => {
        if (!e.agent) return e;
        const agent = settleAgent(e.agent, active);
        return { ...e, agent: { ...agent, steps: agent.steps.slice(-AGENT_STEP_TAIL) } };
      });
      return json({ entries, start, total: all.length, title: parsed?.title ?? null });
    }
    if (action === "agent" && parts.length === 6 && m === "GET") {
      const t = store.getTicket(slug, id)!;
      const e = (t.sessionId ? sessions.get(t.sessionId)?.entries : null)?.find((x) => x.agent?.toolUseId === parts[5]);
      if (!e?.agent) throw new HttpError(404, "no such subagent in this ticket's conversation");
      return json(settleAgent(e.agent, board.isRunning(slug, id)));
    }
    if (action === "tool" && parts.length === 6 && m === "GET") {
      // A tool call's full input and output, loaded when the user opens its row in the chat.
      const t = store.getTicket(slug, id)!;
      const d = t.sessionId ? sessions.toolDetail(t.sessionId, parts[5]) : null;
      if (!d) throw new HttpError(404, "no such tool call in this ticket's conversation");
      return json(d);
    }
    if (action === "comments") {
      if (m === "GET") return json(store.listComments(slug, id));
      if (m === "POST") {
        const b = await body(req);
        const text = String(b.text ?? "").trim();
        if (!text) throw new HttpError(400, "text is required");
        // The child reads user comments on its next run; mark who wrote this one.
        const { planner, requester } = runRights(req, slug, store.getTicket(slug, id)!);
        const by = planner ? "Planner: " : requester ? `From the Planning chat of ${requester.id} (user request): ` : "";
        return json(board.addComment(slug, id, by + text), 201);
      }
    }
    // Another ticket's Claude asks this ticket's Claude (ask_ticket); the asker then polls questions/:q/poll.
    if (m === "POST" && action === "ask") {
      const from = runTicket(req, slug);
      if (!from) throw new HttpError(403, "ask_ticket only works inside a board run (it asks on behalf of that run's ticket)");
      const b = await body(req);
      const q = await questions.ask(slug, from, id, String(b.question ?? ""), Number(b.waitMs) || 0);
      return json(q, 201);
    }
    if (m === "POST" && action === "chat") {
      const { planner, requester } = runRights(req, slug, store.getTicket(slug, id)!);
      const b = await body(req);
      const text = String(b.text ?? "").trim();
      if (!text) throw new HttpError(400, "text is required");
      // A message from a run never hands the user's rights on to the run it starts.
      const t = await board.chat(slug, id, text, { fromPlanner: !!(planner || requester) });
      if (requester) store.addComment(slug, id, "ai", `Message sent ${byRequest(requester)}.`);
      return json(view(profile, t), 202);
    }
    // A message Claude hasn't received: POST .../queued/<msgId> sends it (unsent only), PATCH { text } edits it, DELETE discards it.
    if (action === "queued" && parts[5] && (m === "POST" || m === "PATCH" || m === "DELETE")) {
      try {
        let t: Ticket;
        if (m === "PATCH") {
          const text = String((await body(req)).text ?? "").trim();
          if (!text) throw new HttpError(400, "text is required");
          t = board.editQueued(slug, id, parts[5], text);
        } else t = m === "POST" ? await board.sendQueued(slug, id, parts[5]) : board.discardQueued(slug, id, parts[5]);
        return json(view(profile, t), m === "POST" ? 202 : 200);
      } catch (e) {
        if (e instanceof ConflictError || e instanceof HttpError) throw e;
        throw new HttpError(404, (e as Error).message);
      }
    }
    // A teammate card in the chat (propose_teammate) was answered: PUT .../teammate-cards/<entry uuid> { state: "saved",
    // name, scope } after the user saved it (the save itself goes through huddle-presets), or { state: "dismissed" }.
    if (action === "teammate-cards" && parts.length === 6 && m === "PUT") {
      if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user answers teammate cards");
      const b = await body(req);
      if (b.state !== "saved" && b.state !== "dismissed") throw new HttpError(400, "state must be saved or dismissed");
      if (b.scope !== undefined && b.scope !== "global" && b.scope !== "board") throw new HttpError(400, "scope must be global or board");
      const t = store.getTicket(slug, id)!;
      const card = {
        state: b.state, at: nowIso(),
        ...(b.state === "saved" && typeof b.name === "string" && b.name.trim() ? { name: b.name.trim() } : {}),
        ...(b.state === "saved" && b.scope ? { scope: b.scope } : {}),
      };
      store.updateTicket(slug, id, { teammateCards: { ...t.teammateCards, [parts[5]]: card } });
      emitTicket(slug, id);
      return json(view(profile, store.getTicket(slug, id)!));
    }
    if (m === "POST" && action === "link-session") {
      const b = await body(req);
      try {
        const t = await board.linkSession(slug, id, b.sessionId ? String(b.sessionId) : null);
        return json(view(profile, t));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    // Branch: a new ticket with a copy of this one's conversation and committed code (the user's call, not a run's).
    if (m === "POST" && action === "branch") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "branching is disabled inside a board run; use the propose_branch tool so the user can click Branch");
      try {
        const r = await board.branchTicket(slug, id);
        return json({ ticket: view(profile, r.ticket), warning: r.warning }, 201);
      } catch (e) {
        if (e instanceof ConflictError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
    }
    // One-click recovery: the session is gone (fresh-session) or open in a terminal (take-over). The user's call.
    if (m === "POST" && (action === "fresh-session" || action === "take-over")) {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "session recovery is the user's call, not a run's");
      try {
        if (action === "fresh-session") return json({ ticket: view(profile, board.startFresh(slug, id)), external: false });
        const r = await board.takeOver(slug, id);
        return json({ ticket: view(profile, r.ticket), external: r.external });
      } catch (e) {
        if (e instanceof ConflictError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (m === "POST" && action === "stop") {
      const { planner, requester } = runRights(req, slug, store.getTicket(slug, id)!);
      const stopped = board.stop(slug, id);
      if (planner && stopped) store.addComment(slug, id, "ai", "Planner stopped this run.");
      if (requester && stopped) store.addComment(slug, id, "ai", `Run stopped ${byRequest(requester)}.`);
      return json({ stopped });
    }
    // Start / pause / resume / mark done a planner's plan, or change how many children run at once.
    if (m === "POST" && action === "plan") {
      const b = await body(req);
      // A planner may start or resume its own plan (plan_control) when it has planner rights; the rest is the user's.
      const byPlanner = !!req.headers.get(RUN_HEADER);
      if (byPlanner) {
        if (runTicket(req, slug) !== id || (b.action !== "start" && b.action !== "resume")) {
          throw new HttpError(403, "a board run may only start or resume its own ticket's plan; pausing, finishing and concurrency are the user's");
        }
        if (!board.plannerRights(slug, id)) {
          throw new HttpError(403, "starting the plan from a board run needs the user's go-ahead: only a reply to the user's message in this ticket's chat may do it");
        }
      }
      const n = b.maxConcurrent === undefined || byPlanner ? undefined : Number(b.maxConcurrent);
      try {
        const t = b.action === "pause" ? board.pausePlan(slug, id)
          : b.action === "start" || b.action === "resume" ? board.startPlan(slug, id, { maxConcurrent: n, byPlanner })
          : b.action === "done" ? board.markPlanDone(slug, id)
          : b.action === "concurrency" && n !== undefined ? board.setPlanConcurrency(slug, id, n)
          : null;
        if (!t) throw new HttpError(400, "action must be start, pause, resume, done or concurrency");
        return json(view(profile, store.getTicket(slug, id) ?? t));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
    }
    // Manager mode: make existing tickets children of this one (adopt_tickets). From a run, only when the user asked
    // for it in this ticket's own chat.
    if (m === "POST" && action === "adopt") {
      if (req.headers.get(RUN_HEADER)) {
        if (runTicket(req, slug) !== id || !board.userChatRun(slug, id)) {
          throw new HttpError(403, "adopting tickets from a board run only works in a reply to the user's message in the adopting ticket's own chat");
        }
        if (store.getTicket(slug, id)!.plan?.state === "done") throw new HttpError(403, "this ticket's plan is done; the user can start a new one first");
      }
      const b = await body(req);
      const ids = strings(b.ids);
      if (!ids?.length) throw new HttpError(400, "ids must be a non-empty list of ticket ids");
      const r = board.adoptTickets(slug, id, ids);
      return json({ adopted: r.adopted.map((t) => view(profile, t)), skipped: r.skipped });
    }
    if (m === "POST" && action === "check-pr") {
      const state = await checkPr(board, store, slug, id);
      return json({ state, ticket: view(profile, store.getTicket(slug, id)!) });
    }
    // Review PR box: refresh (rate-limited unless force), send failing CI logs to Claude, Merge & done.
    if (m === "POST" && action === "pr" && ["refresh", "send-failures", "merge"].includes(parts[5])) {
      if (parts[5] !== "refresh" && req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can merge a PR or send its CI failures from the board");
      try {
        if (parts[5] === "refresh") {
          const force = !!(await body(req).catch(() => ({} as Record<string, unknown>))).force;
          const pr = await refreshPr(board, store, slug, id, { ...deps.pr, maxAgeMs: force ? 0 : REFRESH_MIN_MS });
          return json({ pr, ticket: view(profile, store.getTicket(slug, id)!) });
        }
        const t = parts[5] === "merge" ? await mergePr(board, store, slug, id, deps.pr) : await sendFailures(board, store, slug, id, deps.pr);
        return json(view(profile, t), parts[5] === "merge" ? 200 : 202);
      } catch (e) {
        if (e instanceof PrError) throw new HttpError(e.status, e.message);
        if (e instanceof HttpError || e instanceof ConflictError) throw e;
        throw new HttpError(502, (e as Error).message);
      }
    }
    if (m === "POST" && action === "planning-command") {
      try {
        return json({ command: await board.planningCommand(slug, id) });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    throw new HttpError(404, "not found");
  }

  /**
   * Huddle routes. The sender of a message is never taken from the body: a request from a board run is that run's
   * participant (its token for agents), anything else is the user (@you). Stop, resume, close and stopping one
   * participant are the user's alone.
   */
  async function huddleApi(req: Request, url: URL, slug: string, rest: string[]): Promise<Response> {
    const m = req.method;
    const who: Caller = { run: req.headers.get(RUN_HEADER), agent: req.headers.get(HUDDLE_HEADER) };
    const userOnly = (what: string) => {
      if (who.run || who.agent) throw new HttpError(403, `only the user can ${what}; ask them in the huddle (tag @you)`);
    };
    const num = (k: string) => {
      const v = url.searchParams.get(k);
      return v === null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v);
    };
    if (rest.length === 0) {
      if (m === "GET") return json(huddles.list(slug, url.searchParams.get("ticket") ?? undefined));
      if (m === "POST") {
        userOnly("start a huddle (propose a roster with propose_huddle instead)");
        const b = await body(req);
        const ticketId = String(b.ticketId ?? "");
        if (!ticketId) throw new HttpError(400, "ticketId is required");
        const h = huddles.create(slug, ticketId, Array.isArray(b.roster) ? b.roster : [], {
          maxParticipants: Number(b.maxParticipants) || undefined,
          maxCostUsd: b.maxCostUsd === undefined || b.maxCostUsd === null ? undefined : Number(b.maxCostUsd),
          template: typeof b.template === "string" && b.template.trim() ? b.template : undefined,
        });
        return json(huddles.view(slug, h), 201);
      }
      throw new HttpError(404, "not found");
    }
    const { h, me } = huddles.identify(slug, rest[0], who);
    const [, action, handle, sub, part, partId] = rest;
    if (!action && m === "GET") {
      const page = huddles.messages(slug, h.id, { before: num("before"), since: num("since"), limit: num("limit") });
      return json({ huddle: huddles.view(slug, h), you: me.handle, ...page });
    }
    if (m === "POST" && action === "messages" && !handle) {
      const b = await body(req);
      const kind = b.kind === "finding" ? "finding" : "message";
      const status = b.status ? { status: b.status, reason: typeof b.reason === "string" ? b.reason : undefined, lessons: b.lessons } : undefined;
      const src = req.headers.get(SOURCE_HEADER);
      return json(huddles.post(slug, h.id, me, String(b.text ?? ""), kind, status, src === "ui" || src === "mcp" ? src : "none"), 201);
    }
    // The pinned brief (goal, decisions): leads, @main and the user.
    if (m === "PUT" && action === "brief" && !handle) {
      const b = await body(req);
      return json(huddles.view(slug, huddles.setBrief(slug, h.id, me, String(b.text ?? ""))));
    }
    // A participant's own status: done, blocked (reason) or active again.
    if (m === "POST" && action === "status" && !handle) {
      const b = await body(req);
      const { token: _t, ...p } = huddles.setStatus(slug, h.id, me, b.status, typeof b.reason === "string" ? b.reason : undefined, b.lessons);
      return json(p);
    }
    // @main or a lead asks the user to close the huddle (only the user closes it).
    if (m === "POST" && action === "close-request" && !handle) {
      const b = await body(req);
      return json(huddles.view(slug, huddles.requestClose(slug, h.id, me, typeof b.reason === "string" ? b.reason : "")));
    }
    if (action === "participants") {
      if (m === "POST" && !handle) {
        const b = await body(req);
        const added = huddles.addParticipants(slug, h.id, me, b ?? {});
        return json({ added: added.map(({ token: _t, ...p }) => p), huddle: huddles.view(slug, huddles.get(slug, h.id)) }, 201);
      }
      if (m === "PATCH" && handle && !sub) {
        const b = await body(req);
        huddles.setMode(slug, h.id, me, handle, b.mode);
        return json(huddles.view(slug, huddles.get(slug, h.id)));
      }
      if (m === "POST" && handle && sub === "stop") {
        userOnly("stop a participant");
        huddles.stopParticipant(slug, h.id, handle);
        return json(huddles.view(slug, huddles.get(slug, h.id)));
      }
      // A participant's own Claude session, read-only (the Huddle tab's session viewer). The user's alone: agents
      // and runs can't read each other's sessions.
      if (handle && sub === "session") {
        userOnly("read a participant's session");
        if (m === "GET" && !part) {
          return json(participantSession(huddles, store, sessions, huddleSessions, slug, h.id, handle, { before: num("before"), since: num("since"), limit: num("limit") }));
        }
        if (m === "GET" && part === "tool" && partId) {
          const d = participantTool(huddles, sessions, slug, h.id, handle, partId);
          if (!d) throw new HttpError(404, "tool call not found");
          return json(d);
        }
        if (m === "POST" && part === "reveal" && !partId) {
          const file = participantSession(huddles, store, sessions, huddleSessions, slug, h.id, handle, { limit: 1 }).file;
          if (!file) throw new HttpError(404, `@${handle} has no transcript file yet`);
          await revealFile(file);
          return json({ ok: true, file });
        }
      }
      if (m === "POST" && handle && sub === "restart") {
        userOnly("restart a participant");
        huddles.restartParticipant(slug, h.id, handle);
        return json(huddles.view(slug, huddles.get(slug, h.id)));
      }
    }
    if (m === "POST" && !handle && (action === "stop" || action === "resume" || action === "close")) {
      userOnly(`${action} the huddle`);
      const b = action === "resume" ? await body(req) : {};
      const add = b?.addBudgetUsd === undefined || b?.addBudgetUsd === null ? 0 : Number(b.addBudgetUsd);
      const out = action === "stop" ? huddles.stopAll(slug, h.id) : action === "resume" ? huddles.resume(slug, h.id, add) : huddles.close(slug, h.id);
      return json(huddles.view(slug, out));
    }
    // The user viewed the huddle up to message `seq` (scrolled to the latest): what tagged them so far counts as seen.
    if (m === "POST" && action === "seen" && !handle) {
      userOnly("mark the huddle seen");
      const b = await body(req);
      return json(huddles.view(slug, huddles.markSeen(slug, h.id, Number(b?.seq))));
    }
    // A huddle agent proposes a teammate (propose_teammate): it waits under Learnings for the user.
    if (m === "POST" && action === "teammates" && !handle) return json(huddles.proposeTeammate(slug, h.id, me, await body(req)), 201);
    // Lessons agents proposed: only the user edits, saves (as role notes) or discards them.
    if (action === "learnings" && handle) {
      userOnly("save, edit or discard learnings");
      if (m === "POST" && sub === "discard") return json(huddles.discardLearning(slug, h.id, handle));
      const patch = async () => {
        const raw = await req.text();
        let b: any = {};
        try {
          if (raw.trim()) b = JSON.parse(raw) ?? {};
        } catch {
          throw new HttpError(400, "invalid JSON body");
        }
        return { text: b.text, scope: b.scope, target: b.target };
      };
      if (m === "PATCH" && !sub) return json(huddles.editLearning(slug, h.id, handle, await patch()));
      if (m === "POST" && sub === "save") return json(huddles.saveLearning(slug, h.id, handle, await patch()));
    }
    if (m === "POST" && action === "invite" && !handle) {
      const b = await body(req);
      const ticketId = String(b.ticketId ?? "");
      if (!ticketId) throw new HttpError(400, "ticketId is required");
      const { token: _t, ...p } = huddles.invite(slug, h.id, me, ticketId, typeof b.handle === "string" ? b.handle : undefined);
      return json(p, 201);
    }
    if (m === "POST" && action === "findings" && !handle) {
      const b = await body(req);
      const act = b.action === "add" || b.action === "resolve" ? b.action : "list";
      return json(huddles.findings(slug, h.id, me, act, { text: typeof b.text === "string" ? b.text : undefined, id: typeof b.id === "string" ? b.id : undefined }));
    }
    throw new HttpError(404, "not found");
  }

  function sse(req: Request): Response {
    let unsubscribe = () => {};
    let ping: ReturnType<typeof setInterval>;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (s: string) => {
          try {
            controller.enqueue(enc.encode(s));
          } catch {}
        };
        send(": connected\n\n");
        unsubscribe = bus.on((e: BusEvent) => {
          let out: unknown = e;
          if (e.type === "ticket.updated") {
            const p = store.getProfile(e.profile);
            if (p) out = { ...e, ticket: view(p, e.ticket) };
          }
          send(`data: ${JSON.stringify(out)}\n\n`);
          // Session changes (terminal chat, new questions) and the host's huddle change the ticket's "your turn" state too.
          const changed = e.type === "session.updated" ? { profile: e.profile, id: e.id }
            : e.type === "huddle.updated" ? { profile: e.profile, id: e.huddle.hostTicket } : null;
          if (changed) {
            const p = store.getProfile(changed.profile);
            const t = p && store.getTicket(changed.profile, changed.id);
            if (p && t) send(`data: ${JSON.stringify({ type: "ticket.updated", profile: changed.profile, ticket: view(p, t) })}\n\n`);
          }
        });
        ping = setInterval(() => send(": ping\n\n"), 15_000);
        req.signal.addEventListener("abort", () => {
          unsubscribe();
          clearInterval(ping);
          try {
            controller.close();
          } catch {}
        });
      },
      cancel() {
        unsubscribe();
        clearInterval(ping);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  function staticFile(url: URL): Response {
    const assets = deps.assets ?? {};
    if (Object.keys(assets).length) {
      const hit = assets[url.pathname] ?? assets["/index.html"];
      if (!hit) return new Response("not found", { status: 404 });
      return new Response(Bun.file(hit));
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(deps.webDir, rel);
    if (file.startsWith(deps.webDir) && existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
    const index = join(deps.webDir, "index.html");
    if (existsSync(index)) return new Response(Bun.file(index));
    return new Response("UI not built. Run: bun run build:web", { status: 404 });
  }

  function attachShell(ws: import("bun").ServerWebSocket<ShellSocket>, restart = false, resumeChat = false) {
    const d = ws.data;
    d.unsubscribe?.();
    let shell: Shell;
    try {
      // An exited quick chat that has messages comes back on the same session ("Start again").
      const prev = shells.current(d.slug, d.kind);
      const resume = resumeChat && !!prev?.sessionId && sessions.version(prev.sessionId) !== null;
      shell = shells.get(d.slug, d.cwd, d.cols, d.rows, restart, d.kind, resume, d.name);
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: (e as Error).message }));
      return;
    }
    d.shell = shell;
    const back = shell.scrollback();
    if (back.length) ws.sendBinary(back);
    if (shell.exited) ws.send(JSON.stringify({ type: "exit", code: shell.exitCode }));
    else shell.resize(d.cols, d.rows);
    d.unsubscribe = shell.subscribe((e) => {
      if (e.type === "data") ws.sendBinary(e.data);
      else ws.send(JSON.stringify({ type: "exit", code: e.code }));
    });
  }

  const server = Bun.serve<ShellSocket>({
    hostname: "127.0.0.1",
    port: deps.port,
    idleTimeout: 0,
    async fetch(req) {
      if (!isAllowedRequest(req, server.port ?? deps.port)) return new Response("forbidden", { status: 403 });
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/api/")) return staticFile(url);
      try {
        return (await api(req, url)) as Response;
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        if (e instanceof ConflictError) return json({ error: e.message }, 409);
        if (e instanceof McpError) return json({ error: e.message }, e.status);
        if (e instanceof AgentError) return json({ error: e.message }, e.status);
        if (e instanceof ScheduleError) return json({ error: e.message }, e.status);
        if (e instanceof SnippetError) return json({ error: e.message }, e.status);
        if (e instanceof QuestionError) return json({ error: e.message }, e.status);
        if (e instanceof HuddleError) return json({ error: e.message }, e.status);
        if (e instanceof URIError) return json({ error: "malformed URL" }, 400);
        console.error(e);
        return json({ error: (e as Error).message ?? "internal error" }, 500);
      }
    },
    websocket: {
      open: (ws) => attachShell(ws),
      message(ws, raw) {
        let msg: any;
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        } catch {
          return;
        }
        const shell = ws.data.shell;
        if (msg.type === "input" && typeof msg.data === "string") shell?.write(msg.data);
        else if (msg.type === "resize") {
          ws.data.cols = Math.min(1000, Math.max(1, Number(msg.cols) || 80));
          ws.data.rows = Math.min(1000, Math.max(1, Number(msg.rows) || 24));
          shell?.resize(ws.data.cols, ws.data.rows);
        } else if (msg.type === "restart") {
          // Another tab may already have restarted it: then just join the new shell.
          ws.send(JSON.stringify({ type: "reset" }));
          attachShell(ws, shells.current(ws.data.slug, ws.data.kind) === shell, msg.resume === true);
        }
      },
      close: (ws) => ws.data.unsubscribe?.(),
    },
  });
  return server;
}
