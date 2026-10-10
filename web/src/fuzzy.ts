export interface FuzzyMatch {
  /** Lower is better. Below -500: the query is a substring (below -1000: at a word start). */
  score: number;
  /** Indexes of the matched characters in the text, for highlighting. */
  at: number[];
}

/** Letters must appear in order; word starts and runs score best. Null = no match. */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  const t = text.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, at: [] };
  const direct = t.indexOf(q);
  if (direct >= 0) {
    const at = Array.from({ length: q.length }, (_, i) => direct + i);
    return { score: direct === 0 || /\W/.test(t[direct - 1]) ? -1000 + direct : -500 + direct, at };
  }
  let score = 0;
  let last = -1;
  const at: number[] = [];
  for (const ch of q) {
    const i = t.indexOf(ch, last + 1);
    if (i < 0) return null;
    score += i - last - 1;
    at.push(i);
    last = i;
  }
  return { score, at };
}

/** Text split into plain and matched runs, for <mark>. */
export function highlightRuns(text: string, at: number[]): { text: string; hit: boolean }[] {
  const hits = new Set(at);
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i], hit });
  }
  return out;
}

/** 0 word-start substring, 1 substring elsewhere, 2 letters in order. */
export function matchTier(score: number): 0 | 1 | 2 {
  if (score < -500) return 0;
  if (score < 0) return 1;
  return 2;
}

/** The fields ranking needs (TicketRow in api.ts); kept here so this file has no browser imports. */
export interface RankRow {
  profile: string;
  title: string;
  status: string;
  running: boolean;
  updatedAt: string;
  body?: string;
  /** Its last result summary (Claude's last comment). */
  summary?: string;
  prUrl?: string | null;
}

/** Where a ticket matched when it wasn't its title: a short excerpt with the match marked. */
export interface Snippet {
  field: "summary" | "body" | "pr";
  text: string;
  at: number[];
}

export interface TicketHit<R extends RankRow> {
  row: R;
  at: number[];
  snippet?: Snippet;
}

const SNIPPET_BEFORE = 40;
const SNIPPET_LEN = 140;

/**
 * The query's words, in order, as a phrase in longer text (any whitespace between them), on one line
 * around the match. Null when the text doesn't contain it. score: lower is better, like fuzzyMatch.
 */
export function findSnippet(text: string, query: string): { score: number; text: string; at: number[] } | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length || !text) return null;
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "i");
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index;
  const wordStart = start === 0 || /\W/.test(text[start - 1]);
  // Flatten whitespace, keeping track of where the match lands.
  let from = Math.max(0, start - SNIPPET_BEFORE);
  if (from > 0) {
    const space = text.slice(from, start).search(/\s/);
    if (space >= 0) from += space + 1;
  }
  const end = Math.min(text.length, Math.max(start + m[0].length, from + SNIPPET_LEN));
  let out = from > 0 ? "…" : "";
  const at: number[] = [];
  for (let i = from; i < end; i++) {
    const inMatch = i >= start && i < start + m[0].length;
    const ch = /\s/.test(text[i]) ? " " : text[i];
    if (ch === " " && (!out || out.endsWith(" "))) continue;
    if (inMatch) at.push(out.length);
    out += ch;
  }
  if (end < text.length) out = out.trimEnd() + "…";
  return { score: (wordStart ? -1000 : -500) + Math.min(start, 499), text: out, at };
}

/** The PR number from a GitHub pull request URL. */
export function prNumber(url: string | null | undefined): string | null {
  return url?.match(/\/pull\/(\d+)/)?.[1] ?? null;
}

/** Best non-title match: the PR number, then the result summary, then the description. */
function otherMatch(row: RankRow, query: string): (Snippet & { score: number }) | null {
  const pr = prNumber(row.prUrl);
  const num = query.trim().replace(/^#/, "");
  if (pr && /^\d+$/.test(num) && pr === num) {
    const text = `PR #${pr}`;
    return { field: "pr", text, at: Array.from({ length: text.length - 3 }, (_, i) => i + 3), score: -2000 };
  }
  let best: (Snippet & { score: number }) | null = null;
  for (const field of ["summary", "body"] as const) {
    const m = findSnippet(row[field] ?? "", query);
    if (m && (!best || matchTier(m.score) < matchTier(best.score))) best = { field, ...m };
  }
  return best;
}

/**
 * ⌘K ticket results. With a query: the title first (word start, then anywhere), then the PR number,
 * result summary or description (shown as a snippet), then titles holding the letters in order. Within
 * the same kind of match the current board's tickets come first. Without a query: tickets still in play
 * (not Done), running ones first, then the most recently touched, current board first.
 */
export function rankTickets<R extends RankRow>(rows: R[], query: string, current: string | null, limit = 30): TicketHit<R>[] {
  const here = (r: R) => (r.profile === current ? 0 : 1);
  if (!query.trim()) {
    return rows
      .filter((r) => r.status !== "done")
      .sort((a, b) => here(a) - here(b) || Number(b.running) - Number(a.running) || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((row) => ({ row, at: [] }));
  }
  // Ranks: 0-1 title substring, 2 PR/summary/description, 3 title letters in order.
  const hits: (TicketHit<R> & { rank: number; score: number })[] = [];
  for (const row of rows) {
    const m = fuzzyMatch(row.title, query);
    const tier = m ? matchTier(m.score) : null;
    if (m && tier !== 2) {
      hits.push({ row, at: m.at, rank: tier!, score: m.score });
      continue;
    }
    const other = otherMatch(row, query);
    if (other) {
      const { score, ...snippet } = other;
      hits.push({ row, at: [], snippet, rank: 2, score });
    } else if (m) hits.push({ row, at: m.at, rank: 3, score: m.score });
  }
  return hits
    .sort((a, b) => a.rank - b.rank || here(a.row) - here(b.row) || a.score - b.score
      || b.row.updatedAt.localeCompare(a.row.updatedAt))
    .slice(0, limit)
    .map(({ row, at, snippet }) => (snippet ? { row, at, snippet } : { row, at }));
}
