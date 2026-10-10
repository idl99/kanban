#!/usr/bin/env bun
// Fake `claude` CLI for tests. Behaviour controlled by env:
// FAKE_MODE=ok|fail|limit|slow|partial|blocked|noresult|background|bgsilent|asks|nosession, FAKE_PR=<url>, FAKE_ARGS_FILE=<path to append argv JSON>
// FAKE_HEARD_FILE=<path>: appends {session, text} for every user message it reads (huddle routing tests).
// FAKE_NO_SAVE=1: stopped before the session transcript is saved (under CLAUDE_CONFIG_DIR, like the real CLI).
// FAKE_TRANSCRIPT=1: it also thinks, runs a Bash call and posts to its huddle, and writes what it emits to the transcript.
// With --input-format stream-json it reads user messages from stdin like the real CLI: messages that
// arrive mid-run are picked up at the next step (replayed with --replay-user-messages), later ones
// get their own turn, and it exits at end of input.
import { appendFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const streamIn = args.includes("--input-format");
const replay = args.includes("--replay-user-messages");

// FAKE_INIT_SKILLS=a,b: skills (also offered as slash commands) the init event reports, like Claude Code's bundled ones.
const fakeSkills = (process.env.FAKE_INIT_SKILLS ?? "").split(",").filter(Boolean);
const initSkills = fakeSkills.length ? { skills: fakeSkills, slash_commands: fakeSkills } : {};

const inbox: string[] = [];
// Answers to control requests (permission asks), by request id.
const answers = new Map<string, any>();
let eof = false;
let wake = (): void => {};
if (streamIn) {
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    const line = (l: string) => {
      if (!l.trim()) return;
      const m = JSON.parse(l);
      if (m.type === "control_response") return void answers.set(m.response.request_id, m.response);
      inbox.push(m.message.content.map((c: any) => c.text ?? "").join(""));
    };
    for await (const chunk of Bun.stdin.stream()) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      wake();
    }
    line(buf);
    eof = true;
    wake();
  })();
}
async function nextMessage(): Promise<string | null> {
  while (!inbox.length && !eof) await new Promise<void>((r) => (wake = r));
  return inbox.shift() ?? null;
}
const heard: string[] = [];
function take(text: string) {
  heard.push(text);
  if (process.env.FAKE_HEARD_FILE) appendFileSync(process.env.FAKE_HEARD_FILE, JSON.stringify({ session: sessionId, text, env: process.env.CKANBAN_HUDDLE_AGENT ?? null }) + "\n");
  if (replay) emit({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, isReplay: true });
}
/** Pick up messages sent while "working", as the real CLI does between steps. */
function drain() {
  while (inbox.length) take(inbox.shift()!);
}

const first = streamIn ? await nextMessage() : null;
if (process.env.FAKE_ARGS_FILE) {
  appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, cwd: process.cwd(), prompt: first }) + "\n");
}
// FAKE_BLOCK_MATCH: runs whose first prompt contains this text end "blocked" (per-ticket behaviour in one test).
const mode = process.env.FAKE_BLOCK_MATCH && first?.includes(process.env.FAKE_BLOCK_MATCH) ? "blocked" : process.env.FAKE_MODE ?? "ok";
const idx = Math.max(args.indexOf("--session-id"), args.indexOf("--resume"));
const sessionId = idx >= 0 ? args[idx + 1] : "none";

const stepMs = Number(process.env.FAKE_STEP_MS ?? 0);

const transcriptFile = process.env.CLAUDE_CONFIG_DIR && sessionId !== "none" && !process.env.FAKE_NO_SAVE
  ? `${process.env.CLAUDE_CONFIG_DIR}/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, "-")}/${sessionId}.jsonl`
  : null;

function emit(obj: any) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  // Like the real CLI's transcript: assistant blocks and tool results, with timestamps.
  if (process.env.FAKE_TRANSCRIPT && transcriptFile && (obj.type === "assistant" || obj.type === "user") && !obj.isReplay) {
    appendFileSync(transcriptFile, JSON.stringify({ ...obj, sessionId, timestamp: new Date().toISOString() }) + "\n");
  }
}

if (mode === "fail") {
  process.stderr.write("boom: something failed\n");
  process.exit(1);
}
// The real CLI's answer to --resume with a session it has no transcript for.
if (args.includes("--resume") && (mode === "nosession" || (process.env.CLAUDE_CONFIG_DIR && !existsSync(`${process.env.CLAUDE_CONFIG_DIR}/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, "-")}/${sessionId}.jsonl`)))) {
  emit({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: sessionId, errors: [`No conversation found with session ID: ${sessionId}`] });
  process.exit(1);
}

emit({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), ...initSkills });
// Like the real CLI, save the transcript where --resume looks for it (only under a test's own CLAUDE_CONFIG_DIR).
if (process.env.CLAUDE_CONFIG_DIR && sessionId !== "none" && !process.env.FAKE_NO_SAVE) {
  const { mkdirSync } = await import("node:fs");
  const dir = `${process.env.CLAUDE_CONFIG_DIR}/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, "-")}`;
  mkdirSync(dir, { recursive: true });
  appendFileSync(`${dir}/${sessionId}.jsonl`, JSON.stringify({ type: "user", sessionId, cwd: process.cwd(), message: { role: "user", content: first ?? "" } }) + "\n");
}
if (first !== null) take(first);

// The real CLI when the account's spend limit is hit: a synthetic API-error message, an is_error result, exit 1.
if (mode === "limit") {
  const text = process.env.FAKE_LIMIT_TEXT ?? "You've hit your individual spend limit · run /usage-credits to raise it, or visit claude.ai/admin-settings/usage · your session limit resets 4am (Asia/Kuala_Lumpur)";
  emit({ type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] }, error: "rate_limit", is_api_error_message: true });
  emit({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: text, session_id: sessionId });
  process.exit(1);
}

// one event split across two chunks to exercise line buffering
const split = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `${process.cwd()}/src/app.ts` } }] } }) + "\n";
process.stdout.write(split.slice(0, 20));
await Bun.sleep(20);
process.stdout.write(split.slice(20));
process.stdout.write("not json line\n");

if (stepMs) {
  for (const cmd of ["npm install", "npm test"]) {
    await Bun.sleep(stepMs);
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: cmd, name: "Bash", input: { command: cmd } }] } });
    await Bun.sleep(stepMs);
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: cmd, content: `ok: ${cmd}` }] } });
    drain();
  }
}

if (process.env.FAKE_TRANSCRIPT) {
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Checking how rows are built." }] } });
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_ls", name: "Bash", input: { command: "ls src" } }] } });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_ls", content: "app.ts\nlib.ts" }] } });
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_post", name: "mcp__ckanban__huddle_post", input: { text: "@main found it" } }] } });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_post", content: [{ type: "text", text: "Posted #7 as @qa." }] }] } });
}

if (mode === "child") {
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  if (process.env.FAKE_CHILD_PID_FILE) appendFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid));
  await Bun.sleep(30000);
}

if (mode === "slow") {
  await Bun.sleep(30000);
}

// Starts writing its reply, then hangs (a restart cuts it off mid-reply).
if (mode === "partial") {
  emit({ type: "stream_event", event: { type: "message_start" } });
  emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Half a repl" } } });
  await Bun.sleep(30000);
}

// Asks the host for permission like the real CLI does with --permission-prompt-tool stdio.
const decisions: string[] = [];
if (mode === "asks") {
  const asks = [["c1", "mcp__claude-in-chrome__navigate"], ["c2", "Bash"], ["c3", "other"], ["c4", "mcp__ckanban__move_ticket"]];
  for (const [id, tool] of asks) {
    emit({ type: "control_request", request_id: id, request: tool === "other"
      ? { subtype: "elicitation" }
      : { subtype: "can_use_tool", tool_name: tool, input: { url: "https://example.com" }, tool_use_id: `t_${id}` } });
  }
  while (answers.size < asks.length && !eof) await new Promise<void>((r) => (wake = r));
  for (const [id, tool] of asks) {
    const a = answers.get(id);
    decisions.push(`${tool}=${a?.subtype === "error" ? "error" : a?.response?.behavior}`);
  }
}

const pr = process.env.FAKE_PR ?? null;
if (process.env.FAKE_OUTPUT && process.env.CKANBAN_OUTPUT_DIR) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${process.env.CKANBAN_OUTPUT_DIR}/report.md`, process.env.FAKE_OUTPUT);
}

// Leaves a task running in the background past its result, like a long Bash call Claude backgrounded.
const bgMs = Number(process.env.FAKE_BG_MS ?? 300);
const background = mode === "background" || mode === "bgsilent";
if (background) emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg1", task_type: "local_bash", description: "Count timeouts" }] });

drain();
const steered = heard.slice(1);
const status = mode === "blocked" ? "blocked" : mode === "questions" ? "questions" : "done";
const text = mode === "noresult"
  ? "All done, no result line."
  : `Work complete.${steered.length ? `\nSteered: ${steered.join(" | ")}` : ""}${decisions.length ? `\nAsks: ${decisions.join(" ")}` : ""}${process.env.FAKE_EXTRA ?? ""}\nCKANBAN_RESULT: ${JSON.stringify({ status, prUrl: pr, summary: `fake ${status}` })}`;
for (const chunk of ["Work ", "complete."]) {
  if (process.env.FAKE_STREAM_DELAY) await Bun.sleep(Number(process.env.FAKE_STREAM_DELAY));
  emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } } });
}
emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
emit({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01, duration_ms: 100, session_id: sessionId });

// The real CLI kills background tasks at end of input; otherwise it starts a turn when one finishes
// (bgsilent: it doesn't, so the board has to end input itself).
if (background) {
  const t0 = Date.now();
  while (!eof && Date.now() - t0 < bgMs) await Bun.sleep(10);
  const status = eof ? "killed" : "completed";
  emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  emit({ type: "system", subtype: "task_notification", task_id: "bg1", status });
  if (!eof && mode === "background") {
    emit({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), ...initSkills });
    const reply = `Background result: ${status}\nCKANBAN_RESULT: ${JSON.stringify({ status: "done", prUrl: pr, summary: "bg done" })}`;
    emit({ type: "assistant", message: { content: [{ type: "text", text: reply }] } });
    emit({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId });
  }
}

// Messages that arrive after the turn ended get a turn of their own.
while (streamIn) {
  const next = await nextMessage();
  if (next === null) break;
  take(next);
  const reply = `Reply: ${next}\nCKANBAN_RESULT: ${JSON.stringify({ status: "done", prUrl: pr, summary: `reply ${next}` })}`;
  emit({ type: "assistant", message: { content: [{ type: "text", text: reply }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId });
}
