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
}

export interface TicketHit<R extends RankRow> {
  row: R;
  at: number[];
}

/**
 * ⌘K ticket results. With a query: better match first, and within the same kind of match the current
 * board's tickets first. Without one: tickets still in play (not Done), running ones first, then the
 * most recently touched, current board first.
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
  const hits: (TicketHit<R> & { score: number })[] = [];
  for (const row of rows) {
    const m = fuzzyMatch(row.title, query);
    if (m) hits.push({ row, at: m.at, score: m.score });
  }
  return hits
    .sort((a, b) => matchTier(a.score) - matchTier(b.score) || here(a.row) - here(b.row) || a.score - b.score
      || b.row.updatedAt.localeCompare(a.row.updatedAt))
    .slice(0, limit)
    .map(({ row, at }) => ({ row, at }));
}
