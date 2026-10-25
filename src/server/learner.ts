import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Bus } from "./events";
import { ALL_ROLES, type HuddleNote, type LessonInput, type NoteScope, noteText, parseNotes, serializeNotes } from "./huddle-notes";
import {
  addToPile, applyTidyOp, type Candidate, CHANGES_CAP, correctionKeys, type Dest, emptyPile, type FileEdit, HUDDLE_LEARN_SYSTEM, huddleKey, huddleLearnPrompt,
  type LearnChange, LEARN_SYSTEM, type Learned, newCorrections, parseLearned, parseTidy, type Pile, pileText, prune, serializeRules,
  shiftNotes, shortlist, shouldPromote, TIDY_DAYS, TIDY_SYSTEM, type TidyNote, type TidyOp, ticketKey, tidyPrompt,
} from "./learn";
import { corrections, hasCorrections, lessonsPrompt, projectRules } from "./lessons";
import type { SessionEntry } from "./session";
import { addSideSpend, type SideCaller } from "./side-call";
import { atomicWrite, type Store } from "./store";
import type { Huddle, HuddleParticipant, Ticket } from "./types";

// The daemon's side of learn.ts: reads corrected tickets once they settle in Review or Done, takes huddle agents'
// lessons, saves the ones that come back, tidies the notes once a week, and undoes any of it on the user's click.
// Everything goes through one queue, so the pile and the files are never written by two steps at once.

/** Learning calls read a transcript and the pile: the cheap model is enough (a wrong match only delays a lesson). */
export const LEARN_MODEL = "haiku";
/** The tidy pass rewrites what every future agent reads: worth the better model, once a week. */
export const TIDY_MODEL = "sonnet";
/** Saved lessons the Learned view lists: this week's. */
const SAVED_DAYS = 7;
/** Tidy steps it lists. */
const CLEANED_DAYS = 30;
/** Seen-once lessons it lists. */
const WATCHING_MAX = 50;

const DAY = 86_400_000;

export interface LearnerOptions {
  sideCall: SideCaller;
  /** The ticket's conversation. */
  entries: (t: Ticket) => SessionEntry[];
  isRunning: (slug: string, id: string) => boolean;
  now?: () => Date;
  /** How long a ticket stays in Review or Done before it is read (the user may correct it again). Default 2 minutes. */
  settleMs?: number;
  /** How often a due tidy pass is checked. Default hourly; 0: never on its own. */
  tidyCheckMs?: number;
  newId?: () => string;
}

export interface LearnedView {
  /** Lessons saved this week (undone ones too, marked), newest first. */
  saved: LearnChange[];
  /** Tidy steps of the last month, newest first. */
  cleaned: LearnChange[];
  /** Lessons seen once, newest first. */
  watching: Candidate[];
  /** Saved since the user last opened the view. */
  newCount: number;
  tidyAt: string | null;
}

export class LearnError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const isLearnable = (t: Ticket) => t.status === "review" || t.status === "done";

/** Where a lesson went, in plain words. */
export function whereText(d: Dest): string {
  if (d.kind === "rules") return "Rule for this board";
  const who = d.role === ALL_ROLES ? "every teammate" : d.role;
  return `Note for ${who}${d.scope === "general" ? ", all boards" : ""}`;
}

export class Learner {
  private chain: Promise<unknown> = Promise.resolve();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private now: () => Date;
  private newId: () => string;

  constructor(private store: Store, private bus: Bus, private o: LearnerOptions) {
    this.now = o.now ?? (() => new Date());
    this.newId = o.newId ?? (() => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  }

  // ---- Files ----

  private get pileFile() {
    return join(this.store.learnedDir(), "pile.json");
  }

  private get changesFile() {
    return join(this.store.learnedDir(), "changes.json");
  }

  readPile(): Pile {
    try {
      const v = JSON.parse(readFileSync(this.pileFile, "utf8"));
      return v && Array.isArray(v.candidates) ? { ...emptyPile(), ...v } : emptyPile();
    } catch {
      return emptyPile();
    }
  }

  private writePile(p: Pile) {
    mkdirSync(this.store.learnedDir(), { recursive: true });
    atomicWrite(this.pileFile, JSON.stringify(p, null, 2) + "\n");
  }

  changes(): LearnChange[] {
    try {
      const v = JSON.parse(readFileSync(this.changesFile, "utf8"));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  private writeChanges(cs: LearnChange[]) {
    mkdirSync(this.store.learnedDir(), { recursive: true });
    atomicWrite(this.changesFile, JSON.stringify(cs.slice(-CHANGES_CAP), null, 2) + "\n");
  }

  /** The board's learned rules, newest first. */
  rules(slug: string): HuddleNote[] {
    const file = this.store.boardRulesPath(slug);
    return existsSync(file) ? parseNotes(readFileSync(file, "utf8")) : [];
  }

  /** Rules the board's runs get already: learned ones, and the project's CLAUDE.md "## Lessons" bullets. */
  private existingRules(slug: string): string[] {
    const folder = this.store.getProfile(slug)?.path;
    return [...this.rules(slug).map((r) => r.text), ...(folder ? projectRules(folder) : [])];
  }

  /** A role's notes file (role "rules": the board's rules) and how it is written. */
  private shelf(slug: string, role: string, scope: NoteScope) {
    const rules = role === "rules";
    const file = rules ? this.store.boardRulesPath(slug) : this.store.huddleNotesPath(slug, role, scope);
    return { file, write: (ns: HuddleNote[]) => (rules ? serializeRules(ns) : serializeNotes(role, scope, ns)) };
  }

  private static read(file: string): string | null {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }

  private static put(file: string, text: string | null) {
    if (text === null) rmSync(file, { force: true });
    else {
      mkdirSync(join(file, ".."), { recursive: true });
      atomicWrite(file, text);
    }
  }

  /** Changes one notes file through fn, returning the edit (the whole file before and after). */
  private editNotes(slug: string, role: string, scope: NoteScope, fn: (ns: HuddleNote[]) => HuddleNote[]): FileEdit {
    const { file, write } = this.shelf(slug, role, scope);
    const before = Learner.read(file);
    const after = write(fn(before ? parseNotes(before) : []));
    Learner.put(file, after);
    return { file, role, scope, slug, before, after };
  }

  /** Runs one step at a time: the pile and the files are read and written by one step only. */
  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  private emit(slug: string | null) {
    this.bus.emit({ type: "learned.updated", profile: slug });
  }

  private addChange(c: LearnChange) {
    this.writeChanges([...this.changes(), c]);
  }

  // ---- Watching tickets ----

  /** Starts watching tickets settle and the weekly tidy; returns stop. */
  start(): () => void {
    const pile = this.readPile();
    if (!pile.since) this.writePile({ ...pile, since: this.now().toISOString() });
    const since = this.readPile().since!;
    // Tickets that settled while the daemon was down.
    for (const p of this.store.listProfiles()) {
      for (const t of this.store.listTickets(p.slug)) if (isLearnable(t) && t.updatedAt >= since) this.schedule(p.slug, t.id);
    }
    const off = this.bus.on((e) => {
      if (e.type !== "ticket.updated") return;
      if (isLearnable(e.ticket)) this.schedule(e.profile, e.ticket.id);
      // A new add-on ticket is a correction of the ticket it follows up.
      if (e.ticket.addOnOf) this.schedule(e.profile, e.ticket.addOnOf);
    });
    const every = this.o.tidyCheckMs ?? 3_600_000;
    const check = () => void this.tidyIfDue().catch((err) => console.error("tidy pass failed:", err));
    const first = every > 0 ? setTimeout(check, 60_000) : null;
    const tick = every > 0 ? setInterval(check, every) : null;
    return () => {
      off();
      if (first) clearTimeout(first);
      if (tick) clearInterval(tick);
      for (const t of this.timers.values()) clearTimeout(t);
      this.timers.clear();
    };
  }

  private schedule(slug: string, id: string) {
    const k = `${slug}/${id}`;
    clearTimeout(this.timers.get(k));
    this.timers.set(k, setTimeout(() => {
      this.timers.delete(k);
      void this.scanTicket(slug, id).catch((err) => console.error(`learning from ${k} failed:`, err));
    }, this.o.settleMs ?? 120_000));
  }

  /**
   * Reads a settled ticket's new corrections (each only once) into the pile with one cheap call; saves a lesson that
   * came back or that the user made a standing rule. Returns the candidates it touched.
   */
  scanTicket(slug: string, id: string): Promise<Candidate[]> {
    return this.serial(async () => {
      const t = this.store.getTicket(slug, id);
      if (!t || !isLearnable(t) || this.o.isRunning(slug, id)) return [];
      let pile = this.readPile();
      if (pile.since && t.updatedAt < pile.since) return [];
      const entries = this.o.entries(t);
      const tickets = this.store.listTickets(slug);
      const all = corrections(t, entries, tickets);
      const k = `${slug}/${id}`;
      const fresh = newCorrections(all, pile.scanned[k] ?? []);
      if (!hasCorrections(fresh)) return [];
      // Marked read before the call: a failing call isn't repeated on every update.
      pile.scanned[k] = [...new Set([...(pile.scanned[k] ?? []), ...correctionKeys(all)])];
      this.writePile(pile);
      const dest: Dest = { kind: "rules", slug };
      const said = fresh.messages.map((e) => e.text).join("\n");
      const short = shortlist(pile, "ticket", dest, `${t.title} ${said}`);
      const prompt = `${lessonsPrompt({ ticket: t, entries, corrections: fresh, existing: this.existingRules(slug) })}\n\nPILE:\n${pileText(short)}`;
      const r = await this.o.sideCall({ system: LEARN_SYSTEM, prompt, model: LEARN_MODEL, timeoutMs: 180_000 });
      if (!r.ok) {
        console.error(`learning from ${k}: ${r.error}`);
        return [];
      }
      addSideSpend(this.store.sideSpendPath(slug, id), "learn", r.costUsd);
      const found = parseLearned(r.text, short.map((c) => c.id));
      if (!found?.length) return [];
      pile = this.readPile();
      const at = this.now().toISOString();
      const key = ticketKey(slug, t, tickets);
      const out: Candidate[] = [];
      for (const l of found) {
        const quote = noteText(l.evidence || l.mistake || "").slice(0, 200);
        const c = addToPile(pile, l, {
          kind: "ticket", dest, userText: said, newId: this.newId,
          source: { kind: "ticket", slug, id, title: t.title, by: "you", at, quote, key },
        });
        if (shouldPromote(c)) this.promote(c);
        out.push(c);
      }
      this.writePile(prune(pile, this.now()));
      this.emit(slug);
      return out;
    });
  }

  // ---- Huddle lessons ----

  /** Lessons a huddle agent proposed when it turned done: into the pile, saved once they come back. role: where they would go. */
  addHuddleLessons(slug: string, h: Pick<Huddle, "id" | "hostTicket">, p: Pick<HuddleParticipant, "handle">, role: string, lessons: LessonInput[]): Promise<Candidate[]> {
    return this.serial(async () => {
      if (!lessons.length) return [];
      let pile = this.readPile();
      const dests: Dest[] = lessons.map((l) => ({ kind: "notes", role, scope: l.scope, slug }));
      const short = [...new Map(dests.flatMap((d, i) => shortlist(pile, "huddle", d, lessons[i].text)).map((c) => [c.id, c])).values()].slice(0, 40);
      const r = await this.o.sideCall({ system: HUDDLE_LEARN_SYSTEM, prompt: huddleLearnPrompt(role, lessons, short), model: LEARN_MODEL, timeoutMs: 120_000 });
      if (r.ok) addSideSpend(this.store.sideSpendPath(slug, h.hostTicket), "learn", r.costUsd);
      else console.error(`learning from huddle ${h.id}: ${r.error}`);
      // Without an answer they still wait in the pile, in the agent's words, until a later one matches them.
      const found = (r.ok ? parseLearned(r.text, short.map((c) => c.id), { keepEmpty: true }) : null) ?? [];
      pile = this.readPile();
      const at = this.now().toISOString();
      const title = this.store.getTicket(slug, h.hostTicket)?.title ?? "a huddle";
      const out: Candidate[] = [];
      lessons.forEach((l, i) => {
        const learned: Learned = found[i] ?? { text: "", match: null };
        const c = addToPile(pile, learned, {
          kind: "huddle", dest: dests[i], newId: this.newId,
          source: { kind: "huddle", slug, id: h.id, title, by: p.handle, at, quote: l.text, key: huddleKey(slug, h.id), ticket: h.hostTicket },
        });
        if (shouldPromote(c)) this.promote(c);
        out.push(c);
      });
      this.writePile(prune(pile, this.now()));
      this.emit(slug);
      return out;
    });
  }

  // ---- Saving ----

  /** Writes a candidate where it goes (newest first) and logs the change; the caller writes the pile. */
  private promote(c: Candidate) {
    const today = this.now().toISOString().slice(0, 10);
    const last = c.sources.at(-1);
    const d = c.dest;
    const note: HuddleNote = {
      text: c.text, by: c.kind === "ticket" ? "board" : last?.by ?? "board", date: today, huddle: c.kind === "huddle" ? last?.id ?? null : null,
    };
    const same = (n: HuddleNote) => noteText(n.text).toLowerCase() === noteText(c.text).toLowerCase();
    const edit = d.kind === "rules"
      ? this.editNotes(d.slug, "rules", "repo", (ns) => [note, ...ns.filter((n) => !same(n))])
      : this.editNotes(d.slug, d.role, d.scope, (ns) => [note, ...ns.filter((n) => !same(n))]);
    const change: LearnChange = {
      id: this.newId(), at: this.now().toISOString(), kind: "saved", slug: d.kind === "notes" && d.scope === "general" ? null : d.slug,
      edits: [edit], text: c.text, old: [], where: whereText(d), candidateId: c.id, sources: c.sources,
    };
    c.state = "saved";
    c.changeId = change.id;
    this.addChange(change);
  }

  /** The user saves a lesson seen once now ("Save now"). */
  saveNow(id: string): Promise<Candidate> {
    return this.serial(() => {
      const pile = this.readPile();
      const c = pile.candidates.find((x) => x.id === id);
      if (!c) throw new LearnError(404, "that lesson is gone");
      if (c.state !== "watching") throw new LearnError(409, `that lesson was already ${c.state}`);
      if (!c.general) throw new LearnError(409, "that lesson isn't in general words yet; the board saves it once it comes up again");
      this.promote(c);
      this.writePile(pile);
      this.emit(c.dest.kind === "notes" && c.dest.scope === "general" ? null : c.dest.slug);
      return c;
    });
  }

  /** The user drops a lesson seen once (keep: puts it back). */
  drop(id: string, keep = false): Promise<Candidate> {
    return this.serial(() => {
      const pile = this.readPile();
      const c = pile.candidates.find((x) => x.id === id);
      if (!c) throw new LearnError(404, "that lesson is gone");
      if (c.state !== (keep ? "dropped" : "watching")) throw new LearnError(409, `that lesson is ${c.state}`);
      c.state = keep ? "watching" : "dropped";
      this.writePile(pile);
      // No event: the view keeps the row (with Undo) until it loads again.
      return c;
    });
  }

  // ---- Undo and redo ----

  /**
   * Undoes a change (redo: does it again): each file goes back to exactly how it was when nothing else changed it
   * since, else note by note, keeping what the user changed meanwhile. An undone saved lesson is not saved again.
   */
  undo(id: string, redo = false): Promise<LearnChange> {
    return this.serial(() => {
      const cs = this.changes();
      const c = cs.find((x) => x.id === id);
      if (!c) throw new LearnError(404, "that change is gone");
      if (redo ? !c.undoneAt : !!c.undoneAt) throw new LearnError(409, redo ? "that change isn't undone" : "that change was already undone");
      for (const e of redo ? c.edits : [...c.edits].reverse()) {
        const [from, to] = redo ? [e.before, e.after] : [e.after, e.before];
        const { write } = this.shelf(e.slug, e.role, e.scope);
        const now = Learner.read(e.file);
        if (now === from) Learner.put(e.file, to);
        else {
          const ns = shiftNotes(now ? parseNotes(now) : [], from, to);
          // The file didn't exist before and nothing is left in it: it goes again.
          Learner.put(e.file, !ns.length && to === null ? null : write(ns));
        }
      }
      c.undoneAt = redo ? null : this.now().toISOString();
      this.writeChanges(cs);
      if (c.candidateId) {
        const pile = this.readPile();
        const cand = pile.candidates.find((x) => x.id === c.candidateId);
        if (cand) {
          cand.state = redo ? "saved" : "undone";
          this.writePile(pile);
        }
      }
      this.emit(c.slug);
      return c;
    });
  }

  // ---- Tidy ----

  /** Runs the tidy pass when it never ran or ran TIDY_DAYS ago. */
  async tidyIfDue(): Promise<LearnChange[]> {
    const last = this.readPile().tidyAt;
    if (last && this.now().getTime() - Date.parse(last) < TIDY_DAYS * DAY) return [];
    return this.tidy();
  }

  /**
   * One tidy call per group of notes (the notes every board shares, then each board's own, then each board's rules):
   * merges look-alikes, rewrites task-bound notes in general words, removes stale ones. Applied at once, one logged
   * change per step. Notes the user wrote are never touched.
   */
  tidy(): Promise<LearnChange[]> {
    return this.serial(async () => {
      const out: LearnChange[] = [];
      const groups: { slug: string; scope: NoteScope; roles: string[] }[] = [];
      const boards = this.store.listProfiles();
      if (boards.length) groups.push({ slug: boards[0].slug, scope: "general", roles: this.store.noteFileRoles(boards[0].slug, "general") });
      for (const b of boards) {
        groups.push({ slug: b.slug, scope: "repo", roles: this.store.noteFileRoles(b.slug, "repo") });
        if (existsSync(this.store.boardRulesPath(b.slug))) groups.push({ slug: b.slug, scope: "repo", roles: ["rules"] });
      }
      let called = 0;
      let failed = 0;
      for (const g of groups) {
        try {
          const steps = await this.tidyGroup(g.slug, g.scope, g.roles);
          if (steps) called++;
          out.push(...(steps ?? []));
        } catch (err) {
          called++;
          failed++;
          console.error(`tidy ${g.scope} ${g.slug}:`, err);
        }
      }
      // Every call failed (Claude out of reach): the next hourly check tries again, not next week.
      if (failed && failed === called) return out;
      const pile = this.readPile();
      this.writePile({ ...pile, tidyAt: this.now().toISOString() });
      if (out.length) this.emit(null);
      return out;
    });
  }

  /** One group's tidy steps; null when there was nothing to ask about (no call made). */
  private async tidyGroup(slug: string, scope: NoteScope, roles: string[]): Promise<LearnChange[] | null> {
    const raw = () => roles.map((r) => Learner.read(this.shelf(slug, r, scope).file));
    const was = raw();
    const files = Object.fromEntries(roles.map((r, i) => [r, was[i] ? parseNotes(was[i]!) : []])) as Record<string, HuddleNote[]>;
    const list: TidyNote[] = roles.flatMap((role) => files[role].map((note) => ({ role, note })));
    // Nothing to tidy: no notes, or only the user's own.
    if (!list.some((n) => n.note.by !== "you")) return null;
    const targets = roles.includes("rules") ? ["rules"] : [...new Set([...roles, ALL_ROLES])];
    const r = await this.o.sideCall({ system: TIDY_SYSTEM, prompt: tidyPrompt(list, targets), model: TIDY_MODEL, timeoutMs: 240_000 });
    if (!r.ok) throw new Error(r.error);
    // The user changed these notes during the call: their change wins, the group waits for the next pass.
    if (raw().some((t, i) => t !== was[i])) return [];
    const ops = parseTidy(r.text, list, targets) ?? [];
    const today = this.now().toISOString().slice(0, 10);
    const out: LearnChange[] = [];
    let cur = files;
    for (const op of ops) {
      const next = applyTidyOp(cur, op, list, today);
      const touched = Object.keys(next).filter((role) => next[role] !== cur[role] && JSON.stringify(next[role]) !== JSON.stringify(cur[role] ?? []));
      const edits = touched.map((role) => this.editNotes(slug, role, scope, () => next[role]));
      cur = next;
      if (!edits.length) continue;
      out.push(this.tidyChange(op, list, edits, slug, scope));
    }
    return out;
  }

  private tidyChange(op: TidyOp, list: TidyNote[], edits: FileEdit[], slug: string, scope: NoteScope): LearnChange {
    const ids = op.op === "merge" ? op.ids : [op.id];
    const old = ids.map((n) => noteText(list[n - 1].note.text));
    const role = op.op === "remove" ? list[op.id - 1].role : op.to;
    const dest: Dest = role === "rules" ? { kind: "rules", slug } : { kind: "notes", role, scope, slug };
    const change: LearnChange = {
      id: this.newId(), at: this.now().toISOString(), kind: op.op === "merge" ? "merged" : op.op === "rewrite" ? "rewrote" : "removed",
      slug: scope === "general" ? null : slug, edits, text: op.op === "remove" ? old[0] : op.text, old, why: op.why, where: whereText(dest),
    };
    this.addChange(change);
    return change;
  }

  // ---- The Learned view ----

  /** What the board learned, for one board's Learned view: its own and what every board shares. */
  view(slug: string): LearnedView {
    const now = this.now().getTime();
    const pile = this.readPile();
    const mine = (c: LearnChange) => c.slug === slug || c.slug === null;
    const recent = (c: LearnChange, days: number) => now - Date.parse(c.at) < days * DAY;
    const all = this.changes().filter(mine).reverse();
    const seen = pile.seen?.[slug];
    const saved = all.filter((c) => c.kind === "saved" && recent(c, SAVED_DAYS));
    return {
      saved,
      cleaned: all.filter((c) => c.kind !== "saved" && recent(c, CLEANED_DAYS)),
      watching: pile.candidates
        .filter((c) => c.state === "watching" && (c.dest.slug === slug || (c.dest.kind === "notes" && c.dest.scope === "general")))
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, WATCHING_MAX),
      newCount: saved.filter((c) => !c.undoneAt && (!seen || c.at > seen)).length,
      tidyAt: pile.tidyAt ?? null,
    };
  }

  /** The user opened the Learned view: what was saved so far counts as seen. */
  markSeen(slug: string): Promise<void> {
    return this.serial(() => {
      const pile = this.readPile();
      this.writePile({ ...pile, seen: { ...pile.seen, [slug]: this.now().toISOString() } });
      this.emit(slug);
    });
  }
}
