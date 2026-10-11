import { isLimitText } from "./limit";

/**
 * One automatic retry for runs that die on a passing API problem (overloaded, a 5xx, a dropped connection): the board
 * resumes the same session once after a short pause instead of failing the ticket (see Board.executeOnce). Claude Code
 * already retries inside a run (api_retry events); this covers the run that gave up anyway.
 */

/** Pause before the retry. */
export const RETRY_DELAY_MS = 30_000;
/** What the resumed session is told. */
export const RETRY_TEXT = "Your previous run stopped on a temporary API error before it finished. Continue where you left off.";

const TRANSIENT_RE = new RegExp([
  "\\boverloaded",
  "\\b(?:500|502|503|504|529)\\b",
  "internal server error", "bad gateway", "service unavailable", "gateway time-?out",
  "\\bapi_error\\b",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_\\w+",
  "socket hang up", "fetch failed", "network error", "connection error", "connection (?:reset|closed|refused)",
  "request timed out",
].join("|"), "i");

/** stderr's last line: network failures and named API errors, not bare status codes. */
const STDERR_RE = /\boverloaded|internal server error|bad gateway|service unavailable|gateway time-?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_\w+|socket hang up|fetch failed|network error|request timed out|API Error: (?:5\d\d|529)/i;

function eventText(ev: any): string {
  if (ev?.type === "result") {
    const errors = Array.isArray(ev.errors) ? ev.errors.join("\n") : "";
    return [typeof ev.result === "string" ? ev.result : "", errors].filter(Boolean).join("\n");
  }
  const c = ev?.message?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("") : "";
}

/** The text names a passing API or network problem (and not the usage limit, which waits for its reset instead). */
export function isTransientText(text: string): boolean {
  return TRANSIENT_RE.test(text) && !isLimitText(text);
}

/**
 * The passing API error a failed run ended with, or null. Looks only at the CLI's own API-error messages and result
 * (never Claude's words, which may mention a 503 in the code it works on) and at stderr.
 */
export function transientError(events: any[], stderr = ""): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const apiError = (ev?.type === "assistant" && (ev.is_api_error_message || ev.error)) || (ev?.type === "result" && ev.is_error);
    if (!apiError) continue;
    const status = Number(ev.api_error_status);
    const text = eventText(ev).trim();
    if (status >= 500 || (text && isTransientText(text))) return text || `API error ${status}`;
    // Nothing to judge it by: look further back.
    if (!text && !status) continue;
    // The last API error is a lasting one (bad request, auth): that is what the run died on.
    return null;
  }
  // Only a run that never got to a result died on stderr; only its last line says why (earlier lines can be an MCP
  // server's own connection errors or tool output with numbers in it).
  if (events.some((e) => e?.type === "result")) return null;
  const last = stderr.split("\n").map((l) => l.trim()).findLast(Boolean) ?? "";
  return last && STDERR_RE.test(last) && !isLimitText(last) ? last : null;
}
