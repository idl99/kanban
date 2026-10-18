import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { transcript } from "./explain";
import { parseResult } from "./result";
import type { SessionEntry } from "./session";
import { atomicWrite } from "./store";
import type { Ticket } from "./types";

// "Learn from this ticket" (after pstack's /reflect and /correct): a reading side call turns the user's corrections on
// a finished ticket into 0-3 lessons, each at the highest level that would stop the mistake coming back. A written
// rule can go into the project's own CLAUDE.md (a "## Lessons" section); a code or check change becomes a ticket.
// Not huddle role notes (huddle-notes.ts): those are per teammate, these are the project's rules for every run.

/** Highest level that stops the mistake, in /correct's order: change the code's structure, add a check, write a rule. */
export type LessonLevel = "structure" | "check" | "rule";

export const LESSON_LEVELS: LessonLevel[] = ["structure", "check", "rule"];

export interface Lesson {
  id: string;
  /** The mistake, one plain sentence. */
  mistake: string;
  /** The user's correction, quoted. */
  evidence: string;
  level: LessonLevel;
  /** The rule as one CLAUDE.md bullet (level rule), or what to change (structure, check). */
  rule: string;
  /** Short title for a ticket made from it. */
  title: string;
  /** What the user did with it. */
  done?: { action: LessonAction; at: string; ticketId?: string };
}

export type LessonAction = "rule" | "ticket" | "dismiss";

export const LESSON_ACTIONS: LessonAction[] = ["rule", "ticket", "dismiss"];

/** Where the project's rules live, relative to its folder, and the section lessons go under. */
export const RULES_FILE = "CLAUDE.md";
const SECTION = "## Lessons";

const CORRECTION_MAX = 1_500;
const LESSONS_MAX = 3;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** A message the user typed in the chat (not a board prompt, a huddle digest or a notification). */
const typedByUser = (e: SessionEntry) => e.role === "user" && e.kind === "text" && !e.peer;

/** A run ended here: Claude's reply carries the board's result line. */
const runEnd = (e: SessionEntry) => e.role === "assistant" && e.kind === "text" && !!parseResult(e.text);

export interface Corrections {
  /** What the user typed after a run had ended, oldest first. */
  messages: SessionEntry[];
  /** The user moved it back from Review or Done to Planning or Backlog. */
  reopened: boolean;
  /** A reviewer asked for changes on its pull request. */
  changesRequested: boolean;
  /** Tickets made to follow it up. */
  followUps: Pick<Ticket, "id" | "title">[];
}

/** The user's corrections on a ticket: messages after a run, a reopen, a pull request review asking for changes, follow-ups. */
export function corrections(t: Ticket, entries: SessionEntry[], tickets: Ticket[]): Corrections {
  const first = entries.findIndex(runEnd);
  return {
    messages: first < 0 ? [] : entries.slice(first + 1).filter((e) => typedByUser(e) && e.text.trim()),
    reopened: !!t.reopenedFrom,
    changesRequested: t.pr?.reviewDecision === "CHANGES_REQUESTED",
    followUps: tickets.filter((o) => o.followUpOf === t.id).map((o) => ({ id: o.id, title: o.title })),
  };
}

export const hasCorrections = (c: Corrections) => !!(c.messages.length || c.reopened || c.changesRequested || c.followUps.length);

/** "Learn from this ticket" shows on Review and Done tickets the user corrected. */
export function lessonsAvailable(t: Ticket, entries: SessionEntry[], tickets: Ticket[]): boolean {
  return (t.status === "review" || t.status === "done") && hasCorrections(corrections(t, entries, tickets));
}

export const LESSONS_SYSTEM = `You help a person stop an AI coding assistant (Claude) from repeating a mistake on their project. You get a finished task: what was asked, the conversation, the user's corrections and the result. The current folder holds the project; you may read its files to check a fact.

Find mistakes Claude made that the user had to correct. Only count a mistake that would come back on other tasks in this project; skip one-off slips, changes of mind, and new wishes that were not mistakes. For each, pick the highest level that would stop it, in this order:
1. "structure": change how the code is built so the mistake can't be made (one shared helper, a clearer name, removing the second way of doing it).
2. "check": a type, lint rule or test that fails when the mistake is made.
3. "rule": a written rule for Claude, only when neither of the above can stop it.

Return 0 to 3 lessons; fewer is better. When no mistake is worth a rule, return none and say so: that is often the honest answer.

Answer with JSON only, no other text:
{"lessons":[{"mistake":"...","evidence":"...","level":"structure"|"check"|"rule","rule":"...","title":"..."}],"note":"..."}
- mistake: what went wrong, one plain sentence.
- evidence: the user's own words that corrected it, quoted exactly (shorten with … if long).
- rule: for "rule", one short instruction Claude can follow on any task in this project, written as a rule (for example "Put new links on forms under the main button."); for "structure" or "check", what to change, in two or three sentences someone could start work from.
- title: a short task title for that change (under 60 characters).
- note: when there are no lessons, one sentence saying why; otherwise empty.

Write for a person who is not technical: plain everyday words, no file paths, code or commands unless they are needed to act on the lesson. No filler, no em dashes, no arrows standing in for words, no made-up abbreviations. Write in the language the user writes in. Don't suggest a rule the project's rules already have.`;

export interface LessonsInput {
  ticket: Ticket;
  entries: SessionEntry[];
  corrections: Corrections;
  /** The "## Lessons" bullets already in the project's rules. */
  existing?: string[];
}

export function lessonsPrompt({ ticket: t, entries, corrections: c, existing = [] }: LessonsInput): string {
  const summary = entries.filter((e) => e.role === "assistant" && e.kind === "text").map((e) => parseResult(e.text)?.summary).filter(Boolean).at(-1);
  const said = [
    ...c.messages.map((e) => `- [${e.at}] The user wrote after a run: "${clip(e.text.trim(), CORRECTION_MAX)}"`),
    c.reopened ? "- The user moved the ticket back to be reworked after it was finished." : "",
    c.changesRequested ? "- A reviewer asked for changes on the pull request." : "",
    ...c.followUps.map((f) => `- The user made a follow-up ticket: "${f.title}"`),
  ].filter(Boolean);
  return [
    `Task: "${t.title}"`,
    t.body.trim() ? `What was asked:\n<description>\n${clip(t.body.trim(), 3_000)}\n</description>` : "",
    `The user's corrections:\n${said.join("\n")}`,
    summary ? `Claude's own summary of its last run: ${summary}` : "",
    existing.length ? `Rules the project already has:\n${existing.map((r) => `- ${r}`).join("\n")}` : "",
    `The conversation:\n<transcript>\n${transcript(entries) || "(nothing)"}\n</transcript>`,
  ].filter(Boolean).join("\n\n");
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The side call's answer as lessons (at most 3) and a note; null when it isn't the JSON asked for. */
export function parseLessons(text: string, newId: () => string): { lessons: Lesson[]; note: string } | null {
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from < 0 || to < from) return null;
  let v: { lessons?: unknown; note?: unknown };
  try {
    v = JSON.parse(text.slice(from, to + 1));
  } catch {
    return null;
  }
  if (!v || !Array.isArray(v.lessons)) return null;
  const lessons: Lesson[] = [];
  for (const l of v.lessons as Record<string, unknown>[]) {
    const level = str(l?.level) as LessonLevel;
    const mistake = str(l?.mistake);
    const rule = str(l?.rule).replace(/^[-*]\s+/, "").replace(/\s*\n+\s*/g, " ");
    if (!LESSON_LEVELS.includes(level) || !mistake || !rule) continue;
    lessons.push({ id: newId(), mistake, evidence: str(l.evidence), level, rule, title: str(l.title).slice(0, 120) || clip(mistake, 80) });
  }
  return { lessons: lessons.slice(0, LESSONS_MAX), note: str(v.note) };
}

// ---- The project's rules (CLAUDE.md) ----

const isHeading = (l: string) => /^#{1,2}\s/.test(l);
const isSection = (l: string) => l.trim().toLowerCase() === SECTION.toLowerCase();

/** The bullets under "## Lessons" in a rules file's text. */
export function lessonBullets(text: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex(isSection);
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (isHeading(l)) break;
    const m = l.match(/^[-*]\s+(.*\S)/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** text with rule added as the last bullet under "## Lessons" (the section is added at the end when missing). */
export function withLesson(text: string, rule: string): string {
  const bullet = `- ${rule}`;
  if (!text.trim()) return `${SECTION}\n\n${bullet}\n`;
  const lines = text.replace(/\n*$/, "").split("\n");
  const at = lines.findIndex(isSection);
  if (at < 0) return `${lines.join("\n")}\n\n${SECTION}\n\n${bullet}\n`;
  let end = lines.findIndex((l, i) => i > at && isHeading(l));
  if (end < 0) end = lines.length;
  // After the section's last non-blank line, so the blank line before the next heading stays.
  let last = end - 1;
  while (last > at && !lines[last].trim()) last--;
  const head = lines.slice(0, last + 1);
  if (last === at) head.push("");
  return [...head, bullet, ...lines.slice(last + 1)].join("\n") + "\n";
}

const sameRule = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Adds rule to the "## Lessons" section of the project's CLAUDE.md in folder, making the file or section when missing.
 * Only adds: the rest of the file stays as it was. added: false when the rule was there already.
 */
export function addProjectRule(folder: string, rule: string): { file: string; added: boolean } {
  const file = join(folder, RULES_FILE);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (lessonBullets(text).some((b) => sameRule(b, rule))) return { file, added: false };
  atomicWrite(file, withLesson(text, rule));
  return { file, added: true };
}

/** The "## Lessons" bullets of the CLAUDE.md in folder. */
export function projectRules(folder: string): string[] {
  try {
    return lessonBullets(readFileSync(join(folder, RULES_FILE), "utf8"));
  } catch {
    return [];
  }
}

/**
 * For a run in another folder than the project's (a worktree): the project's saved lessons its own CLAUDE.md doesn't
 * have yet, as a prompt block, "" for none. A worktree starts from the saved version history, so a rule just added to
 * the project folder is not in it.
 */
export function lessonsBlock(projectFolder: string, runFolder: string | null): string {
  if (!runFolder || runFolder === projectFolder) return "";
  const have = projectRules(runFolder);
  const missing = projectRules(projectFolder).filter((r) => !have.some((h) => sameRule(h, r)));
  if (!missing.length) return "";
  return `# Project lessons\nRules the user saved from earlier tickets (the Lessons section of the project folder's ${RULES_FILE}). Follow them:\n${missing.map((r) => `- ${r}`).join("\n")}`;
}
