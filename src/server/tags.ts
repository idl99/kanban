/** Longest tag name kept, and most tags on one ticket (or schedule). */
export const TAG_MAX_LEN = 24;
export const TAGS_MAX = 10;

/** One tag as stored: trimmed, lowercase, no leading #, spaces become dashes, at most TAG_MAX_LEN characters. "" when nothing is left. */
export function normalizeTag(v: string): string {
  return v.trim().replace(/^#+/, "").trim().toLowerCase().replace(/\s+/g, "-").slice(0, TAG_MAX_LEN).replace(/-+$/, "");
}

/** Tags as stored (Ticket.tags, Schedule.tags): normalized, no blanks or repeats, at most TAGS_MAX. */
export function normalizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = v.filter((x): x is string => typeof x === "string").map(normalizeTag).filter(Boolean);
  return [...new Set(out)].slice(0, TAGS_MAX);
}
