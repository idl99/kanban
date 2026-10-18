import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { addSideSpend, type SideCaller } from "./side-call";
import type { SessionEntry } from "./session";
import { atomicWrite, type Store } from "./store";

// "Say it simpler": a Claude reply in a ticket chat rewritten in plain words by a side call (side-call.ts), so the
// ticket's session gains no turn. Rewrites are kept per message in the ticket's simplified.json: a second click,
// a reload or another device gets the saved one for free.

/** Replies shorter than this have nothing to simplify (web/src/simplifyText.ts uses the same rule). */
export const SIMPLIFY_MIN_WORDS = 25;

const RESULT_LINE = /^.*CKANBAN_RESULT:.*$/m;

/** The reply as the chat shows it (no result line). */
export const replyText = (text: string) => text.replace(RESULT_LINE, "").trim();

export const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** A Claude reply the link shows under: Claude's own text (not a tool row, card or command output), long enough. */
export function simplifiable(e: SessionEntry): boolean {
  return e.role === "assistant" && e.kind === "text" && !e.commandOutput && !e.peer && !e.huddleId
    && wordCount(replyText(e.text)) >= SIMPLIFY_MIN_WORDS;
}

/** Based on pstack's /bro skill, plus the unslop rules. */
export const SIMPLIFY_SYSTEM = `You rewrite one message an AI coding assistant sent to a person who is not technical. Restate it. Stop using jargon and speak coherently. State it more simply and concisely, like one human talking to another.

Rules:
- Keep every fact, decision, result and question that matters to the reader. Drop the rest. Never add anything new.
- Plain everyday words. Say what a technical term means instead of using it ("a saved copy of the project" rather than "a commit"; "the copy of the folder Claude works in" rather than "a worktree").
- No file paths, file names, code, commands, version numbers or hashes, unless the reader must type, open or act on one themselves.
- Leave out how the work was done and checked (test counts, builds, merges, restarts) unless something went wrong or the reader must wait or act; "it was checked and works" is enough.
- Full sentences. No arrows, no symbols standing in for words, no abbreviations, no filler, no hype.
- If the message asks the reader something or needs them to act, say that clearly, at the end.
- Short: usually two to four sentences, or a short list. Much shorter than the original.
- Write in the same language as the message.
- Answer with the rewritten message only: no introduction, no heading, no note about what you changed.`;

export function simplifyPrompt(title: string, text: string): string {
  return `The message is about the task "${title}".\n\n<message>\n${text}\n</message>`;
}

interface Saved {
  text: string;
  /** Hash of the reply it was made from: a reply whose text changed gets a fresh rewrite. */
  source: string;
  at: string;
  costUsd: number;
  model: string;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function readSaved(file: string): Record<string, Saved> {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export class SimplifyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class Simplifier {
  /** Rewrites in progress, by ticket file + message: a double click or a second device waits for the same call. */
  private running = new Map<string, Promise<string>>();

  constructor(private store: Store, private call: SideCaller) {}

  /** The ticket's saved rewrites by message uuid (only ones still matching their reply). */
  saved(slug: string, id: string, entries: SessionEntry[]): Record<string, string> {
    const saved = readSaved(this.store.simplifiedPath(slug, id));
    const out: Record<string, string> = {};
    for (const e of entries) {
      const s = saved[e.uuid];
      if (s && s.source === hash(replyText(e.text))) out[e.uuid] = s.text;
    }
    return out;
  }

  /** The plain-words version of one reply: the saved one, or a new side call (its cost goes on the ticket). */
  async simplify(slug: string, id: string, title: string, entry: SessionEntry): Promise<{ text: string; cached: boolean }> {
    if (!simplifiable(entry)) throw new SimplifyError(400, "this message is too short to simplify");
    const file = this.store.simplifiedPath(slug, id);
    const original = replyText(entry.text);
    const source = hash(original);
    const hit = readSaved(file)[entry.uuid];
    if (hit?.source === source) return { text: hit.text, cached: true };
    const key = `${file}|${entry.uuid}`;
    let p = this.running.get(key);
    if (!p) {
      p = (async () => {
        const r = await this.call({ system: SIMPLIFY_SYSTEM, prompt: simplifyPrompt(title, original) });
        if (!r.ok) throw new SimplifyError(502, r.error);
        addSideSpend(this.store.sideSpendPath(slug, id), "simplify", r.costUsd);
        // Read again: other messages may have been saved meanwhile.
        const saved = readSaved(file);
        saved[entry.uuid] = { text: r.text, source, at: new Date().toISOString(), costUsd: r.costUsd, model: r.model };
        atomicWrite(file, JSON.stringify(saved, null, 2) + "\n");
        return r.text;
      })().finally(() => this.running.delete(key));
      this.running.set(key, p);
    }
    return { text: await p, cached: false };
  }
}
