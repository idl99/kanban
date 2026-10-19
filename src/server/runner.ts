import { NO_EDIT_TOOLS } from "./huddle-roster";
import type { BackgroundTask } from "./types";

export interface RunOutput {
  code: number;
  stderr: string;
  events: any[];
}

export interface RunHandle {
  done: Promise<RunOutput>;
  stop(): void;
  /**
   * Hand Claude another user message while it works; it reads it at its next step, like typing
   * in an interactive session. False once input is closed (the run is finishing).
   * local: a built-in slash command (/compact) Claude Code runs without a model turn; it is never echoed back,
   * so it must not hold input open waiting for that.
   */
  send(text: string, opts?: { local?: boolean }): boolean;
  /** A run started with idleMs: stop keeping input open, and end it now if Claude is idle. */
  endWhenIdle(): void;
  /** A stalled run (see stallMs): the user chose Keep waiting, so the watchdog starts counting again. */
  keepWaiting(): void;
  readonly stopped: boolean;
}

/** After Claude's last task finishes, how long to wait for the turn it starts before ending input anyway. */
export const BACKGROUND_GRACE_MS = 10_000;
/** How long a monitor-mode huddle session stays open between turns before it exits (later messages resume it). */
export const MONITOR_IDLE_MS = 30 * 60_000;
/** Board setting "Stall after": minutes without stream output before a run counts as stalled (0: never). */
export const DEFAULT_STALL_MINUTES = 20;
const TASK_DONE = new Set(["completed", "failed", "killed", "stopped"]);

const STDERR_TAIL = 2048;

/** Once claude has exited its pid may belong to another process (a git command, another run), so it is left alone. */
function killGroup(p: { pid: number; exitCode: number | null; signalCode: unknown; kill(signal?: NodeJS.Signals): void }, signal: "TERM" | "KILL") {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const r = Bun.spawnSync(["kill", `-${signal}`, "--", `-${p.pid}`], { stdout: "ignore", stderr: "ignore" });
  if (r.exitCode !== 0) {
    try {
      p.kill(`SIG${signal}`);
    } catch {}
  }
}

export function buildArgs(
  sessionId: string, resume: boolean, model?: string | null,
  /** Tools this run can't use (--disallowedTools), e.g. NO_EDIT_TOOLS or PLANNING_DISALLOWED_TOOLS. */
  disallowedTools: string[] = [],
  /** Inline MCP config (see mcpConfig) so every run has the board's tools. */
  mcp?: string,
  /** Board instructions for a run whose message is a slash command (they can't share its text, see Board.executeOnce). */
  systemPrompt?: string,
  /** Spending cap for this run (--max-budget-usd); the run stops with an error_max_budget_usd result once it is spent. */
  maxBudgetUsd?: number | null,
): string[] {
  // Prompts go in on stdin (see startRun) so more messages can follow while Claude works;
  // --replay-user-messages echoes each one back when Claude picks it up.
  // --include-partial-messages: token-level stream events, used for live replies in the chat.
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
    "--include-partial-messages", "--permission-mode", "bypassPermissions"];
  if (disallowedTools.length) args.push("--disallowedTools", disallowedTools.join(","));
  args.push(resume ? "--resume" : "--session-id", sessionId);
  if (model) args.push("--model", model);
  if (mcp) args.push("--mcp-config", mcp);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  if (maxBudgetUsd) args.push("--max-budget-usd", String(maxBudgetUsd));
  // Claude in Chrome. Its tools ask for permission even under bypassPermissions; with
  // --permission-prompt-tool stdio those asks reach the board as control requests (see controlResponse).
  args.push("--chrome", "--permission-prompt-tool", "stdio");
  return args;
}

const CHROME_TOOL = "mcp__claude-in-chrome__";
/**
 * Backlog/Planning chats may act outside the project when the user asks (APIs, browser, commands), so they don't
 * use plan mode. Instead they can't edit files (the prompt also rules out shell edits), and the board tools that
 * plan mode used to block and the daemon doesn't check per run (schedules, jobs, starting a huddle) are off too.
 */
export const PLANNING_DISALLOWED_TOOLS = [
  ...NO_EDIT_TOOLS.split(","),
  ...["create_schedule", "update_schedule", "delete_schedule", "run_schedule", "schedule_job", "update_job", "run_job_now", "cancel_job", "start_huddle"]
    .map((t) => `mcp__ckanban__${t}`),
];
/**
 * The board's huddle tools: they only touch the huddle, never files, so any run (a Planning chat too) can
 * coordinate its huddle.
 */
const HUDDLE_TOOLS = new Set(["huddle_post", "huddle_read", "huddle_mode", "huddle_findings", "huddle_add_participant", "huddle_status", "huddle_close", "huddle_brief", "huddle_hand_in", "huddle_review_changes", "huddle_allow_changes"].map((t) => `mcp__ckanban__${t}`));
/**
 * Board tools a Planning chat may use when the user asks for it in their message, should Claude ask permission for
 * them. They never touch files; the daemon decides per call (Board.userRequestRights), so a Planning run without the
 * user's message gets nothing.
 * suggest_tags only adds suggestions to the chat's own ticket, which the user keeps or drops.
 */
const PLANNING_BOARD_TOOLS = new Set(["move_ticket", "update_ticket", "comment_ticket", "create_ticket", "chat_ticket", "stop_ticket", "plan_control", "adopt_tickets", "suggest_tags"]
  .map((t) => `mcp__ckanban__${t}`));

/**
 * The board's answer to a control request from claude (stream-json). Permission asks for Claude in Chrome
 * tools and the huddle tools are allowed, and in a Planning run the board tools too; every other ask
 * is denied, as it was before prompts reached the board (headless runs had nobody to answer them). Anything else
 * gets an error so claude never waits on the board.
 */
export function controlResponse(ev: any, planning = false): unknown {
  const req = ev?.request;
  const id = ev?.request_id;
  if (req?.subtype !== "can_use_tool") {
    return { type: "control_response", response: { subtype: "error", request_id: id, error: `unsupported control request: ${req?.subtype}` } };
  }
  const tool = typeof req.tool_name === "string" ? req.tool_name : "";
  const allow = tool.startsWith(CHROME_TOOL) || HUDDLE_TOOLS.has(tool) || (planning && PLANNING_BOARD_TOOLS.has(tool));
  return {
    type: "control_response",
    response: {
      subtype: "success", request_id: id,
      response: allow
        ? { behavior: "allow", updatedInput: req.input ?? {} }
        : { behavior: "deny", message: "Permission prompts can't be answered in a board run." },
    },
  };
}

function userMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
}

/** A run's identity vars: each run gets its own from opts.env, never the ones of a run the daemon was started from. */
export const RUN_IDENTITY_ENV = ["CKANBAN_TICKET", "CKANBAN_HUDDLE_AGENT", "CKANBAN_OUTPUT_DIR"] as const;

/** The daemon's environment minus run identity vars, so a child can't act as a run it doesn't belong to. */
export function inheritedEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const out = { ...env };
  for (const k of RUN_IDENTITY_ENV) delete out[k];
  return out;
}

export function startRun(opts: {
  bin: string;
  cwd: string;
  args: string[];
  env?: Record<string, string>;
  /** First user message, written to stdin (needs --input-format stream-json in args). */
  input?: string;
  /** The first message is a local slash command (see RunHandle.send). */
  inputLocal?: boolean;
  /** A Planning chat: its permission asks for the board tools are allowed (see controlResponse). */
  planning?: boolean;
  onEvent: (ev: any) => void;
  /**
   * Claude ended its turn but background tasks it waits on are still running (the run stays
   * open so it can pick their results up); null once it is working or done again.
   */
  onWaiting?: (tasks: BackgroundTask[] | null) => void;
  graceMs?: number;
  /**
   * Keep input open this long after Claude goes idle, so more messages reach the live session (huddle monitor
   * mode); then end it. 0/undefined: end input as soon as Claude is idle with nothing unread.
   */
  idleMs?: number;
  /**
   * Watchdog: no stream output for this long marks the run stalled (onStall(true)); output resumes it (onStall(false)).
   * Nothing is killed. A run waiting on background tasks or idling between turns (idleMs) is exempt. 0/undefined: off.
   */
  stallMs?: number;
  onStall?: (stalled: boolean) => void;
}): RunHandle {
  let stopped = false;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const events: any[] = [];
  let stdin: import("bun").FileSink | null = null;
  // Messages written but not yet picked up by Claude (no replay seen).
  let unread = 0;
  // Background tasks still running. Claude Code kills them when input ends, and starts a turn of
  // its own when one finishes, so input stays open while any are left.
  const tasks = new Map<string, BackgroundTask>();
  // Between Claude's result and its next turn.
  let idle = false;
  let waiting = false;
  let grace: ReturnType<typeof setTimeout> | null = null;
  const clearGrace = () => {
    if (grace) clearTimeout(grace);
    grace = null;
  };
  let keepMs = opts.idleMs ?? 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const quiet = () => idle && unread === 0 && !tasks.size;
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  };
  /** (Re)start the watchdog: called on every line of output, and when the user chose Keep waiting. */
  const armStall = () => {
    if (!opts.stallMs) return;
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      // Declared background tasks and an open idle window are silent on purpose: keep watching, don't flag them.
      if (tasks.size || idleTimer || !proc) return armStall();
      stalled = true;
      opts.onStall?.(true);
    }, opts.stallMs);
  };
  const outputSeen = () => {
    armStall();
    if (!stalled) return;
    stalled = false;
    opts.onStall?.(false);
  };
  /** Claude is done and nothing is waiting: end input (so the process exits), or wait idleMs for more messages first. */
  const finish = () => {
    if (!keepMs) return closeInput();
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (quiet()) closeInput();
    }, keepMs);
  };
  const report = () => {
    const now = idle && tasks.size > 0 && !!stdin;
    if (!now && !waiting) return;
    waiting = now;
    opts.onWaiting?.(now ? [...tasks.values()] : null);
  };
  const closeInput = () => {
    clearGrace();
    clearIdle();
    const s = stdin;
    stdin = null;
    try {
      s?.end();
    } catch {}
  };
  const writeLine = (line: string): boolean => {
    if (!stdin) return false;
    try {
      stdin.write(line);
      stdin.flush();
    } catch {
      stdin = null;
      return false;
    }
    return true;
  };
  const write = (text: string, local = false): boolean => {
    if (!writeLine(userMessage(text))) return false;
    if (!local) {
      unread++;
      clearIdle();
    }
    return true;
  };

  const done = (async (): Promise<RunOutput> => {
    try {
      proc = Bun.spawn([opts.bin, ...opts.args], {
        cwd: opts.cwd, env: { ...inheritedEnv(), ...opts.env }, stdout: "pipe", stderr: "pipe", stdin: opts.input === undefined ? "ignore" : "pipe",
        // Own process group so stop() can take down tools claude spawned (shells, dev servers).
        detached: true,
      });
    } catch (e) {
      return { code: -1, stderr: `failed to start ${opts.bin}: ${(e as Error).message}`, events };
    }
    const p = proc;
    armStall();
    if (opts.input !== undefined) {
      stdin = p.stdin as import("bun").FileSink;
      write(opts.input, opts.inputLocal);
    }

    const trackTasks = (ev: any) => {
      if (ev?.type !== "system") return;
      if (ev.subtype === "background_tasks_changed" && Array.isArray(ev.tasks)) {
        // The full current list: keep first-seen times for tasks already known.
        const known = new Map(tasks);
        tasks.clear();
        for (const t of ev.tasks) {
          const id = String(t?.task_id ?? "");
          if (!id) continue;
          tasks.set(id, known.get(id) ?? { id, description: String(t.description || "Background task"), startedAt: new Date().toISOString() });
        }
      } else if (ev.subtype === "task_notification" && TASK_DONE.has(ev.status)) tasks.delete(String(ev.task_id));
      else if (ev.subtype === "task_updated" && TASK_DONE.has(ev.patch?.status)) tasks.delete(String(ev.task_id));
    };

    const readStdout = (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      const handleLine = (line: string) => {
        if (!line.trim()) return;
        outputSeen();
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        // Permission asks and other requests to the host: answer them, they aren't part of the conversation.
        if (ev?.type === "control_request") {
          writeLine(JSON.stringify(controlResponse(ev, opts.planning)) + "\n");
          return;
        }
        // Partial-message deltas are only for the live view; don't keep thousands of them in memory.
        if (ev?.type !== "stream_event") events.push(ev);
        if (ev?.type === "user" && ev.isReplay) unread = Math.max(0, unread - 1);
        trackTasks(ev);
        if (ev?.type === "result") idle = true;
        else if (ev?.type === "assistant" || ev?.type === "stream_event" || (ev?.type === "system" && ev.subtype === "init")) {
          idle = false;
          clearGrace();
          clearIdle();
        }
        // Claude is done and nothing is waiting: end input so the process exits. Messages still
        // unread keep it open; Claude answers them in another turn with its own result. So do
        // background tasks: Claude resumes on its own when they finish.
        if (idle && unread === 0 && stdin) {
          if (!tasks.size && ev?.type === "result") finish();
          // The last task finished after the result: Claude normally starts a turn for it at
          // once; if it doesn't, don't keep the process around forever.
          else if (!tasks.size && !grace && !idleTimer) grace = setTimeout(() => {
            grace = null;
            if (quiet()) finish();
          }, opts.graceMs ?? BACKGROUND_GRACE_MS);
        }
        report();
        opts.onEvent(ev);
      };
      for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          handleLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      handleLine(buf);
    })();

    const stderrText = new Response(p.stderr as ReadableStream).text();
    const [code, stderr] = await Promise.all([p.exited, stderrText, readStdout]);
    clearStall();
    if (stalled) {
      stalled = false;
      opts.onStall?.(false);
    }
    closeInput();
    idle = false;
    report();
    return { code, stderr: stderr.slice(-STDERR_TAIL), events };
  })();

  return {
    done,
    send: (text, o) => !stopped && write(text, o?.local),
    endWhenIdle() {
      keepMs = 0;
      if (idleTimer && quiet()) closeInput();
    },
    keepWaiting() {
      if (!stalled) return;
      stalled = false;
      armStall();
    },
    get stopped() {
      return stopped;
    },
    stop() {
      if (!proc || stopped) return;
      stopped = true;
      closeInput();
      const p = proc;
      killGroup(p, "TERM");
      const timer = setTimeout(() => killGroup(p, "KILL"), 5000);
      p.exited.then(() => clearTimeout(timer));
    },
  };
}
