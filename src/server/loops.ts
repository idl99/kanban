import type { Bus } from "./events";
import type { Accounts } from "./integrations/accounts";
import { matches, ruleError, type Rule } from "./integrations/filters";
import type { Registry } from "./integrations/registry";
import { render, usedVariables } from "./integrations/template";
import { AuthError, RateLimitError, type Deps } from "./integrations/types";
import type { Store } from "./store";
import type { Loop, LoopState } from "./types";
import { newId } from "./util";

export class LoopError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface LoopInput {
  name?: unknown;
  enabled?: unknown;
  accountId?: unknown;
  trigger?: unknown;
  match?: unknown;
  rules?: unknown;
  action?: unknown;
  instructions?: unknown;
}

export type LoopView = Loop & {
  /** ok: it runs; otherwise the first of `problems` is why not. */
  state: "ok" | "unsupported" | "no_connection" | "needs_reconnect";
  /** Why it can't run here, in plain words. A loop with problems stays on disk. */
  problems: string[];
  /** "Linear · ihan.d", or null when the connection was removed. */
  account: string | null;
};

type Fields = Pick<Loop, "name" | "enabled" | "accountId" | "provider" | "trigger" | "match" | "rules" | "action" | "instructions">;

const FORMAT = 1;
/** Event keys a loop remembers, newest last. */
const HANDLED_KEEP = 2000;
/** After a failed check the loop waits 2, 4, 8 ... minutes (at most this long) before it tries again. */
const BACKOFF_MIN_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/**
 * The automations of every board. Each tick, every enabled loop whose connection is signed in asks its trigger for
 * events since its cursor; each event that passes the loop's rules runs the loop's action, once per event key.
 * Nothing here knows a provider or an action: they come from the registry.
 */
export class LoopManager {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private store: Store, private bus: Bus, private registry: Registry, private accounts: Accounts, private deps: Deps,
  ) {}

  /** Checks and edits one at a time, so an edit can't be overwritten by a check that was already running. */
  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  view(l: Loop): LoopView {
    const problems: string[] = [];
    if (l.version > FORMAT) problems.push("Saved by a newer ckanban. Update ckanban to use it.");
    const provider = this.registry.provider(l.provider);
    const trigger = this.registry.trigger(l.provider, l.trigger);
    if (!provider) problems.push(`The "${l.provider}" integration is not available in this version.`);
    else if (!trigger) problems.push(`The "${l.trigger}" trigger is not available in this version.`);
    else {
      for (const r of l.rules) if (!trigger.fields.some((f) => f.id === r.field)) problems.push(`The "${r.field}" filter is not available in this version.`);
    }
    if (!this.registry.action(l.action.type)) problems.push(`The "${l.action.type}" action is not available in this version.`);
    let state: LoopView["state"] = problems.length ? "unsupported" : "ok";
    const account = this.accounts.get(l.accountId);
    if (!account) {
      problems.push("The connection was removed. Pick another one.");
      if (state === "ok") state = "no_connection";
    } else if (account.status !== "connected") {
      problems.push(account.status === "needs_reconnect" ? "The connection needs to be signed in again (Integrations)." : "The connection is not signed in yet (Integrations).");
      if (state === "ok") state = "needs_reconnect";
    }
    return {
      ...l, state, problems,
      account: account ? `${provider?.name ?? account.provider}${account.identity ? ` · ${account.identity.userName}` : ""}` : null,
    };
  }

  private emit(slug: string, l: Loop | null, id = l?.id ?? "") {
    this.bus.emit({ type: "loop.updated", profile: slug, id, loop: l ? this.view(l) : null });
  }

  get(slug: string, id: string): Loop {
    const l = this.store.getLoop(slug, id);
    if (!l) throw new LoopError(404, `automation ${id} not found`);
    return l;
  }

  list(slug: string): LoopView[] {
    return this.store.listLoops(slug).map((l) => this.view(l));
  }

  private validate(input: LoopInput, base?: Loop): Fields {
    const str = (v: unknown, fallback: string) => (v === undefined ? fallback : String(v ?? ""));
    const name = str(input.name, base?.name ?? "").trim();
    if (!name) throw new LoopError(400, "Give the automation a name");
    const account = this.accounts.get(str(input.accountId, base?.accountId ?? ""));
    if (!account) throw new LoopError(400, "Pick a connection (add one in Integrations first)");
    const provider = this.registry.provider(account.provider);
    if (!provider) throw new LoopError(400, `The "${account.provider}" integration is not available`);
    const triggerId = str(input.trigger, base?.trigger ?? "");
    const trigger = this.registry.trigger(account.provider, triggerId);
    if (!trigger) throw new LoopError(400, `Pick what starts it (${provider.triggers.map((t) => t.label).join(" or ")})`);

    const match = input.match === undefined ? base?.match ?? "all" : input.match;
    if (match !== "all" && match !== "any") throw new LoopError(400, 'Match must be "all" or "any"');
    const rawRules = input.rules === undefined ? base?.rules ?? [] : input.rules;
    if (!Array.isArray(rawRules)) throw new LoopError(400, "rules must be a list");
    const rules: Rule[] = rawRules.map((r: any) => ({
      field: String(r?.field ?? ""), op: String(r?.op ?? "") as Rule["op"],
      values: Array.isArray(r?.values) ? r.values.map(String).filter(Boolean) : [],
    }));
    const why = ruleError(trigger, rules);
    if (why) throw new LoopError(400, why);

    const rawAction = (input.action === undefined ? base?.action : input.action) as { type?: unknown; settings?: unknown } | undefined;
    const action = this.registry.action(String(rawAction?.type ?? "create_ticket"));
    if (!action) throw new LoopError(400, `Unknown action "${String(rawAction?.type)}"`);
    let settings: Record<string, string>;
    try {
      settings = action.validate((rawAction?.settings && typeof rawAction.settings === "object" ? rawAction.settings : {}) as Record<string, unknown>);
    } catch (e) {
      throw new LoopError(400, (e as Error).message);
    }

    const instructions = str(input.instructions, base?.instructions ?? "");
    if (!instructions.trim()) throw new LoopError(400, "Write the instructions for the new ticket");
    const known = new Set(trigger.variables.map((v) => v.name));
    const unknown = usedVariables(instructions).filter((v) => !known.has(v));
    if (unknown.length) {
      throw new LoopError(400, `Unknown ${unknown.length === 1 ? "variable" : "variables"} in the instructions: ${unknown.map((v) => `{{${v}}}`).join(", ")}`);
    }

    return {
      name, accountId: account.id, provider: account.provider, trigger: triggerId, match, rules, instructions,
      action: { type: action.id, settings },
      enabled: input.enabled === undefined ? base?.enabled ?? true : input.enabled === true,
    };
  }

  create(slug: string, input: LoopInput): Promise<LoopView> {
    return this.serial(() => {
      const fields = this.validate(input);
      const at = this.deps.now().toISOString();
      const l: Loop = { version: FORMAT, id: newId(), ...fields, createdAt: at, updatedAt: at, lastCheckedAt: null, lastFiredAt: null, lastError: null };
      this.store.saveLoop(slug, l);
      this.resetCursor(slug, l);
      this.emit(slug, l);
      return this.view(l);
    });
  }

  update(slug: string, id: string, input: LoopInput): Promise<LoopView> {
    return this.serial(() => {
      const current = this.get(slug, id);
      if (current.version > FORMAT) throw new LoopError(409, "This automation was saved by a newer ckanban; update ckanban to edit it");
      // A loop this version can't run can still be switched off.
      const onlyToggle = Object.keys(input).every((k) => k === "enabled");
      const fields: Fields = onlyToggle && this.view(current).state === "unsupported" ? { ...current, enabled: input.enabled === true } : this.validate(input, current);
      const next: Loop = { ...current, ...fields, updatedAt: this.deps.now().toISOString() };
      if (next.enabled && !current.enabled) next.lastError = null;
      this.store.saveLoop(slug, next);
      // It only looks forward from when it starts listening: switching it on again, or pointing it elsewhere, restarts its cursor.
      if ((next.enabled && !current.enabled) || next.accountId !== current.accountId || next.trigger !== current.trigger) this.resetCursor(slug, next);
      this.emit(slug, next);
      return this.view(next);
    });
  }

  remove(slug: string, id: string): Promise<void> {
    return this.serial(() => {
      this.get(slug, id);
      this.store.deleteLoop(slug, id);
      this.emit(slug, null, id);
    });
  }

  /**
   * A copy of the loop on another board. It starts switched off (a copy that begins making tickets on a board you
   * haven't looked at would surprise), with a clean memory: it only looks forward from when it is switched on.
   */
  copy(slug: string, id: string, toSlug: string): Promise<LoopView> {
    if (!this.store.getProfile(toSlug)) throw new LoopError(404, `board ${toSlug} not found`);
    const l = this.get(slug, id);
    if (this.view(l).state === "unsupported") throw new LoopError(409, "This automation can't be copied: this version of ckanban doesn't support it");
    return this.create(toSlug, {
      name: l.name, enabled: false, accountId: l.accountId, trigger: l.trigger, match: l.match, rules: l.rules,
      action: l.action, instructions: l.instructions,
    });
  }

  private resetCursor(slug: string, l: Loop) {
    const trigger = this.registry.trigger(l.provider, l.trigger);
    const old = this.store.getLoopState(slug, l.id);
    // The handled keys stay: an event acted on before is never acted on twice.
    this.store.saveLoopState(slug, l.id, { ...old, cursor: trigger ? trigger.initialCursor(this.deps.now()) : null, failures: 0, backoffUntil: null });
  }

  /** Checks every enabled loop that is due. */
  tick(): Promise<void> {
    return this.serial(async () => {
      for (const p of this.store.listProfiles()) {
        for (const l of this.store.listLoops(p.slug)) {
          if (!l.enabled) continue;
          await this.check(p.slug, l).catch((e) => console.error(`automation ${p.slug}/${l.id} check failed`, e));
        }
      }
    });
  }

  /** Checks one loop now, ignoring its wait after a failure. A switched-off loop does nothing. */
  checkNow(slug: string, id: string): Promise<LoopView> {
    return this.serial(async () => {
      const l = this.get(slug, id);
      if (l.enabled) await this.check(slug, l, true);
      return this.view(this.get(slug, id));
    });
  }

  private async check(slug: string, loop: Loop, force = false): Promise<void> {
    if (this.view(loop).state !== "ok") return;
    const trigger = this.registry.trigger(loop.provider, loop.trigger)!;
    const action = this.registry.action(loop.action.type)!;
    const ctx = this.accounts.context(loop.accountId);
    if (!ctx) return;
    const state = this.store.getLoopState(slug, loop.id);
    const now = this.deps.now();
    if (!force && state.backoffUntil && Date.parse(state.backoffUntil) > now.getTime()) return;
    if (state.cursor === null) {
      // Never started (a failed reset): begin from now instead of importing history.
      this.store.saveLoopState(slug, loop.id, { ...state, cursor: trigger.initialCursor(now) });
      return;
    }

    const save = (patch: Partial<Loop>, st?: Partial<LoopState>) => {
      const cur = this.store.getLoop(slug, loop.id);
      if (!cur) return;
      const next = { ...cur, ...patch };
      this.store.saveLoop(slug, next);
      if (st) this.store.saveLoopState(slug, loop.id, { ...this.store.getLoopState(slug, loop.id), ...st });
      this.emit(slug, next);
    };
    const fail = (e: unknown) => {
      const failures = state.failures + 1;
      const wait = e instanceof RateLimitError ? e.retryAfterMs : Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1));
      const message = (e as Error).message || String(e);
      if (e instanceof AuthError) this.accounts.markNeedsReconnect(loop.accountId, message);
      save({ lastCheckedAt: now.toISOString(), lastError: message }, { failures, backoffUntil: new Date(now.getTime() + wait).toISOString() });
    };

    let result;
    try {
      result = await trigger.poll(ctx, state.cursor);
    } catch (e) {
      return fail(e);
    }

    const handled = new Set(state.handled);
    const remember = () => this.store.saveLoopState(slug, loop.id, { ...this.store.getLoopState(slug, loop.id), handled: [...handled].slice(-HANDLED_KEEP) });
    let fired: string | null = null;
    for (const event of [...result.events].sort((a, b) => a.at.localeCompare(b.at))) {
      if (handled.has(event.key)) continue;
      if (!matches(trigger, loop.match, loop.rules, event, ctx.identity)) continue;
      // Written down before the action, so a crash in between can't make a second ticket for the same event.
      handled.add(event.key);
      remember();
      try {
        const more = await event.load?.().catch(() => ({}));
        await action.run({
          slug, loopId: loop.id, loopName: loop.name, provider: this.registry.provider(loop.provider)!, event,
          instructions: render(loop.instructions, { ...event.vars, ...more }),
        }, loop.action.settings);
        fired = now.toISOString();
      } catch (e) {
        handled.delete(event.key);
        remember();
        // The cursor stays, so the next check sees this event again.
        return fail(e);
      }
    }
    save(
      { lastCheckedAt: now.toISOString(), lastError: null, ...(fired ? { lastFiredAt: fired } : {}) },
      { cursor: result.cursor, failures: 0, backoffUntil: null, handled: [...handled].slice(-HANDLED_KEEP) },
    );
  }

  start(intervalMs = 60_000): () => void {
    const run = () => this.tick().catch((e) => console.error("automations tick failed", e));
    const timer = setInterval(run, intervalMs);
    run();
    return () => clearInterval(timer);
  }
}
