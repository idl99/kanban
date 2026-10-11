import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findSessionFile } from "./session";
import { ptySupported } from "./shell";
import { shellQuote } from "./util";
import { IS_BINARY } from "./version";

/**
 * Headless `claude -p` runs never get the built-in Artifact tool (off by design in SDK contexts).
 * This helper publishes/reads artifacts through a short-lived interactive `claude` on a hidden terminal
 * (Bun's built-in one; tmux only on Bun builds without it), which does have it, and reads the result from
 * that session's transcript.
 */

export const TMUX_PREFIX = "ckanban-artifact-";

export type ArtifactJob =
  | { kind: "publish"; file: string; url?: string; title?: string }
  | { kind: "read"; url: string };

export type ArtifactOutcome =
  | { ok: true; kind: "publish"; url: string; text: string }
  | { ok: true; kind: "read"; html: string }
  | { ok: false; error: string };

/** How a board run calls this helper (the daemon may run from source, so `ckanban` isn't on PATH). */
export function helperCommand(): string {
  return helperArgv().map(shellQuote).join(" ");
}

export function helperArgv(): string[] {
  return IS_BINARY ? [process.execPath] : [process.execPath, join(import.meta.dir, "..", "cli.ts")];
}

/**
 * Markers a board run passes down. With the first two the child counts as SDK and loses Artifact; as a child
 * session it stops saving its transcript, which is where the helper reads the result.
 */
const PARENT_MARKERS = new Set([
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_EXECPATH",
]);

/** Env for the helper: a top-level interactive Claude, not a child of the run that called it. */
export function helperEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || PARENT_MARKERS.has(k)) continue;
    out[k] = v;
  }
  out.CLAUDE_CODE_ARTIFACT_AUTO_OPEN = "0";
  return out;
}

function readPrompt(url: string): string {
  return `Call the Artifact tool once with action "read" and url ${url}. Do nothing else: no other tools, no summary. Then reply DONE.`;
}

/**
 * Messages the helper session gets, one per turn. Republishing needs two: the service refuses a
 * publish unless this session viewed the live version in an earlier turn. The caller already read
 * that version and merged its edits into the file, so the helper only views it to be allowed.
 */
export function jobPrompts(job: ArtifactJob): string[] {
  if (job.kind === "read") return [readPrompt(job.url)];
  const title = job.title ? ` Use the title ${JSON.stringify(job.title)}.` : "";
  const rules = "Publish the file exactly as it is on disk: it already contains the latest live content plus the new edits. Do not read, edit or rewrite it yourself and call no other tools. Then reply DONE.";
  if (!job.url) return [`Publish the file ${job.file} with the Artifact tool.${title} ${rules}`];
  return [
    readPrompt(job.url),
    `Now publish the file ${job.file} with the Artifact tool, passing url ${job.url}, so it becomes a new version at that same link.${title} ${rules}`,
  ];
}

const PUBLISHED = /Published (\S+) at (https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+)/;

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
  return "";
}

/** Page source from a read result: the tagged raw HTML, minus the document shell the viewer adds. */
export function extractReadHtml(text: string): string | null {
  const m = text.match(/<cowritten-artifact-html>\n([\s\S]*?)\n<\/cowritten-artifact-html>/);
  if (!m) return null;
  let html = m[1];
  const shell = html.match(/^<!doctype html><html><head>[\s\S]*?<\/head><body>\n/i);
  if (shell && /<\/body><\/html>\s*$/i.test(html)) html = html.slice(shell[0].length).replace(/\n?<\/body><\/html>\s*$/i, "");
  return html;
}

/** The helper session's answer to the job, or null while it is still working. */
export function findOutcome(raw: string, kind: ArtifactJob["kind"]): ArtifactOutcome | null {
  const uses = new Map<string, any>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use" && b.name === "Artifact") uses.set(b.id, b.input ?? {});
      if (b?.type !== "tool_result") continue;
      const text = resultText(b.content);
      if (/No such tool available: Artifact|Artifact exists but is not enabled/.test(text)) {
        return { ok: false, error: ERRORS.noArtifactTool };
      }
      const input = uses.get(b.tool_use_id);
      if (!input) continue;
      const action = typeof input.action === "string" ? input.action : "publish";
      if (kind === "read" ? action !== "read" : !(action === "publish" || input.file_path)) continue;
      if (b.is_error || text.includes("<tool_use_error>")) {
        return { ok: false, error: text.replace(/<\/?tool_use_error>/g, "").trim() };
      }
      if (kind === "read") {
        const html = extractReadHtml(text);
        return html === null ? { ok: false, error: "read result had no page source" } : { ok: true, kind: "read", html };
      }
      const m = text.match(PUBLISHED);
      const url = m?.[2] ?? (typeof ev.toolUseResult?.url === "string" ? ev.toolUseResult.url : null);
      return url ? { ok: true, kind: "publish", url, text: m?.[0] ?? `Published ${input.file_path} at ${url}` } : { ok: false, error: text.trim() };
    }
  }
  return null;
}

/** Screen text from raw terminal output: escape sequences dropped, cursor-forward moves turned back into spaces. */
export function screenText(raw: string): string {
  return raw
    .replace(/\x1b\[(\d*)C/g, (_, n) => " ".repeat(Number(n) || 1))
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]/g, "");
}

/** Interactive prompts the helper may hit before its prompt runs. */
export function paneState(pane: string, typed: string[] = []): "trust" | "bypass" | "login" | null {
  if (/Yes, I trust this folder/.test(pane)) return "trust";
  if (/Bypass Permissions mode/i.test(pane) && /Yes, I accept/.test(pane)) return "bypass";
  // The screen also shows what we typed (title, file path), so a login phrase in there proves nothing.
  if (LOGIN.test(pane) && !typed.some((t) => LOGIN.test(t))) return "login";
  return null;
}

const LOGIN = /Select login method|Please run \/login|Not logged in|Invalid API key/i;

export const ERRORS = {
  login: "Claude Code isn't logged in: open the Claude tab and run /login, then try again.",
  bypass: "Claude Code needs a one-time OK before it can publish: open the Terminal tab, run `claude --permission-mode bypassPermissions`, choose \"Yes, I accept\", then try again.",
  exited: "Claude Code closed before publishing finished. Open the Claude tab to check it starts and is logged in, then try again.",
  notInstalled: "Claude Code isn't installed or can't be found. Install it from claude.com/code, then try again.",
  noRuntime: "Publishing needs a newer ckanban runtime. Update ckanban.",
  noArtifactTool: "Your Claude Code can't publish artifacts. Update Claude Code and check you are logged in with a claude.ai account, then try again.",
  timeout: (s: number, kind: ArtifactJob["kind"]) =>
    `${kind === "read" ? "Reading the artifact" : "Publishing"} took too long (over ${s}s) and was stopped. Try again in a minute.`,
};

export interface RunOptions {
  bin?: string;
  model?: string;
  timeoutMs?: number;
  /** Folder the helper runs in; ckanban owns it, so accepting Claude's trust prompt there is safe. */
  cwd?: string;
  pollMs?: number;
  /** Environment the helper starts from (default: this process's). */
  env?: Record<string, string | undefined>;
  /** Drive the helper on Bun's built-in terminal (default: when this Bun has one), else in tmux. */
  pty?: boolean;
}

/** The hidden interactive `claude` a job talks to. */
interface HelperSession {
  /** Types a message and submits it. */
  type(text: string): Promise<void>;
  /** Accepts the folder trust prompt (its default answer is "No, exit"). */
  acceptTrust(): Promise<void>;
  /** What the screen shows lately, or null once Claude has exited. */
  screen(): Promise<string | null>;
  /** Forgets the screen so a prompt that was answered doesn't match again. */
  clear(): void;
  kill(): void;
}

interface StartOptions {
  bin: string;
  cwd: string;
  sessionId: string;
  model: string;
  prompt: string;
  env: Record<string, string>;
}

export function claudeArgs(o: { bin: string; sessionId: string; model: string; prompt: string }): string[] {
  return [o.bin, "--model", o.model, "--permission-mode", "bypassPermissions", "--session-id", o.sessionId, o.prompt];
}

const SCREEN_KEEP = 32 * 1024;

/** Claude on Bun's built-in pseudo-terminal: no tmux needed. */
function startPty(o: StartOptions): HelperSession | string {
  let out = "";
  let exited = false;
  const decoder = new TextDecoder();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(claudeArgs(o), {
      cwd: o.cwd,
      env: { ...o.env, TERM: "xterm-256color" },
      terminal: {
        cols: 200, rows: 50, name: "xterm-256color",
        data: (_t, d) => {
          out = (out + decoder.decode(d, { stream: true })).slice(-SCREEN_KEEP);
        },
      },
    });
  } catch {
    return ERRORS.notInstalled;
  }
  proc.exited.then(() => {
    exited = true;
  });
  const write = (s: string) => {
    if (!exited) proc.terminal?.write(s);
  };
  return {
    async type(text) {
      write(text);
      await Bun.sleep(300);
      write("\r");
    },
    async acceptTrust() {
      write("\x1b[B");
      await Bun.sleep(200);
      write("\r");
    },
    async screen() {
      return exited ? null : screenText(out);
    },
    clear() {
      out = "";
    },
    kill() {
      if (exited) return;
      // Claude leads its own session on the terminal, so its group holds the tools it started too.
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        proc.kill("SIGTERM");
      }
      const hard = setTimeout(() => {
        if (exited) return;
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
      }, 2000);
      hard.unref?.();
      proc.terminal?.close();
    },
  };
}

/**
 * tmux argv, for Bun builds without a built-in terminal. The command runs through `env -u` because the
 * tmux server's global environment may come from a board run too, so unsetting only our own spawn env isn't enough.
 */
export function tmuxArgs(o: { name: string; cwd: string; bin: string; sessionId: string; model: string; prompt: string }): string[] {
  return [
    "tmux", "new-session", "-d", "-s", o.name, "-x", "200", "-y", "50", "-c", o.cwd,
    "env", ...[...PARENT_MARKERS].flatMap((k) => ["-u", k]), "CLAUDE_CODE_ARTIFACT_AUTO_OPEN=0",
    ...claudeArgs(o),
  ];
}

async function tmux(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  return { code: await p.exited, out };
}

async function startTmux(o: StartOptions): Promise<HelperSession | string> {
  const name = `${TMUX_PREFIX}${o.sessionId.slice(0, 8)}`;
  const p = Bun.spawn(tmuxArgs({ ...o, name }), { env: o.env, stdout: "ignore", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) return `Could not start tmux to publish: ${err.trim()}`;
  return {
    async type(text) {
      await tmux(["send-keys", "-t", name, "-l", text]);
      await Bun.sleep(300);
      await tmux(["send-keys", "-t", name, "Enter"]);
    },
    async acceptTrust() {
      await tmux(["send-keys", "-t", name, "Down"]);
      await Bun.sleep(200);
      await tmux(["send-keys", "-t", name, "Enter"]);
    },
    async screen() {
      const pane = await tmux(["capture-pane", "-p", "-t", name]);
      if (pane.code !== 0) return null;
      return pane.out;
    },
    clear() {
      // capture-pane shows the live screen, which redraws itself; nothing to forget.
    },
    kill() {
      Bun.spawnSync(["tmux", "kill-session", "-t", name], { stdout: "ignore", stderr: "ignore" });
    },
  };
}

/**
 * Removes `ckanban-artifact-*` tmux sessions older versions may have left behind. Only when this Bun has a
 * built-in terminal, and only ones older than any job may run, since an older ckanban (another profile's daemon,
 * an old CLI) may still be publishing through tmux.
 */
/** Longer than any job's timeout. */
const LEFTOVER_AGE_S = 15 * 60;

export async function cleanupTmuxLeftovers(): Promise<void> {
  if (!ptySupported() || !Bun.which("tmux")) return;
  try {
    const ls = await tmux(["list-sessions", "-F", "#{session_name} #{session_created}"]);
    if (ls.code !== 0) return;
    const before = Date.now() / 1000 - LEFTOVER_AGE_S;
    for (const line of ls.out.split("\n")) {
      const [name, created] = line.split(" ");
      if (name?.startsWith(TMUX_PREFIX) && Number(created) < before) await tmux(["kill-session", "-t", name]);
    }
  } catch {}
}

export async function runArtifactJob(job: ArtifactJob, o: RunOptions = {}): Promise<ArtifactOutcome> {
  const baseEnv = o.env ?? process.env;
  const pty = o.pty ?? ptySupported();
  if (!pty && !Bun.which("tmux", { PATH: baseEnv.PATH ?? "" })) {
    return { ok: false, error: ERRORS.noRuntime };
  }
  const cwd = o.cwd ?? join(homedir(), ".claude-kanban", "artifact-helper");
  mkdirSync(cwd, { recursive: true });
  const sessionId = crypto.randomUUID();
  const timeoutMs = o.timeoutMs ?? 180_000;
  const pollMs = o.pollMs ?? 1000;
  const env = helperEnv(baseEnv);
  const configDir = baseEnv.CLAUDE_CONFIG_DIR;
  const prompts = jobPrompts(job);
  const start = { bin: o.bin ?? "claude", cwd, sessionId, model: o.model ?? "haiku", prompt: prompts[0], env };

  const session = pty ? startPty(start) : await startTmux(start);
  if (typeof session === "string") return { ok: false, error: session };
  const onSignal = () => {
    session.kill();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    // Each step's outcome is what that turn's tool call returned; only the last one is the job's.
    const steps: ArtifactJob["kind"][] = prompts.map((_, i) => (i < prompts.length - 1 ? "read" : job.kind));
    let step = 0;
    // Once Claude writes its transcript it got past startup, so a login screen is no longer the question.
    let started = false;
    const transcript = () => {
      const file = findSessionFile(sessionId, { configDir });
      if (file) started = true;
      return file ? findOutcome(readFileSync(file, "utf8"), steps[step]) : null;
    };
    const deadline = Date.now() + timeoutMs;
    let trusted = false;
    while (Date.now() < deadline) {
      await Bun.sleep(pollMs);
      const outcome = transcript();
      if (outcome && (!outcome.ok || step === prompts.length - 1)) return friendly(outcome);
      if (outcome) {
        step++;
        await session.type(prompts[step]);
        continue;
      }
      const screen = await session.screen();
      if (screen === null) {
        // It may have written its answer just before it closed.
        const last = transcript();
        if (last && (!last.ok || step === prompts.length - 1)) return friendly(last);
        return { ok: false, error: ERRORS.exited };
      }
      const state = paneState(screen, prompts);
      if (state === "trust" && !trusted) {
        trusted = true;
        session.clear();
        await session.acceptTrust();
      } else if (state === "bypass") {
        return { ok: false, error: ERRORS.bypass };
      } else if (state === "login" && !started) {
        return { ok: false, error: ERRORS.login };
      }
    }
    return { ok: false, error: ERRORS.timeout(Math.round(timeoutMs / 1000), job.kind) };
  } finally {
    session.kill();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** Plain wording for errors the helper session reports. */
function friendly(outcome: ArtifactOutcome): ArtifactOutcome {
  if (outcome.ok) return outcome;
  if (LOGIN.test(outcome.error)) return { ok: false, error: ERRORS.login };
  return outcome;
}
