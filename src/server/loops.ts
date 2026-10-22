import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Board } from "./board";
import type { Bus } from "./events";
import { askClaude, type Decision } from "./integrations/ask-claude";
import { PassError, type Passes } from "./integrations/passes";
import { readScript, runScript, scriptEnv, sha256, type Item, type ScriptRun } from "./integrations/script";
import { ticketBody, ticketTitle, usedVariables, VARIABLES } from "./integrations/ticket-text";
import { RateLimitError } from "./integrations/types";
import type { SideCaller } from "./side-call";
import type { Store } from "./store";
import type { Loop, LoopColumn, LoopSeenItem, LoopState } from "./types";
import { newId } from "./util";

export class LoopError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface LoopInput {
  name?: unknown;
  enabled?: unknown;
  service?: unknown;
  passes?: unknown;
  script?: unknown;
  everyMinutes?: unknown;
  column?: unknown;
  autoStart?: unknown;
  askClaude?: unknown;
  instructions?: unknown;
}

export type LoopView = Loop & {
  /** ok: it runs; otherwise the first of `problems` is why not. */
  state: "ok" | "unsupported" | "needs_connection" | "script_changed";
  /** Why it can't run, in plain words. A loop with problems stays on disk. */
  problems: string[];
  /** The script file as it is now (it may differ from what was saved: then state is script_changed). */
  script: string | null;
  /** The passes it uses, with their names and whether they work. */
  passViews: { id: string; name: string; status: string }[];
  seenCount: number;
  lastFound: number;
  lastItems: LoopSeenItem[];
};

/** What a test run of a script found (the setup chat and the editor's Test button). */
export interface TestResult {
  items: Item[];
  found: number;
  error: string | null;
  stderr: string;
  toolsUsed: string[];
  durationMs: number;
}

export interface LoopDeps {
  now: () => Date;
  sideCall: SideCaller;
  /** Folder with the `ckanban` command scripts call (script.ts ckanbanShim). */
  shimDir: () => string;
  port: () => number;
  /** Runs a check script (tests pass a fake). */
  run?: (file: string, cwd: string, env: Record<string, string>) => Promise<ScriptRun>;
}

/** What one check (or test run) may call through `ckanban call`, and what it called. */
interface Grant {
  passes: string[];
  /** "<pass id>:<tool>"; null: any tool of its passes (the first check after a save learns the list). */
  allowed: Set<string> | null;
  used: Set<string>;
  expires: number;
  rateLimitMs: number;
}

const FORMAT = 2;
const DEFAULT_EVERY = 15;
/** Programs on this computer start a process for each check: not more often than this. */
const LOCAL_MIN_EVERY = 5;
const SCRIPT_MAX = 64_000;
const PREVIEW = 20;
/** New items Claude looks at in one check (Ask Claude first); the rest wait for the next check. */
const ASK_PER_CHECK = 20;
/** Tickets one check makes at most; the rest stay new and come with the next checks, so a bad check can't flood the board. */
const NEW_PER_CHECK = 20;
/** After a failed check the loop waits 2, 4, 8 ... minutes (at most this long) before it tries again. */
const BACKOFF_MIN_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const COLUMNS: LoopColumn[] = ["backlog", "planning", "ready"];
const ASK_BODY = "Work on this item from {{service}}.";

export const DEFAULT_INSTRUCTIONS = "Look at this item from {{service}} and do what it needs.\n\nLink: {{link}}";

/**
 * The automations of every board. Each tick, every switched-on loop that is due runs its check script; each item the
 * script finds for the first time becomes a ticket (after Claude's yes, with Ask Claude first). Nothing here knows a
 * service: scripts reach them through the board's passes (`ckanban call`, see call()).
 */
export class LoopManager {
  private locks = new Map<string, Promise<unknown>>();
  private grants = new Map<string, Grant>();
  private ticking = false;
  private run: NonNullable<LoopDeps["run"]>;

  constructor(private store: Store, private bus: Bus, private board: Board, private passes: Passes, private deps: LoopDeps) {
    this.run = deps.run ?? ((file, cwd, env) => runScript(file, cwd, env));
  }

  /** Checks and edits of one loop happen one at a time, so an edit can't be overwritten by a check already running. */
  private lock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const p = (this.locks.get(key) ?? Promise.resolve()).then(fn);
    const tail = p.catch(() => {});
    this.locks.set(key, tail);
    void tail.then(() => this.locks.get(key) === tail && this.locks.delete(key));
    return p;
  }

  view(slug: string, l: Loop): LoopView {
    const problems: string[] = [];
    let state: LoopView["state"] = "ok";
    if (l.version > FORMAT) problems.push("Saved by a newer ckanban. Update ckanban to use it.");
    else if (l.version < FORMAT) problems.push("Made by an earlier test version of automations. Delete it and set it up again.");
    if (problems.length) state = "unsupported";
    const script = readScript(this.store.loopScriptFile(slug, l.id));
    const passViews = (l.passes ?? []).map((id) => {
      const p = this.passes.get(id);
      return { id, name: p?.name ?? "(removed)", status: p?.status ?? "missing" };
    });
    if (state === "ok") {
      for (const p of passViews) {
        if (p.status === "missing") problems.push("One of its connections was removed. Pick it again or connect it in Connections.");
        else if (p.status !== "connected") problems.push(`${p.name} needs to be connected again (Connections).`);
      }
      if (problems.length) state = "needs_connection";
    }
    if (state === "ok" && (script === null || sha256(script) !== l.scriptHash)) {
      problems.push("Script changed, review it: it doesn't run until you save it again.");
      state = "script_changed";
    }
    const st = this.store.getLoopState(slug, l.id);
    return { ...l, state, problems, script, passViews, seenCount: st.seen.length, lastFound: st.lastFound, lastItems: st.lastItems };
  }

  private emit(slug: string, l: Loop | null, id = l?.id ?? "") {
    this.bus.emit({ type: "loop.updated", profile: slug, id, loop: l ? this.view(slug, l) : null });
  }

  get(slug: string, id: string): Loop {
    const l = this.store.getLoop(slug, id);
    if (!l) throw new LoopError(404, `automation ${id} not found`);
    return l;
  }

  list(slug: string): LoopView[] {
    return this.store.listLoops(slug).map((l) => this.view(slug, l));
  }

  /** How many automations all boards have (Connections shows its Board column once there is one). */
  count(): number {
    return this.store.listProfiles().reduce((n, p) => n + this.store.listLoops(p.slug).length, 0);
  }

  /** Pass ids from ids or names; throws on one the board doesn't have. */
  private passIds(v: unknown): string[] {
    if (!Array.isArray(v)) throw new LoopError(400, "passes must be a list");
    return [...new Set(v.map((ref) => {
      const p = this.passes.find(String(ref ?? ""));
      if (!p) throw new LoopError(400, `"${String(ref)}" isn't connected for automations yet: connect it in Connections first`);
      return p.id;
    }))];
  }

  private validate(input: LoopInput, base?: Loop): { fields: Omit<Loop, "version" | "id" | "createdAt" | "updatedAt" | "lastCheckedAt" | "lastFiredAt" | "lastError" | "scriptHash" | "allowedTools">; script: string | null } {
    const str = (v: unknown, fallback: string) => (v === undefined ? fallback : String(v ?? ""));
    const name = str(input.name, base?.name ?? "").trim().slice(0, 80);
    if (!name) throw new LoopError(400, "Give the automation a name");
    const passes = input.passes === undefined ? base?.passes ?? [] : this.passIds(input.passes);
    const service = (str(input.service, base?.service ?? "").trim() || this.passes.get(passes[0] ?? "")?.name || "a script").slice(0, 60);

    let script: string | null = null;
    if (input.script !== undefined) {
      script = String(input.script ?? "").replace(/\r\n/g, "\n");
      if (!script.trim()) throw new LoopError(400, "The automation needs its check script");
      if (script.length > SCRIPT_MAX) throw new LoopError(400, "The check script is too long");
    } else if (!base) throw new LoopError(400, "The automation needs its check script");

    const every = input.everyMinutes === undefined ? base?.everyMinutes ?? DEFAULT_EVERY : Number(input.everyMinutes);
    if (!Number.isInteger(every) || every < 1 || every > 1440) throw new LoopError(400, "Check every 1 to 1440 minutes");
    const local = passes.some((id) => this.passes.get(id)?.kind === "local");
    if (local && every < LOCAL_MIN_EVERY) throw new LoopError(400, `It starts a program on this computer: check every ${LOCAL_MIN_EVERY} minutes or less often`);

    const column = str(input.column, base?.column ?? "backlog") as LoopColumn;
    if (!COLUMNS.includes(column)) throw new LoopError(400, "Pick Backlog, Planning or Ready for the new tickets");
    const autoStart = input.autoStart === undefined ? base?.autoStart ?? false : input.autoStart === true;
    if (column !== "backlog" && !autoStart) {
      throw new LoopError(400, `${column === "ready" ? "Ready" : "Planning"} starts Claude on text from ${service}: switch on "Start Claude by itself" first`);
    }

    const rawAsk = (input.askClaude === undefined ? base?.askClaude : input.askClaude) as { on?: unknown; prompt?: unknown } | undefined;
    const askClaude = { on: rawAsk?.on === true, prompt: String(rawAsk?.prompt ?? "").slice(0, 4000) };

    const instructions = str(input.instructions, base?.instructions ?? DEFAULT_INSTRUCTIONS).slice(0, 8000);
    const unknown = usedVariables(instructions).filter((v) => !(VARIABLES as readonly string[]).includes(v));
    if (unknown.length) {
      throw new LoopError(400, `Unknown ${unknown.length === 1 ? "variable" : "variables"} in the ticket text: ${unknown.map((v) => `{{${v}}}`).join(", ")}`);
    }
    const enabled = input.enabled === undefined ? base?.enabled ?? true : input.enabled === true;
    return { fields: { name, enabled, service, passes, everyMinutes: every, column, autoStart, askClaude, instructions }, script };
  }

  async create(slug: string, input: LoopInput): Promise<LoopView> {
    if (!this.store.getProfile(slug)) throw new LoopError(404, `board ${slug} not found`);
    const { fields, script } = this.validate(input);
    const id = newId();
    return this.lock(`${slug}/${id}`, () => {
      const at = this.deps.now().toISOString();
      this.store.saveLoopScript(slug, id, script!);
      const l: Loop = {
        version: FORMAT, id, ...fields, scriptHash: sha256(script!), allowedTools: null,
        createdAt: at, updatedAt: at, lastCheckedAt: null, lastFiredAt: null, lastError: null,
      };
      this.store.saveLoop(slug, l);
      this.emit(slug, l);
      return this.view(slug, l);
    });
  }

  update(slug: string, id: string, input: LoopInput): Promise<LoopView> {
    return this.lock(`${slug}/${id}`, () => {
      const current = this.get(slug, id);
      if (current.version > FORMAT) throw new LoopError(409, "This automation was saved by a newer ckanban; update ckanban to edit it");
      // A loop this version can't run can still be switched off.
      const onlyToggle = Object.keys(input).every((k) => k === "enabled");
      if (onlyToggle && current.version !== FORMAT) {
        const next = { ...current, enabled: input.enabled === true, updatedAt: this.deps.now().toISOString() };
        this.store.saveLoop(slug, next);
        this.emit(slug, next);
        return this.view(slug, next);
      }
      const { fields, script } = this.validate(input, current);
      const next: Loop = { ...current, ...fields, updatedAt: this.deps.now().toISOString() };
      const state = this.store.getLoopState(slug, id);
      let restart = false;
      // A saved script is pinned by its hash; what it may call is learned again by its next check.
      if (script !== null && (sha256(script) !== current.scriptHash || readScript(this.store.loopScriptFile(slug, id)) !== script)) {
        this.store.saveLoopScript(slug, id, script);
        next.scriptHash = sha256(script);
        next.allowedTools = null;
        restart = true;
      }
      if (fields.passes.join() !== current.passes.join()) next.allowedTools = null;
      // It only looks forward from when it starts: switching it on again, or a new script, notes what is there first.
      if (restart || (next.enabled && !current.enabled)) {
        next.lastError = null;
        this.store.saveLoopState(slug, id, { ...state, primed: false, failures: 0, backoffUntil: null });
      }
      this.store.saveLoop(slug, next);
      this.emit(slug, next);
      return this.view(slug, next);
    });
  }

  remove(slug: string, id: string): Promise<void> {
    return this.lock(`${slug}/${id}`, () => {
      this.get(slug, id);
      this.store.deleteLoop(slug, id);
      this.emit(slug, null, id);
    });
  }

  /**
   * A copy of the loop on another board. It starts switched off (a copy that begins making tickets on a board you
   * haven't looked at would surprise), with a clean memory: it only looks forward from when it is switched on.
   */
  async copy(slug: string, id: string, toSlug: string): Promise<LoopView> {
    if (!this.store.getProfile(toSlug)) throw new LoopError(404, `board ${toSlug} not found`);
    const l = this.get(slug, id);
    const v = this.view(slug, l);
    if (v.state === "unsupported") throw new LoopError(409, "This automation can't be copied: this version of ckanban doesn't support it");
    if (v.state === "script_changed" || v.script === null) throw new LoopError(409, "Its script changed since it was saved: review and save it first");
    return this.create(toSlug, {
      name: l.name, enabled: false, service: l.service, passes: l.passes, script: v.script, everyMinutes: l.everyMinutes,
      column: l.column, autoStart: l.autoStart, askClaude: l.askClaude, instructions: l.instructions,
    });
  }

  /**
   * A call from a check script (`ckanban call`): only with the token its check got, only to that loop's passes, and
   * after the first check only the tools that check used.
   */
  async call(token: string, service: string, tool: string, args: unknown): Promise<unknown> {
    const g = this.grants.get(token);
    if (!g || g.expires < Date.now()) throw new LoopError(403, "ckanban call only works inside an automation's check");
    const p = this.passes.find(service, g.passes);
    if (!p) {
      const names = g.passes.map((id) => this.passes.get(id)?.name).filter(Boolean);
      throw new LoopError(404, `This automation can't use "${service}". ${names.length ? `It can use: ${names.join(", ")}.` : "It has no connections."}`);
    }
    if (!/^[\w.:-]{1,100}$/.test(tool)) throw new LoopError(400, "That isn't a tool name");
    const key = `${p.id}:${tool}`;
    if (g.allowed && !g.allowed.has(key)) {
      throw new LoopError(403, `This automation may not use ${p.name}'s ${tool}: it can only use the tools its check used when it was saved. Save it again to allow more.`);
    }
    g.used.add(key);
    const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    try {
      return await this.passes.call(p.id, tool, a);
    } catch (e) {
      if (e instanceof RateLimitError) g.rateLimitMs = Math.max(g.rateLimitMs, e.retryAfterMs);
      if (e instanceof PassError) throw new LoopError(e.status, e.message);
      throw new LoopError(502, this.passes.mask((e as Error).message));
    }
  }

  /** Runs a script with a grant for its passes. The grant ends with the run. */
  private async runWith(file: string, cwd: string, passIds: string[], allowed: string[] | null): Promise<{ run: ScriptRun; grant: Grant }> {
    const token = randomBytes(24).toString("base64url");
    const grant: Grant = { passes: passIds, allowed: allowed ? new Set(allowed) : null, used: new Set(), expires: Date.now() + 10 * 60_000, rateLimitMs: 0 };
    this.grants.set(token, grant);
    try {
      const env = scriptEnv({ shimDir: this.deps.shimDir(), port: this.deps.port(), callToken: token, keys: this.passes.envFor(passIds) });
      const run = await this.run(file, cwd, env);
      return { run: { ...run, error: run.error && this.passes.mask(run.error), stderr: this.passes.mask(run.stderr) }, grant };
    } finally {
      this.grants.delete(token);
    }
  }

  private maskItem(i: Item): Item {
    const m = (s: string) => this.passes.mask(s);
    return { id: i.id, title: m(i.title), ...(i.text ? { text: m(i.text) } : {}), ...(i.link ? { link: m(i.link) } : {}) };
  }

  /** A trial run of a script that isn't saved (the setup chat and the editor's Test): makes no tickets. */
  async test(slug: string, input: { script?: unknown; passes?: unknown }): Promise<TestResult> {
    const profile = this.store.getProfile(slug);
    if (!profile) throw new LoopError(404, `board ${slug} not found`);
    const script = String(input.script ?? "");
    if (!script.trim()) throw new LoopError(400, "There is no script to test");
    if (script.length > SCRIPT_MAX) throw new LoopError(400, "The check script is too long");
    const passIds = input.passes === undefined ? [] : this.passIds(input.passes);
    const dir = join(this.store.root, "automation-tests");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${newId()}.sh`);
    writeFileSync(file, script);
    try {
      const { run, grant } = await this.runWith(file, profile.path, passIds, null);
      const items = (run.items ?? []).map((i) => this.maskItem(i));
      return {
        items: items.slice(0, PREVIEW), found: items.length, error: run.error, stderr: run.stderr, durationMs: run.durationMs,
        toolsUsed: [...grant.used].map((k) => this.toolLabel(k)),
      };
    } finally {
      rmSync(file, { force: true });
    }
  }

  private toolLabel(key: string): string {
    const [id, tool] = key.split(":");
    return `${this.passes.get(id)?.name ?? id}: ${tool}`;
  }

  /** Checks every switched-on loop that is due, one after another. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const p of this.store.listProfiles()) {
        for (const l of this.store.listLoops(p.slug)) {
          if (!l.enabled) continue;
          await this.lock(`${p.slug}/${l.id}`, () => this.check(p.slug, l.id, false)).catch((e) => console.error(`automation ${p.slug}/${l.id} check failed: ${this.passes.mask(String((e as Error).message ?? e))}`));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Checks one loop now, ignoring its timer and its wait after a failure. A switched-off loop does nothing. */
  checkNow(slug: string, id: string): Promise<LoopView> {
    return this.lock(`${slug}/${id}`, async () => {
      const l = this.get(slug, id);
      if (l.enabled) await this.check(slug, id, true);
      return this.view(slug, this.get(slug, id));
    });
  }

  private async check(slug: string, id: string, force: boolean): Promise<void> {
    const loop = this.store.getLoop(slug, id);
    const profile = this.store.getProfile(slug);
    if (!loop || !profile || !loop.enabled) return;
    const v = this.view(slug, loop);
    const now = this.deps.now();
    const state = this.store.getLoopState(slug, id);
    if (!force) {
      if (state.backoffUntil && Date.parse(state.backoffUntil) > now.getTime()) return;
      if (loop.lastCheckedAt && now.getTime() - Date.parse(loop.lastCheckedAt) < loop.everyMinutes * 60_000 - 5_000) return;
    }
    if (v.state === "unsupported" || v.state === "needs_connection") return;

    const save = (patch: Partial<Loop>, st: Partial<LoopState>) => {
      const cur = this.store.getLoop(slug, id);
      if (!cur) return;
      const next = { ...cur, ...patch };
      this.store.saveLoop(slug, next);
      this.store.saveLoopState(slug, id, { ...this.store.getLoopState(slug, id), ...st });
      this.emit(slug, next);
    };
    if (v.state === "script_changed") {
      if (loop.lastError !== v.problems[0]) save({ lastError: v.problems[0] }, {});
      return;
    }
    const fail = (message: string, waitMs?: number) => {
      const failures = state.failures + 1;
      const wait = waitMs || Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1));
      save({ lastCheckedAt: now.toISOString(), lastError: message }, { failures, backoffUntil: new Date(now.getTime() + wait).toISOString() });
    };

    const { run, grant } = await this.runWith(this.store.loopScriptFile(slug, id), profile.path, loop.passes, loop.allowedTools);
    if (!run.items) return fail(run.error ?? "The check failed", grant.rateLimitMs);
    const learned = loop.allowedTools ?? [...grant.used].sort();
    const items = run.items.map((i) => this.maskItem(i));
    const seen = new Set(state.seen);
    const preview = (list: LoopSeenItem[]) => list.slice(0, PREVIEW);

    if (!state.primed) {
      // The first check after a save or switching on: what is there already never makes a ticket.
      for (const i of items) seen.add(i.id);
      save({ lastCheckedAt: now.toISOString(), lastError: null, allowedTools: learned }, {
        seen: [...seen], primed: true, failures: 0, backoffUntil: null, lastFound: items.length,
        lastItems: preview(items.map((i) => ({ id: i.id, title: i.title, ...(i.link ? { link: i.link } : {}), state: "first" as const }))),
      });
      return;
    }

    const shown: LoopSeenItem[] = [];
    let fired: string | null = null;
    let asked = 0;
    let made = 0;
    const remember = () => this.store.saveLoopState(slug, id, { ...this.store.getLoopState(slug, id), seen: [...seen] });
    for (const item of items) {
      const base = { id: item.id, title: item.title, ...(item.link ? { link: item.link } : {}) };
      if (seen.has(item.id)) {
        shown.push({ ...base, state: "seen" });
        continue;
      }
      // The rest stay unseen: the next checks pick them up.
      if (made >= NEW_PER_CHECK) continue;
      let decision: Decision | null = null;
      if (loop.askClaude.on) {
        // The rest wait for the next check (they stay unseen).
        if (asked >= ASK_PER_CHECK) continue;
        asked++;
        try {
          decision = await askClaude(this.deps.sideCall, loop.askClaude.prompt, loop.service, item);
        } catch (e) {
          return fail((e as Error).message);
        }
        if (!decision.create) {
          seen.add(item.id);
          remember();
          shown.push({ ...base, state: "skipped", note: decision.summary });
          continue;
        }
      }
      // Written down before the ticket, so a crash in between can't make a second ticket for the same item.
      seen.add(item.id);
      remember();
      try {
        const t = await this.board.createTicket(slug, {
          title: ticketTitle(decision?.title || item.title),
          body: ticketBody(decision ? ASK_BODY : loop.instructions, loop.service, item, decision?.summary),
          status: loop.column === "backlog" || !loop.autoStart ? "backlog" : loop.column,
          source: { provider: loop.service, label: ticketTitle(item.title), url: item.link ?? "", loopId: id },
        });
        fired = now.toISOString();
        made++;
        shown.push({ ...base, state: "new", ticketId: t.id });
      } catch (e) {
        seen.delete(item.id);
        remember();
        return fail(`Could not create the ticket: ${(e as Error).message}`);
      }
    }
    const order = { new: 0, skipped: 1, first: 2, seen: 3 };
    save(
      { lastCheckedAt: now.toISOString(), lastError: null, allowedTools: learned, ...(fired ? { lastFiredAt: fired } : {}) },
      { seen: [...seen], failures: 0, backoffUntil: grant.rateLimitMs ? new Date(now.getTime() + grant.rateLimitMs).toISOString() : null, lastFound: items.length, lastItems: preview(shown.sort((a, b) => order[a.state] - order[b.state])) },
    );
  }

  start(intervalMs = 60_000): () => void {
    const run = () => this.tick().catch((e) => console.error("automations tick failed", e));
    const timer = setInterval(run, intervalMs);
    run();
    return () => clearInterval(timer);
  }
}
