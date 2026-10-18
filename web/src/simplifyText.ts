// "Say it simpler" shows under Claude's own replies only, and not under short ones (same rule as src/server/simplify.ts).

export const SIMPLIFY_MIN_WORDS = 25;

export const replyText = (text: string) => text.replace(/^.*CKANBAN_RESULT:.*$/m, "").trim();

interface Entry {
  role: "user" | "assistant";
  kind: string;
  text: string;
  commandOutput?: boolean;
  peer?: unknown;
  huddleId?: string;
}

export function simplifiable(e: Entry): boolean {
  return e.role === "assistant" && e.kind === "text" && !e.commandOutput && !e.peer && !e.huddleId
    && replyText(e.text).split(/\s+/).filter(Boolean).length >= SIMPLIFY_MIN_WORDS;
}
