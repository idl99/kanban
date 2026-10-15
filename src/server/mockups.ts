import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Planning runs can't edit files, so Claude can't write mockup files itself. It puts each one in a
 * <ckanban-mockup name="..."> block in its reply instead; the board saves it to the ticket's outputs folder,
 * where the Outputs tab previews it. Feedback goes through the chat's question form.
 */

/** Where mockups live, relative to the outputs folder. */
export const MOCKUPS_DIR = "mockups";

const BLOCK_RE = /<ckanban-mockup\s+name="([^"]*)"\s*>([\s\S]*?)<\/ckanban-mockup>/g;
/** A real opening tag of a block still being written (no closing tag yet), so the chat can hide it while it streams. */
const OPEN_RE = /<ckanban-mockup\s+name="[^"]*"\s*>\s*(?:<|```|$)/g;

/** A safe file name for a mockup ("a-compact.html"), or null. */
export function mockupName(name: string): string | null {
  const n = name.trim();
  return /^[\w][\w.-]{0,80}\.html?$/i.test(n) && !n.includes("..") ? n : null;
}

export interface Mockup {
  name: string;
  html: string;
}

/** The mockup blocks in a reply (valid names only; a ``` fence around the HTML is dropped). */
export function extractMockups(text: string): Mockup[] {
  const out: Mockup[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const name = mockupName(m[1]);
    const html = m[2].trim().replace(/^```(?:html)?\s*\n/, "").replace(/\n?```$/, "").trim();
    if (name && html) out.push({ name, html });
  }
  return out;
}

/** The reply without its mockup blocks, plus the names of the mockups they carried. */
export function stripMockups(text: string): { text: string; names: string[] } {
  const names = extractMockups(text).map((m) => m.name);
  let out = text.replace(BLOCK_RE, "");
  // An unfinished block (the reply was cut off) is HTML noise in the chat; drop it too. Only a real opening tag
  // with no board block after it: a reply that just mentions the tag (e.g. in a ticket proposal) stays whole.
  const open = [...out.matchAll(OPEN_RE)].at(-1)?.index;
  if (open !== undefined && !out.includes("<ckanban-", open + 1)) out = out.slice(0, open);
  return { text: out, names };
}

/** Save the reply's mockups to <outputDir>/mockups; returns the names written. */
export function saveMockups(outputDir: string, text: string): string[] {
  const mockups = extractMockups(text);
  if (!mockups.length) return [];
  const dir = join(outputDir, MOCKUPS_DIR);
  mkdirSync(dir, { recursive: true });
  for (const m of mockups) writeFileSync(join(dir, m.name), m.html.endsWith("\n") ? m.html : `${m.html}\n`);
  return mockups.map((m) => m.name);
}
