// Plain time helpers, no React, so tests can import them (the ticking hook is in useNow.ts).

/** Full local date and time, for tooltips next to relative times. */
export function fullTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Waits older than this are marked in the Inbox. */
export const OLD_WAIT_MS = 8 * 3600_000;

/** How long something has waited since `iso`, coarse: "just now", "12m", "9h", "1d 4h". */
export function waitedFor(iso: string, at = Date.now()): string {
  const m = Math.max(0, Math.floor((at - new Date(iso).getTime()) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

/** Short running time since `iso`: "45s", "3m", "1h 5m". */
export function elapsed(iso: string, at = Date.now()): string {
  const s = Math.max(0, Math.floor((at - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const m = Math.floor((s % 3600) / 60);
  return m ? `${Math.floor(s / 3600)}h ${m}m` : `${Math.floor(s / 3600)}h`;
}

/** Duration with seconds for live timers: "48s", "2m 14s", "1h 5m". */
export function duration(fromIso: string, to = Date.now()): string {
  const s = Math.max(0, Math.floor((to - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function timeUntil(iso: string): string {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s < 60) return "any moment";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

/** Plain one-line preview of markdown text (for cards). */
export function plainPreview(md: string, max = 160): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~>#|]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
