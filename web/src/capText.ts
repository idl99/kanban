import { costText } from "./usage";

/** The ticket fields these helpers read (kept free of api.ts so tests can import it). */
type Ticket = {
  status: string; outcome: string | null; running?: boolean;
  capHit?: { capUsd: number; at: string } | null;
  runCap?: number | null;
};

/** A run stopped at its spending cap and waits for the user ("Continue with +$Y"). */
export const capWait = (t: Ticket): boolean =>
  !!t.capHit && t.outcome === "blocked" && !t.running && t.status !== "in_progress" && t.status !== "done";

/** "Stopped at $0.50 cap". */
export const capLabel = (t: Ticket): string => (t.capHit ? `Stopped at ${costText(t.capHit.capUsd)} cap` : "Blocked");

/** What "Continue with +$Y" adds: the cap the run stopped at. */
export const capStep = (t: Ticket): number => t.capHit?.capUsd ?? t.runCap ?? 1;

/**
 * A typed cap: "" → null (use the default), "0" / "none" / "off" → 0 (no cap), "$2.50" → 2.5; undefined when it
 * isn't an amount.
 */
export function parseCap(text: string): number | null | undefined {
  const s = text.trim().toLowerCase().replace(/^\$/, "");
  if (!s) return null;
  if (s === "none" || s === "off") return 0;
  if (!/^\d*\.?\d+$/.test(s)) return undefined;
  return Number(s);
}

/** The cap as an input shows it: "" for none / default, "2.50". */
export const capInputText = (usd: number | null | undefined): string => (usd && usd > 0 ? String(usd) : "");
