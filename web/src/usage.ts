// Pure helpers for the header usage pill (kept out of the component so tests can import them).

export interface UsageWindow {
  key: string;
  label: string;
  percent: number;
  resetsAt: string | null;
}

export type UsageResult = { windows: UsageWindow[]; fetchedAt: string } | { error: string; fetchedAt: string };

export type UsageTone = "ok" | "warn" | "err";

/** Amber from 80%, red from 95%. */
export function usageTone(percent: number): UsageTone {
  if (percent >= 95) return "err";
  if (percent >= 80) return "warn";
  return "ok";
}

/** The pill takes the colour of the fullest window. */
export function worstTone(windows: UsageWindow[]): UsageTone {
  return usageTone(Math.max(0, ...windows.map((w) => w.percent)));
}

const pct = (n: number) => `${Math.round(n)}%`;

/** "Usage · 5h 42% · week 81%" */
export function pillText(windows: UsageWindow[]): string {
  const short: Record<string, string> = { five_hour: "5h", seven_day: "week" };
  const parts = windows.filter((w) => short[w.key]).map((w) => `${short[w.key]} ${pct(w.percent)}`);
  return ["Usage", ...(parts.length ? parts : windows.slice(0, 2).map((w) => `${w.label} ${pct(w.percent)}`))].join(" · ");
}

function inWords(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "Resets 4:10 PM (in 2h 15m)" within a day, "Resets Thu 9:00 AM" further out. */
export function resetText(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  const ms = at.getTime() - now;
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "Resets now";
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (ms < 24 * 3600_000) return `Resets ${time} (in ${inWords(ms)})`;
  return `Resets ${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

// ---------- per-ticket usage (Usage tab) ----------

export type RunKind = "work" | "planning" | "chat" | "reply" | "follow-up" | "run";

/** What the agents of a ticket's huddles spent (src/server/ticket-usage.ts TeammateUsage). */
export interface TeammateUsage {
  costUsd: number;
  huddles: { id: string; status: string; createdAt: string; costUsd: number; teammates: { handle: string; role: string; costUsd: number }[] }[];
}

export interface TicketUsage {
  runs: { run: number; kind: RunKind; startedAt: string; model: string | null; tokens: number; costUsd: number; pct5h: number | null }[];
  /** costUsd includes the huddle teammates and side calls; tokens and % are the ticket's runs only. */
  totals: { costUsd: number; tokens: number; pctCurrentWindow: number | null; pctLifetime: number | null };
  teammates?: TeammateUsage | null;
  /** "Say it simpler" rewrites and "Help me understand" answers (side calls outside the ticket's session). */
  sideCostUsd?: number;
  window: { utilization: number; resetsAt: string; seenAt: string } | null;
  windowError: string | null;
}

/** "≈ 6%", "≈ <1%", "–" when unknown. */
export function approxPct(p: number | null): string {
  if (p === null) return "–";
  if (p > 0 && p < 1) return "≈ <1%";
  return `≈ ${Math.round(p)}%`;
}

/** "$4.12", "<$0.01". */
export function costText(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** "2.1M", "340k", "820". */
export function tokenText(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** "claude-opus-5-5[1m]" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5". */
export function modelName(id: string | null): string {
  if (!id) return "–";
  const m = /(opus|sonnet|haiku|fable|mythos)(?:-(\d+))?(?:-(\d{1,2}))?(?=$|[-[])/i.exec(id.replace(/\[.*\]$/, ""));
  if (!m) return id;
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return [name, [m[2], m[3]].filter(Boolean).join(".")].filter(Boolean).join(" ");
}

export const RUN_KIND_LABEL: Record<RunKind, string> = {
  work: "Work run", planning: "Planning chat", chat: "Chat", reply: "Reply to a ticket", "follow-up": "Follow-up", run: "Run",
};
