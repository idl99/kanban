import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transcript } from "./explain";
import { parseResult } from "./result";
import type { SessionEntry } from "./session";
import type { Ticket } from "./types";

// The user's corrections on a finished ticket (messages after a run, a reopen, a pull request review asking for
// changes, add-on tickets) and the prompt that shows them to a learning call (learn.ts reads them into the board's
// pile of lessons). Also the "## Lessons" section of a project's CLAUDE.md, which older versions wrote: runs in a
// worktree still get the bullets their copy lacks.

/** Where the project's rules live, relative to its folder, and the section lessons go under. */
export const RULES_FILE = "CLAUDE.md";
const SECTION = "## Lessons";

const CORRECTION_MAX = 1_500;

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
  addOns: Pick<Ticket, "id" | "title">[];
}

/** The user's corrections on a ticket: messages after a run, a reopen, a pull request review asking for changes, add-on tickets. */
export function corrections(t: Ticket, entries: SessionEntry[], tickets: Ticket[]): Corrections {
  const first = entries.findIndex(runEnd);
  return {
    messages: first < 0 ? [] : entries.slice(first + 1).filter((e) => typedByUser(e) && e.text.trim()),
    reopened: !!t.reopenedFrom,
    changesRequested: t.pr?.reviewDecision === "CHANGES_REQUESTED",
    addOns: tickets.filter((o) => o.addOnOf === t.id).map((o) => ({ id: o.id, title: o.title })),
  };
}

export const hasCorrections = (c: Corrections) => !!(c.messages.length || c.reopened || c.changesRequested || c.addOns.length);

export interface LessonsInput {
  ticket: Ticket;
  entries: SessionEntry[];
  corrections: Corrections;
  /** Rules the board already has (learned rules and the CLAUDE.md "## Lessons" bullets). */
  existing?: string[];
}

export function lessonsPrompt({ ticket: t, entries, corrections: c, existing = [] }: LessonsInput): string {
  const summary = entries.filter((e) => e.role === "assistant" && e.kind === "text").map((e) => parseResult(e.text)?.summary).filter(Boolean).at(-1);
  const said = [
    ...c.messages.map((e) => `- [${e.at}] The user wrote after a run: "${clip(e.text.trim(), CORRECTION_MAX)}"`),
    c.reopened ? "- The user moved the ticket back to be reworked after it was finished." : "",
    c.changesRequested ? "- A reviewer asked for changes on the pull request." : "",
    ...c.addOns.map((f) => `- The user made an add-on ticket: "${f.title}"`),
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

const sameRule = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

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
