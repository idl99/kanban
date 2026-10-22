// Pure helpers for the Automations dialog and the Board column of Connections (tested in test/automations.test.ts).
import type { AutomationProposal, Loop, LoopColumn, Pass } from "./automationTypes";

/** What boardCell needs of a Connections server (api.ts McpServer; not imported, so tests can load this file). */
type ClaudeServer = { name: string; scope: "user" | "local" | "project" | "claude.ai" | "other"; transport: "stdio" | "http" | "sse" | null };

export const COLUMN_LABEL: Record<LoopColumn, string> = { backlog: "Backlog", planning: "Planning", ready: "Ready" };

export const EVERY_CHOICES = [5, 15, 60];

export function everyLabel(min: number): string {
  if (min % 60 === 0) return min === 60 ? "hour" : `${min / 60} hours`;
  return `${min} min`;
}

/** The badge in the list: whether it runs, and if not, the short reason. */
export function loopStatus(l: Pick<Loop, "enabled" | "state" | "lastError">): { label: string; tone: string } {
  if (l.state === "unsupported") return { label: "Not supported", tone: "stopped" };
  if (l.state === "needs_connection") return { label: "Needs connecting", tone: "blocked" };
  if (l.state === "script_changed") return { label: "Review script", tone: "blocked" };
  if (!l.enabled) return { label: "Off", tone: "stopped" };
  if (l.lastError) return { label: "Waiting", tone: "blocked" };
  return { label: "On", tone: "ok" };
}

/** The line under the name in the list. */
export function loopSubtitle(l: Pick<Loop, "everyMinutes" | "enabled" | "lastError" | "lastCheckedAt" | "state" | "problems">, ago: (iso: string) => string): string {
  if (l.state !== "ok") return l.problems[0] ?? "";
  if (!l.enabled) return "off";
  if (l.lastError) return l.lastError;
  return `every ${everyLabel(l.everyMinutes)}${l.lastCheckedAt ? ` · checked ${ago(l.lastCheckedAt)}` : " · not checked yet"}`;
}

/** What a Connections row shows in the Board column. */
export type BoardCell =
  | { kind: "ok"; pass: Pass }
  | { kind: "connect"; pass: Pass | null; how: "local" | "mcp" }
  | { kind: "none"; why: string };

/** The Board column for a Claude server: its linked pass, a Connect button, or a dash with the reason. */
export function boardCell(s: ClaudeServer, passes: Pass[]): BoardCell {
  const pass = passes.find((p) => p.claudeName === s.name) ?? null;
  if (pass?.status === "connected") return { kind: "ok", pass };
  if (s.scope === "claude.ai") return { kind: "none", why: "The board can't use Claude's claude.ai sign-in. Add the service for automations with its own sign-in or a key (+ Add for automations)." };
  if (s.scope !== "user" && s.scope !== "local") return { kind: "none", why: "Only servers from your own Claude settings can be used by automations." };
  if (pass) return { kind: "connect", pass, how: pass.kind === "local" ? "local" : "mcp" };
  return { kind: "connect", pass: null, how: s.transport === "stdio" ? "local" : "mcp" };
}

/** Whether Connections shows its Board column: once there is an automation or a board pass. */
export function showBoardColumn(passes: Pass[] | null, automations: number): boolean {
  return (passes?.length ?? 0) > 0 || automations > 0;
}

/** A proposed connection resolved against the board's passes: the pass it is, or what the card must still do. */
export function resolveProposedPass(p: AutomationProposal["passes"][number], passes: Pass[]): { pass: Pass | null; need: "connect" | "key" | "missing" | null } {
  const name = p.name.toLowerCase();
  const pass = passes.find((x) => (p.from && x.claudeName === p.from) || (p.envName && x.envName === p.envName) || (p.url && x.url === p.url))
    ?? passes.find((x) => x.name.toLowerCase() === name || x.claudeName?.toLowerCase() === name) ?? null;
  if (pass?.status === "connected") return { pass, need: null };
  if (pass) return { pass, need: pass.kind === "key" ? "key" : "connect" };
  if (p.from || p.url) return { pass: null, need: "connect" };
  if (p.envName) return { pass: null, need: "key" };
  return { pass: null, need: "missing" };
}
