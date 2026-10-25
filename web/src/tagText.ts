import type { CSSProperties } from "react";

/** Same rules as the server's normalizeTag (src/server/tags.ts): trimmed, lowercase, no leading #, spaces become dashes. */
export const TAG_MAX_LEN = 24;
export function normalizeTag(v: string): string {
  return v.trim().replace(/^#+/, "").trim().toLowerCase().replace(/\s+/g, "-").slice(0, TAG_MAX_LEN).replace(/-+$/, "");
}

/** Stable hue (0-359) for a tag name: the same name always gets the same color, with no settings. */
export function tagHue(name: string): number {
  // FNV-1a: similar names (xhs, video) still land far apart on the color wheel.
  let h = 0x811c9dc5;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h % 360;
}

/** Inline style for a tag chip: the hue goes in --tag-h, styles.css turns it into light/dark colors. */
export const tagStyle = (name: string): CSSProperties => ({ "--tag-h": tagHue(name) } as CSSProperties);

/** The search box: `#post kitchen` → tags ["post"] and text "kitchen". A lone "#" is ignored. */
export function parseSearch(query: string): { tags: string[]; text: string } {
  const tags: string[] = [];
  const words: string[] = [];
  for (const w of query.trim().split(/\s+/).filter(Boolean)) {
    if (w.startsWith("#")) {
      const tag = normalizeTag(w);
      if (tag && !tags.includes(tag)) tags.push(tag);
    } else words.push(w);
  }
  return { tags, text: words.join(" ").toLowerCase() };
}

/** The ticket has at least one of these tags (no tags asked: every ticket), like the other filter chips. */
export function hasTags(t: { tags?: string[] }, tags: string[]): boolean {
  return !tags.length || tags.some((g) => t.tags?.includes(g));
}

/** This board's tags, most used first (ties by name), with how many tickets have each. */
export function boardTags(tickets: { tags?: string[] }[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of tickets) for (const g of t.tags ?? []) counts.set(g, (counts.get(g) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
