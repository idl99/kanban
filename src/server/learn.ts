import { existsSync, readFileSync } from "node:fs";
import { type HuddleNote, type NoteScope, noteText, parseNotes } from "./huddle-notes";
import type { Corrections } from "./lessons";
import type { Ticket } from "./types";

// The board learns on its own (after ACE's reflect, curate and prune loop): lessons from the user's corrections on
// tickets and from huddle agents land in a quiet pile, and one is saved only once it comes back from another ticket or
// huddle (or the user's own words made it a standing rule: "always", "never"). Saved ticket lessons are rules every run
// on the board gets; saved huddle lessons are role notes (huddle-notes.ts). Every save and every tidy change is logged
// with the file before and after, so the user can undo it from the Team tab's Learned view.
// Plain helpers shared by the daemon (learner.ts) and its tests.

export type LearnKind = "ticket" | "huddle";

/** Where a saved lesson goes: the board's rules, or a role's notes (role "_all": every role). */
export type Dest = { kind: "rules"; slug: string } | { kind: "notes"; role: string; scope: NoteScope; slug: string };

export interface LearnSource {
  kind: LearnKind;
  slug: string;
  /** The ticket or huddle id. */
  id: string;
  /** Its title (a huddle's host ticket title), for the Learned view. */
  title: string;
  /** "you" (the user's correction) or the agent's handle. */
  by: string;
  at: string;
  /** The user's words or the agent's evidence, short. */
  quote: string;
  /** What counts as one source: the first ticket of an add-on chain, or the huddle. */
  key: string;
  /** A huddle's host ticket. */
  ticket?: string;
}

export type CandidateState = "watching" | "saved" | "undone" | "dropped";

export interface Candidate {
  id: string;
  kind: LearnKind;
  /** The lesson as one short general rule. */
  text: string;
  /** False while it couldn't be put in general words: it stays in the pile until it can. */
  general: boolean;
  dest: Dest;
  sources: LearnSource[];
  firstAt: string;
  lastAt: string;
  state: CandidateState;
  /** The user's words made it a standing rule (always, never, from now on): saved without a repeat. */
  standing?: boolean;
  /** The change that saved it. */
  changeId?: string;
}

export type ChangeKind = "saved" | "merged" | "rewrote" | "removed";

/** A file a change wrote, whole, before and after (null: it didn't exist), so the change can be undone exactly. */
export interface FileEdit {
  file: string;
  /** Whose notes: "rules" (the board's rules) or a role ("_all": every role). */
  role: string;
  scope: NoteScope;
  /** The board, for its rules and repo notes. */
  slug: string;
  before: string | null;
  after: string | null;
}

/** One change to the board's rules or the role notes: a saved lesson, or one step of a tidy pass. */
export interface LearnChange {
  id: string;
  at: string;
  kind: ChangeKind;
  /** The board it belongs to; null for notes every board shares. */
  slug: string | null;
  edits: FileEdit[];
  /** The lesson as saved (saved, merged, rewrote) or as it was (removed). */
  text: string;
  /** The notes it replaced (merged, rewrote) or removed. */
  old: string[];
  /** Why, in plain words (tidy steps). */
  why?: string;
  /** Where it went, in plain words: "Rule for this board", "Note for every teammate", "Note for qa". */
  where: string;
  candidateId?: string;
  sources?: LearnSource[];
  undoneAt?: string | null;
}

export interface Pile {
  candidates: Candidate[];
  /** Corrections already read, by "slug/ticketId". */
  scanned: Record<string, string[]>;
  /** Tickets updated before this aren't read (the pile doesn't learn from old history all at once). */
  since?: string;
  /** Last tidy pass. */
  tidyAt?: string | null;
  /** When the user last opened the Learned view, by board. */
  seen?: Record<string, string>;
}

export const emptyPile = (): Pile => ({ candidates: [], scanned: {} });

/** Candidates seen once are dropped after this many days. */
export const EXPIRE_DAYS = 60;
/** Most candidates kept per kind (watching ones first go, oldest first). */
export const PILE_CAP = 300;
/** Candidates a matching call is shown. */
export const SHORTLIST = 25;
/** Changes kept in the log. */
export const CHANGES_CAP = 500;
/** Days between tidy passes. */
export const TIDY_DAYS = 7;

const DAY = 86_400_000;

// ---- Which corrections are new ----

/** One key per correction, so a ticket corrected again later is read again for the new ones only. */
export function correctionKeys(c: Corrections): string[] {
  return [
    ...c.messages.map((e) => `msg:${e.uuid || e.at}`),
    ...(c.reopened ? ["reopen"] : []),
    ...(c.changesRequested ? ["changes"] : []),
    ...c.addOns.map((a) => `addon:${a.id}`),
  ];
}

/** c with only the corrections whose keys aren't in seen. */
export function newCorrections(c: Corrections, seen: string[]): Corrections {
  const has = new Set(seen);
  return {
    messages: c.messages.filter((e) => !has.has(`msg:${e.uuid || e.at}`)),
    reopened: c.reopened && !has.has("reopen"),
    changesRequested: c.changesRequested && !has.has("changes"),
    addOns: c.addOns.filter((a) => !has.has(`addon:${a.id}`)),
  };
}

/** A ticket's source key: its add-on chain's first ticket, so an add-on doesn't count as a repeat of its own ticket. */
export function ticketKey(slug: string, t: Pick<Ticket, "id" | "addOnOf">, tickets: Pick<Ticket, "id" | "addOnOf">[]): string {
  const byId = new Map(tickets.map((x) => [x.id, x]));
  let cur: Pick<Ticket, "id" | "addOnOf"> = t;
  const seen = new Set<string>();
  while (cur.addOnOf && byId.has(cur.addOnOf) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.addOnOf)!;
  }
  return `ticket:${slug}/${cur.id}`;
}

export const huddleKey = (slug: string, hid: string) => `huddle:${slug}/${hid}`;

// ---- Matching and promotion ----

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/** Two destinations a lesson can match across: same board's rules, or notes another board can see. */
function sameShelf(a: Candidate, kind: LearnKind, dest: Dest): boolean {
  if (a.kind !== kind) return false;
  if (dest.kind === "rules" || a.dest.kind === "rules") return a.dest.slug === dest.slug;
  // Notes: general ones match from any board; repo ones only on their board.
  return dest.scope === "general" && a.dest.scope === "general" ? true : a.dest.slug === dest.slug;
}

/**
 * The candidates a new lesson may match: same kind and shelf, most word overlap first (all of them when there are
 * few). Saved, undone and dropped ones are in: a match to a saved one counts, one to an undone or dropped one stops it.
 */
export function shortlist(pile: Pile, kind: LearnKind, dest: Dest, text: string, n = SHORTLIST): Candidate[] {
  const pool = pile.candidates.filter((c) => sameShelf(c, kind, dest));
  if (pool.length <= n) return pool;
  const w = words(text);
  const score = (c: Candidate) => [...words(c.text)].filter((x) => w.has(x)).length;
  return pool.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s || b.c.lastAt.localeCompare(a.c.lastAt)).slice(0, n).map((x) => x.c);
}

/** Distinct sources (tickets or huddles) a candidate came from. */
export const sourceCount = (c: Candidate) => new Set(c.sources.map((s) => s.key)).size;

/** Saved when it is general and came from two tickets or huddles, or the user made it a standing rule. */
export const shouldPromote = (c: Candidate) => c.state === "watching" && c.general && !!c.text && (sourceCount(c) >= 2 || !!c.standing);

export interface Learned {
  /** The lesson in general words; "" when it can't be. */
  text: string;
  /** The candidate it is the same lesson as, or null. */
  match: string | null;
  /** The user's words that made it a standing rule (only taken when they appear in what the user typed). */
  standing?: string | null;
  /** The user's words that corrected it (ticket lessons). */
  evidence?: string;
  /** What went wrong (ticket lessons). */
  mistake?: string;
}

/**
 * Adds a lesson to the pile: to the candidate it matches (a new source for it), or as a new candidate. Returns the
 * candidate it went to. A match to a saved candidate adds the source and stays saved; to an undone or dropped one, it
 * stays so (the user said no).
 */
export function addToPile(pile: Pile, l: Learned, o: { kind: LearnKind; dest: Dest; source: LearnSource; userText?: string; newId: () => string }): Candidate {
  const text = noteText(l.text);
  const standing = !!l.standing && !!o.userText && o.userText.toLowerCase().includes(l.standing.trim().toLowerCase()) && l.standing.trim().length > 2;
  const hit = l.match ? pile.candidates.find((c) => c.id === l.match && sameShelf(c, o.kind, o.dest)) : undefined;
  if (hit) {
    if (!hit.sources.some((s) => s.key === o.source.key && s.at === o.source.at)) hit.sources.push(o.source);
    hit.lastAt = o.source.at;
    if (standing) hit.standing = true;
    // A clearer general wording wins while it isn't saved yet.
    if (hit.state === "watching" && text && (!hit.general || !hit.text)) {
      hit.text = text;
      hit.general = true;
    }
    // Lessons from different roles, or a general one, go to every role / every board.
    if (hit.dest.kind === "notes" && o.dest.kind === "notes" && hit.state === "watching") {
      if (hit.dest.role !== o.dest.role) hit.dest = { ...hit.dest, role: "_all" };
      if (o.dest.scope === "general" || hit.dest.slug !== o.dest.slug) hit.dest = { ...hit.dest, scope: "general" };
    }
    return hit;
  }
  const c: Candidate = {
    id: o.newId(), kind: o.kind, text: text || noteText(o.source.quote), general: !!text, dest: o.dest, sources: [o.source],
    firstAt: o.source.at, lastAt: o.source.at, state: "watching", ...(standing ? { standing: true } : {}),
  };
  pile.candidates.push(c);
  return c;
}

/**
 * Drops watching candidates seen once and older than EXPIRE_DAYS, then keeps at most cap per kind. Undone and dropped
 * ones always stay: they keep a lesson the user said no to from coming back.
 */
export function prune(pile: Pile, now: Date, cap = PILE_CAP): Pile {
  const cut = now.getTime() - EXPIRE_DAYS * DAY;
  let cs = pile.candidates.filter((c) => !(c.state === "watching" && sourceCount(c) < 2 && Date.parse(c.lastAt) < cut));
  for (const kind of ["ticket", "huddle"] as const) {
    const mine = cs.filter((c) => c.kind === kind);
    if (mine.length <= cap) continue;
    // Watching ones go first, oldest first; then the oldest saved ones.
    const order = mine.filter((c) => c.state === "watching" || c.state === "saved")
      .sort((a, b) => (a.state === "watching" ? 0 : 1) - (b.state === "watching" ? 0 : 1) || a.lastAt.localeCompare(b.lastAt));
    const drop = new Set(order.slice(0, mine.length - cap));
    cs = cs.filter((c) => !drop.has(c));
  }
  return { ...pile, candidates: cs };
}

// ---- The board's rules file (same line format as role notes) ----

export function serializeRules(notes: HuddleNote[]): string {
  const src = (n: HuddleNote) => [n.by === "you" ? "by you" : `from @${n.by}`, n.date].filter(Boolean).join(", ");
  return "# Lessons learned on this board\n<!-- Newest first. Every run on this board gets these. Undo them from the Team tab's Learned view. -->\n\n"
    + notes.map((n) => `- ${noteText(n.text)} <!-- ${src(n)} -->\n`).join("");
}

/** The rules as a block for a run's first prompt; "" for none. */
export function rulesBlock(rules: HuddleNote[]): string {
  if (!rules.length) return "";
  return `# Lessons learned on this board\nThe board saved these from corrections the user made on earlier tickets. Follow them unless this ticket or the user says otherwise:\n${rules.slice(0, 30).map((r) => `- ${noteText(r.text)}`).join("\n")}`;
}

/** The board's learned rules as a run's prompt block; "" for none. */
export function learnedRulesBlock(store: { boardRulesPath(slug: string): string }, slug: string): string {
  const file = store.boardRulesPath(slug);
  return existsSync(file) ? rulesBlock(parseNotes(readFileSync(file, "utf8"))) : "";
}

// ---- Undo and redo ----

const texts = (md: string | null) => (md ? parseNotes(md) : []);
const key = (n: HuddleNote) => noteText(n.text).toLowerCase();

const counts = (ns: HuddleNote[]) => {
  const m = new Map<string, number>();
  for (const n of ns) m.set(key(n), (m.get(key(n)) ?? 0) + 1);
  return m;
};

/** The n-th (1-based) note with k's text in ns, else the last one; -1 when there is none. */
function nth(ns: HuddleNote[], k: string, n: number): number {
  let seen = 0;
  let last = -1;
  for (let i = 0; i < ns.length; i++) {
    if (key(ns[i]) !== k) continue;
    last = i;
    if (++seen === n) return i;
  }
  return last;
}

/**
 * Moves current from one version of a notes file to another, note by note, counting notes with the same text: notes
 * `from` has more of than `to` are taken out, notes `to` has more of are put back at their place there. Notes the user
 * added or changed meanwhile stay.
 */
export function shiftNotes(current: HuddleNote[], from: string | null, to: string | null): HuddleNote[] {
  const a = texts(from);
  const b = texts(to);
  const inA = counts(a);
  const inB = counts(b);
  const out = [...current];
  // Where the first note taken out was: a rewritten note goes back to its own place.
  let was = -1;
  for (const [k, n] of inA) {
    for (let extra = n - (inB.get(k) ?? 0); extra > 0; extra--) {
      const i = out.findIndex((x) => key(x) === k);
      if (i < 0) break;
      if (was < 0 || i < was) was = i;
      out.splice(i, 1);
    }
  }
  const rank = new Map<string, number>();
  const ranks = b.map((n) => {
    const r = (rank.get(key(n)) ?? 0) + 1;
    rank.set(key(n), r);
    return r;
  });
  b.forEach((n, i) => {
    const k = key(n);
    // Already in `from` (it stays), or already back.
    if (ranks[i] <= (inA.get(k) ?? 0) || (counts(out).get(k) ?? 0) >= ranks[i]) return;
    // Where the note it replaces was (a rewrite or merge undone); else between its neighbours in `to`: after the
    // nearest one before it that is still there, else before the nearest one after it; else on top.
    let at = -1;
    if (was >= 0) {
      at = Math.min(was, out.length);
      was = -1;
    }
    for (let j = i - 1; j >= 0 && at < 0; j--) {
      const x = nth(out, key(b[j]), ranks[j]);
      if (x >= 0) at = x + 1;
    }
    for (let j = i + 1; j < b.length && at < 0; j++) at = nth(out, key(b[j]), ranks[j]);
    out.splice(Math.max(at, 0), 0, n);
  });
  return out;
}

// ---- Side call answers ----

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function jsonObject(text: string): Record<string, unknown> | null {
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from < 0 || to < from) return null;
  try {
    const v = JSON.parse(text.slice(from, to + 1));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * What a learning call found, in its order: each lesson in general words ("" when it can't be), its match among the
 * ids it was shown, and the user's words. Entries with neither a rule nor a match are dropped unless keepEmpty (huddle
 * lessons line up with the proposed ones). Null when the answer isn't the JSON asked for.
 */
export function parseLearned(text: string, ids: string[], o: { max?: number; keepEmpty?: boolean } = {}): Learned[] | null {
  const v = jsonObject(text);
  if (!v || !Array.isArray(v.lessons)) return null;
  const out: Learned[] = [];
  for (const l of v.lessons as Record<string, unknown>[]) {
    const t = noteText(str(l?.rule ?? l?.text)).slice(0, 300);
    const match = str(l?.match);
    if (!t && !match && !o.keepEmpty) continue;
    out.push({
      text: t, match: match && ids.includes(match) ? match : null, standing: str(l?.standing) || null,
      evidence: noteText(str(l?.evidence)).slice(0, 300), mistake: noteText(str(l?.mistake)).slice(0, 300),
    });
  }
  return out.slice(0, o.max ?? 3);
}

/** One note in a tidy call's numbered list: whose file it is in. */
export interface TidyNote {
  role: string;
  note: HuddleNote;
}

export type TidyOp =
  | { op: "merge"; ids: number[]; text: string; to: string; why: string }
  | { op: "rewrite"; id: number; text: string; to: string; why: string }
  | { op: "remove"; id: number; why: string };

/**
 * The tidy call's steps on a numbered list of notes, checked: known numbers only, each note in one step at most,
 * never a note the user wrote, merges of two or more, non-empty texts, and a target role among `roles` (the note's own
 * role when missing or unknown).
 */
export function parseTidy(text: string, list: TidyNote[], roles: string[]): TidyOp[] | null {
  const v = jsonObject(text);
  if (!v || !Array.isArray(v.ops)) return null;
  const used = new Set<number>(list.flatMap((n, i) => (n.note.by === "you" ? [i + 1] : [])));
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= list.length && !used.has(n as number);
  const role = (to: unknown, first: number) => (typeof to === "string" && roles.includes(to.trim()) ? to.trim() : list[first - 1].role);
  const out: TidyOp[] = [];
  for (const o of v.ops as Record<string, unknown>[]) {
    const why = noteText(str(o?.why)).slice(0, 200);
    const t = noteText(str(o?.text)).slice(0, 400);
    const ids = Array.isArray(o?.ids) ? [...new Set(o.ids as unknown[])] : o?.id !== undefined ? [o.id] : [];
    if (o?.op === "merge") {
      if (ids.length < 2 || !ids.every(ok) || !t) continue;
      ids.forEach((n) => used.add(n as number));
      out.push({ op: "merge", ids: ids as number[], text: t, to: role(o.to ?? o.file, ids[0] as number), why });
    } else if (o?.op === "rewrite") {
      if (ids.length !== 1 || !ok(ids[0]) || !t) continue;
      const id = ids[0] as number;
      used.add(id);
      // Unchanged text in the same file is no change.
      const to = role(o.to ?? o.file, id);
      if (t === noteText(list[id - 1].note.text) && to === list[id - 1].role) continue;
      out.push({ op: "rewrite", id, text: t, to, why });
    } else if (o?.op === "remove") {
      if (ids.length !== 1 || !ok(ids[0])) continue;
      used.add(ids[0] as number);
      out.push({ op: "remove", id: ids[0] as number, why });
    }
  }
  return out;
}

/**
 * The role files after one tidy step. Its numbers are 1-based positions in `list` (what the call was shown); notes are
 * found by identity, so earlier steps moving things around don't matter. A merged or rewritten note takes the place of
 * the first note it replaces when it stays in that file, else it goes on top of its new file.
 */
export function applyTidyOp(files: Record<string, HuddleNote[]>, op: TidyOp, list: TidyNote[], today: string): Record<string, HuddleNote[]> {
  const ids = op.op === "merge" ? op.ids : [op.id];
  const refs = ids.map((n) => list[n - 1]);
  const gone = new Set(refs.map((r) => r.note));
  const out: Record<string, HuddleNote[]> = {};
  for (const [role, ns] of Object.entries(files)) out[role] = ns.filter((n) => !gone.has(n));
  if (op.op === "remove") return out;
  const first = refs[0];
  const note: HuddleNote = { ...first.note, text: op.text, ...(op.op === "merge" ? { date: today } : {}) };
  const target = out[op.to] ?? [];
  const at = op.to === first.role ? files[first.role].indexOf(first.note) : 0;
  // Its old place, counting only the notes still there before it.
  const place = at <= 0 ? 0 : files[first.role].slice(0, at).filter((n) => !gone.has(n)).length;
  out[op.to] = [...target.slice(0, place), note, ...target.slice(place)];
  return out;
}

// ---- Prompts ----

/** How a lesson must read, shared by every prompt here. */
const GENERAL = "A lesson is one short rule (at most 200 characters) that would help on a different task: what to do and when. No ticket or issue ids, ticket names, people, message numbers, counts, or paths and examples that only fit this one task (a command or file name only when the rule can't be followed without it).";

const PLAIN = "Write for a person who is not technical: plain everyday words. No filler, no em dashes, no arrows standing in for words, no made-up abbreviations. Write in the language the user writes in.";

export const LEARN_SYSTEM = `You help an AI coding assistant (Claude) stop repeating mistakes on a person's project. You get a finished task: what was asked, the conversation, the user's corrections, and PILE: lessons noted on earlier tasks, each as [id] text.

Find mistakes Claude made that the user had to correct. Only count one that would come back on other tasks in this project; skip one-off slips, changes of mind, and new wishes that were not mistakes. Return 0 to 3 lessons; fewer is better, and none is often the honest answer.

${GENERAL} When the mistake can't be put that way, set rule to "".

For each lesson, set match to the id of the PILE lesson that says the same thing (following one makes following the other unnecessary), or "" when none does.
Set standing to the user's exact words, copied character for character from what they typed, only when they said the rule holds from now on ("always", "never", "from now on", "every time", or the same in their language); otherwise "".

Answer with JSON only, no other text:
{"lessons":[{"mistake":"...","evidence":"...","rule":"...","match":"","standing":""}]}
- mistake: what went wrong, one plain sentence.
- evidence: the user's own words that corrected it, quoted exactly (shorten with … if long).

${PLAIN}`;

export const HUDDLE_LEARN_SYSTEM = `You keep the notes that helper AI agents (huddle teammates) get in their instructions. An agent that finished its job proposed lessons for future agents. You also get PILE: lessons noted before, each as [id] text.

For each proposed lesson, in order:
- rule: the lesson rewritten as a general rule. ${GENERAL} When it can't be put that way, "".
- match: the id of the PILE lesson that says the same thing (following one makes following the other unnecessary), or "".

Answer with JSON only, no other text, one entry per proposed lesson:
{"lessons":[{"rule":"...","match":""}]}

${PLAIN}`;

export const TIDY_SYSTEM = `You tidy the notes that helper AI agents (huddle teammates) get in their instructions. Fewer, sharper notes are better: extra notes distract the agents. You get the notes as a numbered list, each with the file (role) it is in; "_all" is read by every role.

For each note that should change, return one step:
- "rewrite": the note in general words, or moved to another file with "to" (a general note in one role's file goes to "_all"). ${GENERAL}
- "merge": two or more notes that say the same thing become one, in "to" ("_all" when they come from different roles).
- "remove": a note that only fit one task, a stale fact, or one another note already covers.
Leave good notes out (no step means keep). Never invent a rule that isn't in the notes. Every step needs "why": one short plain sentence.

Answer with JSON only, no other text:
{"ops":[{"op":"rewrite","id":3,"text":"...","to":"_all","why":"..."},{"op":"merge","ids":[1,4],"text":"...","to":"_all","why":"..."},{"op":"remove","id":2,"why":"..."}]}

${PLAIN}`;

/** The PILE section of a learning prompt. */
export function pileText(cs: Candidate[]): string {
  return cs.length ? cs.map((c) => `[${c.id}] ${c.text}`).join("\n") : "(empty)";
}

/** The prompt of a huddle learning call: the proposed lessons and the pile. */
export function huddleLearnPrompt(role: string, lessons: { text: string; evidence: string }[], pile: Candidate[]): string {
  return [
    `Proposed by an agent in the role "${role}":`,
    lessons.map((l, i) => `${i + 1}. ${l.text}${l.evidence ? ` (evidence: ${l.evidence})` : ""}`).join("\n"),
    `PILE:\n${pileText(pile)}`,
  ].join("\n\n");
}

/** The prompt of a tidy call: the numbered notes with their files. */
export function tidyPrompt(list: TidyNote[], roles: string[]): string {
  return [
    `Files: ${roles.join(", ")}`,
    `Notes:\n${list.map((n, i) => `${i + 1}. (${n.role}) ${noteText(n.note.text)}`).join("\n")}`,
  ].join("\n\n");
}
