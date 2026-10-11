import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./store";
import type { ActivityEntry } from "./types";
import type { UsageResult } from "./usage";

// How much of the Claude plan a ticket used. Anthropic only reports a plan-wide % per 5h window, so a ticket's
// share is estimated: its exact cost in a window (from its runs' result events) ÷ the cost of all Claude Code
// activity on this machine in that window (priced from ~/.claude/projects logs) × the window's utilization.

const FIVE_HOURS = 5 * 3600_000;

// ---------- pricing ----------

/** List prices in $ per million tokens; cache writes are 1.25× (5 min) or 2× (1 h) the input price. */
interface Price { input: number; output: number; cacheRead: number }

const OPUS_5_5: Price = { input: 4, output: 20, cacheRead: 0.2 };
const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 1 }],
  [/opus-5-5|^opus$/, OPUS_5_5],
  [/opus-(5|4-[5-9])/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/opus/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/haiku/, { input: 0.8, output: 4, cacheRead: 0.08 }],
];

/** Price for a model id ("claude-opus-5-5[1m]", "opus"); unknown models get the current Opus price. */
export function priceFor(model: string): Price {
  const m = model.toLowerCase().replace(/\[.*\]$/, "");
  return PRICES.find(([re]) => re.test(m))?.[1] ?? OPUS_5_5;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** API-equivalent cost of one assistant message from its `usage` block. */
export function messageCost(model: string, usage: any): number {
  if (!usage || typeof usage !== "object") return 0;
  const p = priceFor(model);
  const created = num(usage.cache_creation_input_tokens);
  const split = usage.cache_creation;
  // Claude Code caches for 1 h; count unsplit cache writes that way.
  const w5m = split ? num(split.ephemeral_5m_input_tokens) : 0;
  const w1h = split ? num(split.ephemeral_1h_input_tokens) : created;
  const dollars = num(usage.input_tokens) * p.input + num(usage.output_tokens) * p.output
    + num(usage.cache_read_input_tokens) * p.cacheRead + w5m * p.input * 1.25 + w1h * p.input * 2;
  return (dollars / 1e6) * (usage.speed === "fast" ? 2 : 1);
}

/** Conversation size at one assistant message: everything it read (input, cache read, cache write); 0 without usage. */
export function contextTokens(usage: any): number {
  if (!usage || typeof usage !== "object") return 0;
  return num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
}

// ---------- machine-wide Claude Code cost ----------

export function claudeProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

/**
 * Cost of every Claude Code message on this machine, read incrementally from the session logs: each file is
 * read from where the last refresh stopped, and files older than the oldest window asked for are skipped.
 */
export class ClaudeLogIndex {
  private files = new Map<string, { offset: number; rest: string }>();
  /** message id + request id → index in `entries` (a message is logged once per content block). */
  private keys = new Map<string, number>();
  private entries: { t: number; cost: number }[] = [];
  private horizon = Infinity;
  private lastRefresh = 0;
  private running: Promise<void> | null = null;

  constructor(private root = claudeProjectsDir(), private minIntervalMs = 10_000, private now = Date.now) {}

  /** Catch up with the logs, covering at least activity since `since` (ms). */
  async refresh(since: number): Promise<void> {
    while (this.running) await this.running;
    if (since >= this.horizon && this.now() - this.lastRefresh < this.minIntervalMs) return;
    this.running = this.scan(since);
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  costBetween(start: number, end: number): number {
    let sum = 0;
    for (const e of this.entries) if (e.t >= start && e.t < end) sum += e.cost;
    return sum;
  }

  private async scan(since: number): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(this.root, { recursive: true }) as string[];
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(this.root, name);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      let state = this.files.get(file);
      if (!state) {
        if (st.mtimeMs < since) continue;
        state = { offset: 0, rest: "" };
        this.files.set(file, state);
      }
      if (st.size < state.offset) Object.assign(state, { offset: 0, rest: "" });
      if (st.size === state.offset) continue;
      const text = await Bun.file(file).slice(state.offset, st.size).text();
      state.offset = st.size;
      const lines = (state.rest + text).split("\n");
      state.rest = lines.pop() ?? "";
      for (const line of lines) this.add(line);
    }
    this.horizon = Math.min(this.horizon, since);
    this.lastRefresh = this.now();
  }

  private add(line: string) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    const m = j?.message;
    if (j?.type !== "assistant" || !m?.usage || typeof m.model !== "string" || m.model === "<synthetic>") return;
    const t = Date.parse(j.timestamp);
    if (Number.isNaN(t)) return;
    const cost = messageCost(m.model, m.usage);
    const key = `${m.id ?? j.uuid}:${j.requestId ?? ""}`;
    const at = this.keys.get(key);
    // Later lines of the same message carry the final token counts.
    if (at !== undefined) this.entries[at] = { t: this.entries[at].t, cost };
    else {
      this.keys.set(key, this.entries.length);
      this.entries.push({ t, cost });
    }
  }
}

// ---------- 5h window snapshots ----------

export interface WindowSnapshot {
  start: string;
  end: string;
  /** Last seen utilization, 0-100. */
  utilization: number;
  seenAt: string;
}

export function readWindows(file: string): WindowSnapshot[] {
  try {
    const list = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Remembers the 5h window from a usage answer, so runs keep a % after their window has reset. */
export function recordWindow(file: string, r: UsageResult): void {
  if ("error" in r) return;
  const w = r.windows.find((x) => x.key === "five_hour");
  const end = w?.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (!w || Number.isNaN(end)) return;
  const snap: WindowSnapshot = {
    start: new Date(end - FIVE_HOURS).toISOString(), end: new Date(end).toISOString(), utilization: w.percent, seenAt: r.fetchedAt,
  };
  // resets_at can wobble by seconds between answers; anything within 15 min is the same window.
  const list = readWindows(file).filter((x) => Math.abs(Date.parse(x.end) - end) >= 15 * 60_000);
  list.push(snap);
  list.sort((a, b) => a.end.localeCompare(b.end));
  atomicWrite(file, JSON.stringify(list.slice(-500)));
}

/** Shares one usage-endpoint answer between the header pill and ticket views (the endpoint rate-limits). */
export class UsageCache {
  private last: UsageResult | null = null;
  private at = 0;
  private inflight: Promise<UsageResult> | null = null;

  constructor(private fetcher: () => Promise<UsageResult>, private onResult: (r: UsageResult) => void = () => {}, private now = Date.now) {}

  /** A cached answer younger than maxAgeMs (errors are kept at most a minute), else a fresh one. */
  async get(maxAgeMs: number): Promise<UsageResult> {
    const age = this.now() - this.at;
    if (this.last && age < (("error" in this.last) ? Math.min(maxAgeMs, 60_000) : maxAgeMs)) return this.last;
    this.inflight ??= this.fetcher()
      .then((r) => {
        this.last = r;
        this.at = this.now();
        try {
          this.onResult(r);
        } catch {}
        return r;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

// ---------- per-ticket runs ----------

export type RunKind = "work" | "planning" | "chat" | "reply" | "run";

export interface TicketRun {
  run: number;
  kind: RunKind;
  startedAt: string;
  /** Model with the biggest share of the run's cost. */
  model: string | null;
  tokens: number;
  costUsd: number;
  /** Cost per result event, to place it in a 5h window. */
  parts: { at: string; cost: number }[];
}

/**
 * Splits a ticket's activity into runs with their cost and tokens. Result events carry the session's running
 * totals (`total_cost_usd`, `modelUsage`, kept across `--resume`), so a run's cost is the growth since the last one.
 */
export function ticketRuns(activity: ActivityEntry[]): TicketRun[] {
  const out: (TicketRun & { marked: boolean; done: boolean; models: Map<string, number> })[] = [];
  const lastTotal = new Map<string, number>();
  const lastModel = new Map<string, { tokens: number; cost: number }>();
  let cur: (typeof out)[number] | null = null;
  for (const e of activity) {
    const ev = e.event;
    if (!ev || typeof ev !== "object") continue;
    const marker = ev.type === "ckanban_run";
    const init = ev.type === "system" && ev.subtype === "init";
    // Runs logged before markers existed: a new init after a result starts the next turn.
    if (marker || !cur || cur.run !== e.run || (init && cur.done && !cur.marked)) {
      cur = { run: e.run, kind: marker ? ev.kind ?? "run" : "run", startedAt: e.at, model: null, tokens: 0, costUsd: 0, parts: [], marked: marker, done: false, models: new Map() };
      out.push(cur);
    }
    if (init && !cur.marked && cur.kind === "run" && ev.permissionMode === "plan") cur.kind = "planning";
    if (ev.type !== "result") continue;
    cur.done = true;
    const sid = String(ev.session_id ?? "");
    const total = num(ev.total_cost_usd);
    const prev = lastTotal.get(sid) ?? 0;
    const cost = total >= prev ? total - prev : total;
    lastTotal.set(sid, total);
    cur.costUsd += cost;
    cur.parts.push({ at: e.at, cost });
    const mu = ev.modelUsage && typeof ev.modelUsage === "object" && Object.keys(ev.modelUsage).length ? ev.modelUsage : null;
    if (mu) {
      for (const [model, u] of Object.entries<any>(mu)) {
        const now = {
          tokens: num(u?.inputTokens) + num(u?.outputTokens) + num(u?.cacheReadInputTokens) + num(u?.cacheCreationInputTokens),
          cost: num(u?.costUSD),
        };
        const before = lastModel.get(`${sid}|${model}`) ?? { tokens: 0, cost: 0 };
        const grew = now.tokens >= before.tokens && now.cost >= before.cost;
        lastModel.set(`${sid}|${model}`, now);
        cur.tokens += grew ? now.tokens - before.tokens : now.tokens;
        cur.models.set(model, (cur.models.get(model) ?? 0) + (grew ? now.cost - before.cost : now.cost));
      }
    } else if (ev.usage) {
      const u = ev.usage;
      cur.tokens += num(u.input_tokens) + num(u.output_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    }
  }
  return out
    .filter((r) => r.done)
    .map(({ marked, done, models, ...r }) => ({
      ...r,
      model: [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    }));
}

// ---------- ticket usage ----------

/** What the agents of a ticket's huddles spent (huddle.ts teammateSpend); counted in the ticket's total cost. */
export interface TeammateUsage {
  costUsd: number;
  huddles: { id: string; status: string; createdAt: string; costUsd: number; teammates: { handle: string; role: string; costUsd: number }[] }[];
}

export interface TicketUsage {
  runs: { run: number; kind: RunKind; startedAt: string; model: string | null; tokens: number; costUsd: number; pct5h: number | null }[];
  /** costUsd: the ticket's runs plus its huddle teammates; tokens and % are its runs only. */
  totals: { costUsd: number; tokens: number; pctCurrentWindow: number | null; pctLifetime: number | null };
  /** Its huddles' teammates, null when they spent nothing. */
  teammates: TeammateUsage | null;
  /** The current 5h window, as last seen. */
  window: { utilization: number; resetsAt: string; seenAt: string } | null;
  /** Why there is no current window (usage endpoint error), if known. */
  windowError: string | null;
}

export interface UsageInputs {
  activity: ActivityEntry[];
  windows: WindowSnapshot[];
  /** Cost of all Claude Code activity on this machine between two times (ms). */
  machineCost: (start: number, end: number) => number;
  now?: number;
  windowError?: string | null;
  teammates?: TeammateUsage;
}

/** Windows the ticket's runs fall in (and the current one): what the machine-wide index must cover. */
export function windowsNeeded(runs: TicketRun[], windows: WindowSnapshot[], now = Date.now()): WindowSnapshot[] {
  const hit = (t: number) => windows.find((w) => Date.parse(w.start) <= t && t < Date.parse(w.end));
  const set = new Set<WindowSnapshot>();
  const current = hit(now);
  if (current) set.add(current);
  for (const r of runs) for (const p of r.parts) {
    const w = hit(Date.parse(p.at));
    if (w) set.add(w);
  }
  return [...set];
}

export function ticketUsage(i: UsageInputs): TicketUsage {
  const now = i.now ?? Date.now();
  const runs = ticketRuns(i.activity);
  const span = (w: WindowSnapshot) => [Date.parse(w.start), Date.parse(w.end)] as const;
  const windowOf = (t: number) => i.windows.find((w) => {
    const [s, e] = span(w);
    return s <= t && t < e;
  }) ?? null;
  const current = windowOf(now);

  // Per window: the ticket's cost there, and the machine total (never less than the ticket's own).
  const ticketIn = new Map<WindowSnapshot, number>();
  for (const r of runs) for (const p of r.parts) {
    const w = windowOf(Date.parse(p.at));
    if (w) ticketIn.set(w, (ticketIn.get(w) ?? 0) + p.cost);
  }
  const denom = new Map<WindowSnapshot, number>();
  for (const [w, mine] of ticketIn) denom.set(w, Math.max(i.machineCost(...span(w)), mine));

  let pctCurrent = current ? 0 : null;
  let pctLifetime: number | null = null;
  const outRuns = runs.map((r) => {
    let pct: number | null = null;
    for (const p of r.parts) {
      const w = windowOf(Date.parse(p.at));
      if (!w) continue;
      const d = denom.get(w)!;
      const share = d > 0 ? (p.cost / d) * w.utilization : 0;
      pct = (pct ?? 0) + share;
      pctLifetime = (pctLifetime ?? 0) + share;
      if (w === current) pctCurrent = (pctCurrent ?? 0) + share;
    }
    return { run: r.run, kind: r.kind, startedAt: r.startedAt, model: r.model, tokens: r.tokens, costUsd: r.costUsd, pct5h: pct };
  });

  return {
    runs: outRuns,
    totals: {
      costUsd: runs.reduce((s, r) => s + r.costUsd, 0) + (i.teammates?.costUsd ?? 0),
      tokens: runs.reduce((s, r) => s + r.tokens, 0),
      pctCurrentWindow: pctCurrent,
      pctLifetime,
    },
    teammates: i.teammates?.costUsd ? i.teammates : null,
    window: current ? { utilization: current.utilization, resetsAt: current.end, seenAt: current.seenAt } : null,
    windowError: current ? null : i.windowError ?? null,
  };
}
