import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { helperArgv } from "../artifact";

// A check script: a small shell script the board runs on a timer, without Claude. It prints the items it found as
// JSON, one per line or one list: {"id": "...", "title": "...", "text": "...", "link": "..."}. The board decides
// what is new. It reaches services through `ckanban call <service> <tool> '<json>'` (passes.ts via the daemon), so it
// never holds a sign-in token; a pasted key meant for scripts comes as one environment variable.

/** One thing a check found. */
export interface Item {
  id: string;
  title: string;
  text?: string;
  link?: string;
}

export interface ScriptRun {
  /** Null when it failed (error says why). */
  items: Item[] | null;
  error: string | null;
  /** The end of what it wrote to stderr (masked by the caller). */
  stderr: string;
  durationMs: number;
}

export const SCRIPT_TIMEOUT_MS = 60_000;
/** Most output a check may print; more is an error, not a cut-off list. */
export const OUTPUT_MAX = 1_000_000;
/** Most items one check may return. */
export const ITEMS_MAX = 500;
const TITLE_MAX = 300;
const TEXT_MAX = 20_000;
const STDERR_KEEP = 4000;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The script's current text, or null when the file is gone. */
export function readScript(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * A `ckanban` command for scripts: a tiny wrapper in the data folder that runs this ckanban (source or binary).
 * Written once per daemon start; its folder goes first on the scripts' PATH.
 */
export function ckanbanShim(root: string): string {
  const dir = join(root, "automation-bin");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "ckanban");
  const line = `#!/bin/sh\nexec ${helperArgv().map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")} "$@"\n`;
  if (!existsSync(file) || readFileSync(file, "utf8") !== line) {
    writeFileSync(file, line);
    chmodSync(file, 0o755);
  }
  return dir;
}

/** What a script runs with: a clean, small environment, not the daemon's (which may hold other secrets). */
export function scriptEnv(o: { shimDir: string; port: number; callToken: string; keys: Record<string, string> }): Record<string, string> {
  const e = process.env;
  const keep: Record<string, string> = {};
  for (const k of ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "TZ"]) if (e[k]) keep[k] = e[k]!;
  return {
    ...keep,
    HOME: keep.HOME ?? homedir(),
    PATH: [o.shimDir, e.PATH ?? "/usr/local/bin:/usr/bin:/bin", "/opt/homebrew/bin", "/usr/local/bin"].join(":"),
    ...o.keys,
    CKANBAN_PORT: String(o.port),
    CKANBAN_CALL_TOKEN: o.callToken,
  };
}

function killGroup(p: { pid: number; kill(sig?: number | NodeJS.Signals): void }) {
  try {
    process.kill(-p.pid, "SIGKILL");
  } catch {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
}

/** Reads a stream up to max bytes; past that it reports `over` and stops keeping more. */
async function capped(stream: ReadableStream<Uint8Array>, max: number): Promise<{ text: string; over: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  for await (const c of stream) {
    if (size + c.length > max) {
      over = true;
      chunks.push(c.subarray(0, Math.max(0, max - size)));
      size = max;
      continue;
    }
    chunks.push(c);
    size += c.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), over };
}

/**
 * Runs the script file with bash (pipefail: a failed `ckanban call` in a pipe fails the check instead of printing
 * nothing) in its own process group; everything it started is killed when it ends or times out.
 */
export async function runScript(file: string, cwd: string, env: Record<string, string>, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<ScriptRun> {
  const started = Date.now();
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(["/bin/bash", "-o", "pipefail", file], { cwd: existsSync(cwd) ? cwd : homedir(), env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (e) {
    return { items: null, error: `Could not start the check: ${(e as Error).message}`, stderr: "", durationMs: 0 };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(p);
  }, timeoutMs);
  const reading = Promise.all([capped(p.stdout as ReadableStream<Uint8Array>, OUTPUT_MAX + 1), capped(p.stderr as ReadableStream<Uint8Array>, 256_000)]);
  const code = await p.exited;
  clearTimeout(timer);
  killGroup(p);
  // A background child may keep the pipes open: don't wait for it long.
  const read = await Promise.race([reading, Bun.sleep(1000).then(() => null)]);
  // Output that didn't finish is not "no items": an empty list here would let the next check flood the board.
  if (!read) return { items: null, error: "The check's output didn't finish (a program it started kept it open)", stderr: "", durationMs: Date.now() - started };
  const [out, err] = read;
  const stderr = err.text.length > STDERR_KEEP ? err.text.slice(-STDERR_KEEP) : err.text;
  const durationMs = Date.now() - started;
  const lastLine = stderr.trim().split("\n").pop() ?? "";
  if (timedOut) return { items: null, error: `The check took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`, stderr, durationMs };
  if (code !== 0) return { items: null, error: `The check failed (exit ${code})${lastLine ? `: ${lastLine}` : ""}`, stderr, durationMs };
  if (out.over) return { items: null, error: "The check printed more than 1 MB: return fewer items", stderr, durationMs };
  try {
    return { items: parseItems(out.text), error: null, stderr, durationMs };
  } catch (e) {
    return { items: null, error: (e as Error).message, stderr, durationMs };
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").slice(0, max);

/** Items from a script's output: one JSON list, or one JSON object per line. Throws a plain-words message. */
export function parseItems(out: string): Item[] {
  const text = out.trim();
  if (!text) return [];
  let raw: unknown[];
  if (text.startsWith("[")) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error("The check's output isn't valid JSON");
    }
  } else {
    raw = text.split("\n").filter((l) => l.trim()).map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`Line ${i + 1} of the check's output isn't JSON: ${l.slice(0, 80)}`);
      }
    });
  }
  if (raw.length > ITEMS_MAX) throw new Error(`The check returned ${raw.length} items; at most ${ITEMS_MAX} are allowed`);
  const items: Item[] = [];
  const ids = new Set<string>();
  for (const [i, r] of raw.entries()) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const id = str(o.id, 200).trim();
    const title = str(o.title, TITLE_MAX).trim();
    if (!id || !title) throw new Error(`Item ${i + 1} needs an "id" and a "title"`);
    if (ids.has(id)) continue;
    ids.add(id);
    const textValue = str(o.text, TEXT_MAX);
    const link = str(o.link, 2000).trim();
    items.push({ id, title, ...(textValue.trim() ? { text: textValue } : {}), ...(/^https?:\/\/\S+$/.test(link) ? { link } : {}) });
  }
  return items;
}
