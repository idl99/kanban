// A ticket's links in one list: claude.ai artifacts from its own session, its huddle teammates' sessions and its result
// summaries, plus the share links of its output files. The Outputs tab, drawer header and board card all read it.
import type { SessionArtifact } from "./session";
import type { Comment, ShareLink } from "./types";

/** Where a link was found: the ticket's session, a huddle teammate's session, a result summary or the Share menu. */
export type LinkSource = "ticket" | "chat" | `huddle:@${string}` | "result" | "share";

export interface TicketLink {
  url: string;
  label: string;
  at: string;
  source: LinkSource;
}

/** A claude.ai artifact link; a Markdown link around it gives its label. */
const ARTIFACT_URL = /(?:\[([^\]\n]{1,200})\]\()?(https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+)/g;

/** claude.ai artifact URLs written in a text (a result summary), with their Markdown link text when there is one. */
export function artifactUrlsIn(text: string): { url: string; label: string | null }[] {
  return [...text.matchAll(ARTIFACT_URL)].map((m) => ({ url: m[2], label: m[1]?.trim() || null }));
}

/** Higher wins the label and the source tag when one URL turns up in several places: a publish knows its title best. */
const rank = (s: LinkSource) => (s === "result" ? 0 : s === "share" ? 1 : 2);

/** Label of an artifact URL found bare in a result summary. */
const DEFAULT_LABEL = "claude.ai artifact";

const baseName = (f: string) => f.slice(f.lastIndexOf("/") + 1);

export function isArtifact(l: TicketLink): boolean {
  return l.source !== "share";
}

export function collectLinks(input: {
  ticket?: SessionArtifact[];
  huddles?: { handle: string; artifacts: SessionArtifact[] }[];
  /** The ticket's Claude comments: its result summaries. */
  results?: Pick<Comment, "author" | "text" | "at">[];
  shareLinks?: ShareLink[];
}): TicketLink[] {
  const found: TicketLink[] = [
    ...(input.ticket ?? []).map((a) => ({ ...a, source: "ticket" as const })),
    ...(input.huddles ?? []).flatMap((h) => h.artifacts.map((a) => ({ ...a, source: `huddle:@${h.handle}` as const }))),
    ...(input.results ?? []).filter((c) => c.author === "ai").flatMap((c) =>
      artifactUrlsIn(c.text).map((u) => ({ url: u.url, label: u.label ?? DEFAULT_LABEL, at: c.at, source: "result" as const }))),
    ...(input.shareLinks ?? []).map((l) => ({ url: l.url, label: baseName(l.file), at: l.at, source: "share" as const })),
  ];
  // Per URL: the strongest source gives the label, the tag and the time; a summary that mentions a publish later
  // doesn't make it newer (several mentioned at once would tie, and an old one re-mentioned would jump ahead).
  const byUrl = new Map<string, TicketLink>();
  for (const l of found) {
    if (!/^https:\/\//.test(l.url)) continue;
    const had = byUrl.get(l.url);
    if (!had || rank(l.source) > rank(had.source)) {
      byUrl.set(l.url, l);
      continue;
    }
    if (rank(l.source) < rank(had.source)) continue;
    const label = had.label === DEFAULT_LABEL && l.label !== DEFAULT_LABEL ? l.label : had.label;
    byUrl.set(l.url, { ...had, label, at: l.at > had.at ? l.at : had.at });
  }
  return [...byUrl.values()].sort((a, b) => b.at.localeCompare(a.at));
}
