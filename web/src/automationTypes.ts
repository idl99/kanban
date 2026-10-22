// Shapes of the automations API (src/server/loops.ts, src/server/integrations/passes.ts), kept apart from api.ts.

export type LoopColumn = "backlog" | "planning" | "ready";

/** A board pass: how automations reach a service without Claude (no secrets). */
export interface Pass {
  id: string;
  kind: "mcp" | "key" | "local";
  name: string;
  /** The Connections (Claude) server it was made from: that row shows both. */
  claudeName: string | null;
  url: string | null;
  envName: string | null;
  status: "pending" | "connected" | "needs_reconnect";
  error: string | null;
  createdAt: string;
  /** Automations (all boards) that use it. */
  usedBy: number;
}

export interface LoopSeenItem {
  id: string;
  title: string;
  link?: string;
  state: "new" | "skipped" | "seen" | "first";
  ticketId?: string;
  note?: string;
}

export interface Loop {
  version: number;
  id: string;
  name: string;
  enabled: boolean;
  service: string;
  passes: string[];
  scriptHash: string;
  everyMinutes: number;
  column: LoopColumn;
  autoStart: boolean;
  askClaude: { on: boolean; prompt: string };
  instructions: string;
  allowedTools: string[] | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
  state: "ok" | "unsupported" | "needs_connection" | "script_changed";
  problems: string[];
  script: string | null;
  passViews: { id: string; name: string; status: string }[];
  seenCount: number;
  lastFound: number;
  lastItems: LoopSeenItem[];
}

export interface LoopInput {
  name: string;
  enabled: boolean;
  service: string;
  passes: string[];
  script: string;
  everyMinutes: number;
  column: LoopColumn;
  autoStart: boolean;
  askClaude: { on: boolean; prompt: string };
  instructions: string;
}

export interface LoopTest {
  items: { id: string; title: string; text?: string; link?: string }[];
  found: number;
  error: string | null;
  stderr: string;
  toolsUsed: string[];
  durationMs: number;
}

/** An automation the setup chat proposed (src/server/automation-proposal.ts). */
export interface AutomationProposal {
  name: string;
  service: string;
  passes: { name: string; from?: string; url?: string; envName?: string; keyHelp?: string }[];
  script: string;
  everyMinutes: number;
  instructions?: string;
  askClaude?: { on: boolean; prompt: string };
  summary: string;
}
