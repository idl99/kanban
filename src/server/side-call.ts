import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { helperEnv } from "./artifact";
import { dayKey } from "./limit";

// A side call: one short `claude -p` answer on the cheapest model, outside any ticket's session. No resume, no
// tools, no MCP servers, no skills, no user hooks (only project settings, and its folder has none), nothing saved
// as a session, run in a folder of its own. A reading call ("Help me understand", explain.ts) gets read-only file
// tools instead, and runs in the ticket's folder with hooks off. Its cost goes to the ticket's side ledger (side-spend.jsonl), which
// counts in the ticket's spend; the ticket's activity log and session never see it.

export interface SideCallInput {
  prompt: string;
  system: string;
  /** Default: haiku. */
  model?: string;
  timeoutMs?: number;
  /** Read-only tools it may use (e.g. Read, Grep, Glob); default none. */
  tools?: string[];
  /** Folder it runs in (a reading call: the ticket's folder); default the caller's own side-calls folder. */
  cwd?: string;
}

export type SideCallResult = { ok: true; text: string; costUsd: number; model: string } | { ok: false; error: string };

export type SideCaller = (i: SideCallInput) => Promise<SideCallResult>;

export interface SideCallOptions {
  bin?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/** Tools a reading call may be given: none of them change files or run commands. */
export const READ_TOOLS = ["Read", "Grep", "Glob"];

/** Turns a reading call may take (each tool use is one). */
const READ_TURNS = 20;

export function sideCallArgs(i: SideCallInput): string[] {
  const tools = (i.tools ?? []).filter((t) => READ_TOOLS.includes(t));
  return ["-p", "--output-format", "json", "--model", i.model ?? "haiku", "--no-session-persistence", "--tools", tools.join(","),
    ...(tools.length ? ["--max-turns", String(READ_TURNS), "--settings", JSON.stringify({ disableAllHooks: true })] : []),
    "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "project", "--system-prompt", i.system];
}

export function makeSideCaller(o: SideCallOptions = {}): SideCaller {
  return async (i) => {
    const cwd = i.cwd ?? o.cwd ?? join(homedir(), ".claude-kanban", "side-calls");
    mkdirSync(cwd, { recursive: true });
    let p: ReturnType<typeof Bun.spawn>;
    try {
      p = Bun.spawn([o.bin ?? process.env.CKANBAN_CLAUDE_BIN ?? "claude", ...sideCallArgs(i)], {
        cwd, env: helperEnv(o.env ?? process.env), stdin: new Blob([i.prompt]), stdout: "pipe", stderr: "pipe",
      });
    } catch {
      return { ok: false, error: "Claude Code isn't installed or isn't on PATH" };
    }
    const timer = setTimeout(() => p.kill(), i.timeoutMs ?? 90_000);
    const [code, out, err] = await Promise.all([
      p.exited, new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(),
    ]);
    clearTimeout(timer);
    return parseSideResult(out, code, err, i.model ?? "haiku");
  };
}

/** The answer and cost from `claude -p --output-format json`. */
export function parseSideResult(out: string, code: number, err: string, model: string): SideCallResult {
  let r: any = null;
  try {
    r = JSON.parse(out.trim());
  } catch {}
  if (!r || typeof r !== "object") {
    return { ok: false, error: (err.trim() || out.trim() || `claude exited with code ${code}`).split("\n").slice(-2).join(" ") };
  }
  const text = typeof r.result === "string" ? r.result.trim() : "";
  if (r.is_error || !text) return { ok: false, error: text || `claude answered with an error (${r.subtype ?? "unknown"})` };
  const costUsd = typeof r.total_cost_usd === "number" && r.total_cost_usd > 0 ? r.total_cost_usd : 0;
  const used = r.modelUsage && typeof r.modelUsage === "object" ? Object.keys(r.modelUsage)[0] : undefined;
  return { ok: true, text, costUsd, model: used ?? model };
}

// ---------- the ticket's side ledger ----------

export interface SideSpend {
  costUsd: number;
  /** Cost by local day (YYYY-MM-DD). */
  days: Map<string, number>;
}

/** Records a side call's cost on the ticket (file: the ticket's side-spend.jsonl). */
export function addSideSpend(file: string, kind: string, costUsd: number, at = new Date()): void {
  if (!(costUsd > 0)) return;
  appendFileSync(file, JSON.stringify({ at: at.toISOString(), kind, costUsd }) + "\n");
}

const cache = new Map<string, { version: string; spend: SideSpend }>();

/** What a ticket's side calls cost (re-read only when the file changed). */
export function readSideSpend(file: string): SideSpend {
  let version: string;
  try {
    const s = statSync(file);
    version = `${s.size}:${s.mtimeMs}`;
  } catch {
    cache.delete(file);
    return { costUsd: 0, days: new Map() };
  }
  const hit = cache.get(file);
  if (hit?.version === version) return hit.spend;
  const spend: SideSpend = { costUsd: 0, days: new Map() };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const cost = typeof e.costUsd === "number" && e.costUsd > 0 ? e.costUsd : 0;
      if (!cost) continue;
      spend.costUsd += cost;
      const at = new Date(e.at);
      const day = Number.isNaN(at.getTime()) ? "" : dayKey(at);
      spend.days.set(day, (spend.days.get(day) ?? 0) + cost);
    } catch {}
  }
  cache.set(file, { version, spend });
  return spend;
}
