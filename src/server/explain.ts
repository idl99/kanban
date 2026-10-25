import { existsSync, readFileSync } from "node:fs";
import type { DiffFile, TicketDiff } from "./diff";
import { parseResult } from "./result";
import type { SessionEntry } from "./session";
import { addSideSpend, READ_TOOLS, type SideCaller } from "./side-call";
import { atomicWrite, type Store } from "./store";
import type { HuddleFinding, Ticket } from "./types";

// "Help me understand": answers about a ticket from a reading side call (side-call.ts) on Sonnet, read-only in the
// ticket's folder, so the ticket's session gains no turn. Each answer is a card in the ticket's chat, kept in the
// ticket's help.json; its cost goes on the ticket's side ledger.
//   recap:   "What happened while I was away?", after pstack's /ketchup.
//   changes: "Explain the changes", after pstack's /teach.

export type HelpKind = "recap" | "changes";

export const HELP_KINDS: HelpKind[] = ["recap", "changes"];

export interface HelpCard {
  id: string;
  kind: HelpKind;
  at: string;
  text: string;
  costUsd: number;
  model: string;
}

export const HELP_MODEL = "sonnet";

/** Longest transcript and diff a prompt carries (the newest part of the transcript, the start of the diff). */
const TRANSCRIPT_MAX = 30_000;
const DIFF_MAX = 25_000;
const ENTRY_MAX = 2_000;
const BODY_MAX = 3_000;
/** Cards kept per ticket (the oldest go first). */
const CARDS_MAX = 50;

const STATUS_LABEL: Record<Ticket["status"], string> = {
  backlog: "Backlog (parked)", planning: "Planning (being shaped with Claude)", ready: "Queued (waiting to start)",
  in_progress: "In Progress (Claude is working)", review: "Review (waiting for the user to check the result)", done: "Done",
};

/** A message the user typed (not a board prompt, a huddle digest or a notification). */
const typedByUser = (e: SessionEntry) => e.role === "user" && e.kind === "text" && !e.peer;

/** The user's last typed message and everything after it (the whole conversation when they never typed one). */
export function sinceLastMessage(entries: SessionEntry[]): { last: SessionEntry | null; after: SessionEntry[] } {
  let i = entries.length - 1;
  while (i >= 0 && !typedByUser(entries[i])) i--;
  return i < 0 ? { last: null, after: entries } : { last: entries[i], after: entries.slice(i + 1) };
}

/** "What happened while I was away?" shows once something happened after the user's last message. */
export function recapAvailable(entries: SessionEntry[]): boolean {
  return sinceLastMessage(entries).after.some((e) => e.role === "assistant" || e.kind === "board" || !!e.peer);
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** One conversation entry as a transcript line (tool rows are counted, not listed, by the caller). */
function line(e: SessionEntry): string {
  const text = clip(e.text.trim(), ENTRY_MAX);
  if (e.peer?.ticketId) return `Message from another ticket ("${e.peer.title ?? e.peer.ticketId}"): ${text}`;
  if (e.peer || e.huddleId) return `Review team (huddle) message: ${text}`;
  if (e.kind === "board") return `Board (automatic message): ${text}`;
  if (e.kind === "agent") return `Claude started a helper: ${text}`;
  if (e.role === "user") return `User: ${text}`;
  const parts = [`Claude: ${text}`];
  if (e.questions?.length) parts.push(`Claude asked the user: ${e.questions.map((q) => q.question).join(" / ")}`);
  if (e.proposal) parts.push(`Claude proposed a new title and description: "${e.proposal.title}"`);
  if (e.newTickets?.length) parts.push(`Claude proposed new tickets: ${e.newTickets.map((t) => `"${t.title}"`).join(", ")}`);
  if (e.branch) parts.push(`Claude offered to branch the ticket: ${e.branch.reason}`);
  if (e.huddle) parts.push(`Claude proposed a review huddle: ${e.huddle.reason}`);
  if (e.deletion) parts.push(`Claude asked to delete tickets: ${e.deletion.reason}`);
  return parts.join("\n");
}

/** What happened in `entries`, oldest first, keeping the newest part when it is too long. */
export function transcript(entries: SessionEntry[]): string {
  const out: string[] = [];
  let tools = 0;
  const flush = () => {
    if (tools) out.push(`(Claude used ${tools} tool${tools > 1 ? "s" : ""}: reading, searching, running commands or editing files)`);
    tools = 0;
  };
  for (const e of entries) {
    if (e.kind === "tool") {
      tools++;
      continue;
    }
    if (!e.text.trim() && !e.questions && !e.proposal) continue;
    flush();
    out.push(`[${e.at}] ${line(e)}`);
  }
  flush();
  const all = out.join("\n\n");
  return all.length > TRANSCRIPT_MAX ? `(earlier part left out)\n${all.slice(-TRANSCRIPT_MAX)}` : all;
}

const PLAIN = `Write for a person who is not technical, like one human talking to another. Plain everyday words; when a technical idea matters, say what it means ("a saved copy of the project" rather than "a commit", "the copy of the folder Claude works in" rather than "a worktree", "version history" rather than "git"). No file paths, code, commands, hashes or version numbers unless the reader must type, open or act on one themselves. Never invent a number: only give numbers that appear in what you were given or in files you read. Full sentences, no filler, no hype, no em dashes, no arrows standing in for words, no made-up abbreviations. Write in the language the user writes in. Answer with the text only: no introduction and no note about how you wrote it.`;

/** After pstack's /ketchup. */
export const RECAP_SYSTEM = `You catch a person up on a task an AI coding assistant (Claude) worked on while they were away. You get what happened since their last message.

Write, in this order:
1. One sentence, in bold, naming what waits on them right now, or saying that nothing does.
2. The story of what happened, under 100 words. Only what changed something for them: results, decisions, problems. Skip work that changed nothing for them (reading, retries, checks that passed, housekeeping).
3. If anything is left that only they can decide (approve, pick between options, an irreversible step, access or a login Claude needs), a short list: one item per decision, about 30 words each. Each says the call to make, what Claude would pick, what it changes for the people who use the result, the evidence, the risk, and what happens if they don't answer. Leave this part out when there is nothing to decide.

You may read files in the current folder to check a fact, but the conversation is usually enough. ${PLAIN}`;

/** After pstack's /teach (how and why). */
export const CHANGES_SYSTEM = `You explain to a person what an AI coding assistant (Claude) changed in their project, and why. You get the task and the changes; the current folder holds the changed project, and you may read its files to understand them.

Write, in this order, under about 200 words in all:
1. Before and after: what it was like before, and what is different now, for the people who use it. Then, in a sentence or two, how it works and why it was done this way.
2. A small picture: a plain-text diagram in a code block, at most 6 boxes, showing how the parts fit together or what happens step by step. Short labels in plain words, not file names.
3. What did not change, so they know what is safe.
4. Any risk or thing to check, or say there is none worth worrying about.

Use short headings or bold lead-ins for the parts. ${PLAIN}`;

export interface RecapInput {
  ticket: Ticket;
  entries: SessionEntry[];
  /** Pinned findings of the ticket's huddles. */
  findings?: HuddleFinding[];
  /** Claude is working on it right now. */
  running?: boolean;
}

export function recapPrompt({ ticket: t, entries, findings = [], running = false }: RecapInput): string {
  const { last, after } = sinceLastMessage(entries);
  const since = last?.at ?? null;
  const fresh = findings.filter((f) => !since || f.at > since);
  const pr = t.prUrl
    ? `Pull request: ${t.pr?.state === "MERGED" ? "merged" : t.pr?.state === "CLOSED" ? "closed" : "open"}${t.pr?.failing ? `, ${t.pr.failing} failing check(s)` : ""}${t.pr?.conflicts ? ", has conflicts" : ""}${t.pr?.reviewDecision ? `, review: ${t.pr.reviewDecision}` : ""}.`
    : "";
  return [
    `Task: "${t.title}"`,
    `Where it is now: ${STATUS_LABEL[t.status]}${running ? ", Claude is working on it right now" : ""}.${t.outcome ? ` Last run ended: ${t.outcome}.` : ""}`,
    pr,
    t.error ? `Last error: ${clip(t.error, 500)}` : "",
    last ? `The user's last message (${last.at}):\n<message>\n${clip(last.text.trim(), ENTRY_MAX)}\n</message>` : "The user hasn't written in this conversation yet; this is everything so far.",
    fresh.length ? `Review team findings since then:\n${fresh.map((f) => `- [${f.status}] ${clip(f.text, 400)}`).join("\n")}` : "",
    `What happened since then:\n<transcript>\n${transcript(after) || "(nothing)"}\n</transcript>`,
  ].filter(Boolean).join("\n\n");
}

const STATUS_WORD: Record<DiffFile["status"], string> = { A: "added", M: "changed", D: "deleted", R: "renamed" };

/** The diff as a file list plus patches, cut short when too long. */
export function diffText(d: TicketDiff): string {
  const list = d.files.map((f) => `- ${f.path} (${STATUS_WORD[f.status]}${f.oldPath ? ` from ${f.oldPath}` : ""}, +${f.additions} -${f.deletions})`).join("\n");
  let patch = "";
  for (const f of d.files) {
    if (f.binary || f.tooLarge) continue;
    const body = f.hunks.map((h) => [h.header, ...h.lines.map((l) => (l.type === "add" ? "+" : l.type === "del" ? "-" : " ") + l.text)].join("\n")).join("\n");
    patch += `\n--- ${f.path}\n${body}\n`;
    if (patch.length > DIFF_MAX) {
      patch = `${patch.slice(0, DIFF_MAX)}\n(the rest is left out; read the files for more)`;
      break;
    }
  }
  return `${d.files.length} file(s) changed, +${d.additions} -${d.deletions}:\n${list}\n\n<changes>${patch}\n</changes>`;
}

export interface ChangesInput {
  ticket: Ticket;
  entries: SessionEntry[];
  diff: TicketDiff;
}

export function changesPrompt({ ticket: t, entries, diff }: ChangesInput): string {
  const summary = entries.filter((e) => e.role === "assistant" && e.kind === "text").map((e) => parseResult(e.text)?.summary).filter(Boolean).at(-1);
  return [
    `Task: "${t.title}"`,
    t.body.trim() ? `What was asked:\n<description>\n${clip(t.body.trim(), BODY_MAX)}\n</description>` : "",
    summary ? `Claude's own summary of its last run: ${summary}` : "",
    `The changes:\n${diffText(diff)}`,
  ].filter(Boolean).join("\n\n");
}

export const HELP_SYSTEM: Record<HelpKind, string> = { recap: RECAP_SYSTEM, changes: CHANGES_SYSTEM };

export class HelpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function readCards(file: string): HelpCard[] {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export const newId = () => `h_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class Helper {
  /** Answers in progress, by ticket file + kind: a double click or a second device waits for the same call. */
  private running = new Map<string, Promise<HelpCard>>();

  constructor(private store: Store, private call: SideCaller) {}

  /** The ticket's saved cards, oldest first. */
  cards(slug: string, id: string): HelpCard[] {
    return readCards(this.store.helpPath(slug, id));
  }

  /** Kinds being answered right now for this ticket (the chat shows them loading after a reload). */
  busy(slug: string, id: string): HelpKind[] {
    const file = this.store.helpPath(slug, id);
    return HELP_KINDS.filter((k) => this.running.has(`${file}|${k}`));
  }

  /** A new answer, saved as a card; cwd: the ticket's folder (read-only), when it still exists. */
  async ask(slug: string, id: string, kind: HelpKind, prompt: string, cwd: string | null): Promise<HelpCard> {
    const file = this.store.helpPath(slug, id);
    const key = `${file}|${kind}`;
    let p = this.running.get(key);
    if (!p) {
      p = (async () => {
        const folder = cwd && existsSync(cwd) ? cwd : undefined;
        const r = await this.call({
          system: HELP_SYSTEM[kind], prompt, model: HELP_MODEL, timeoutMs: 240_000, ...(folder ? { cwd: folder, tools: READ_TOOLS } : {}),
        });
        if (!r.ok) throw new HelpError(502, r.error);
        addSideSpend(this.store.sideSpendPath(slug, id), `help-${kind}`, r.costUsd);
        const card: HelpCard = { id: newId(), kind, at: new Date().toISOString(), text: r.text, costUsd: r.costUsd, model: r.model };
        // Read again: another answer may have been saved meanwhile.
        atomicWrite(file, JSON.stringify([...readCards(file), card].slice(-CARDS_MAX), null, 2) + "\n");
        return card;
      })().finally(() => this.running.delete(key));
      this.running.set(key, p);
    }
    return p;
  }
}
