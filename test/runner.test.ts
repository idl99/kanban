import { expect, test } from "bun:test";
import { join } from "node:path";
import { mcpConfig } from "../src/server/agents";
import { buildArgs, controlResponse, inheritedEnv, PLANNING_DISALLOWED_TOOLS, startRun } from "../src/server/runner";
import { tempDir } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");

function withMode(mode: string, fn: () => Promise<void>) {
  return async () => {
    process.env.FAKE_MODE = mode;
    try { await fn(); } finally { delete process.env.FAKE_MODE; }
  };
}

test("ok run collects events and skips non-json lines", withMode("ok", async () => {
  const seen: any[] = [];
  const h = startRun({ bin: FAKE, cwd: tempDir(), args: ["-p", "x"], onEvent: (e) => seen.push(e) });
  const r = await h.done;
  expect(r.code).toBe(0);
  expect(r.events.map((e) => e.type)).toEqual(["system", "assistant", "assistant", "result"]);
  expect(seen.filter((e) => e.type !== "stream_event").length).toBe(4);
  expect(r.events[1].message.content[0].name).toBe("Edit");
}));

test("fail run returns code and stderr tail", withMode("fail", async () => {
  const r = await startRun({ bin: FAKE, cwd: tempDir(), args: [], onEvent: () => {} }).done;
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("boom");
}));

test("stop terminates slow run", withMode("slow", async () => {
  const h = startRun({ bin: FAKE, cwd: tempDir(), args: [], onEvent: () => {} });
  await Bun.sleep(300);
  const t0 = Date.now();
  h.stop();
  const r = await h.done;
  expect(Date.now() - t0).toBeLessThan(7000);
  expect(r.code).not.toBe(0);
  expect(h.stopped).toBe(true);
}), 10000);

test("missing binary resolves with error", async () => {
  const r = await startRun({ bin: "/nonexistent/claude", cwd: tempDir(), args: [], onEvent: () => {} }).done;
  expect(r.code).not.toBe(0);
  expect(r.stderr.length).toBeGreaterThan(0);
});

test("buildArgs", () => {
  const first = buildArgs("u1", false, "sonnet");
  expect(first).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
    "--include-partial-messages", "--permission-mode", "bypassPermissions", "--session-id", "u1", "--model", "sonnet",
    "--chrome", "--permission-prompt-tool", "stdio"]);
  const again = buildArgs("u1", true, null);
  expect(again).toContain("--resume");
  expect(again).not.toContain("--session-id");
  expect(again).not.toContain("--model");
});

test("stop kills the whole process group (grandchildren too)", async () => {
  const pidFile = join(tempDir(), "child.pid");
  process.env.FAKE_MODE = "child";
  process.env.FAKE_CHILD_PID_FILE = pidFile;
  try {
    const h = startRun({ bin: FAKE, cwd: tempDir(), args: [], onEvent: () => {} });
    await Bun.sleep(600);
    const childPid = Number(await Bun.file(pidFile).text());
    expect(childPid).toBeGreaterThan(0);
    h.stop();
    await h.done;
    await Bun.sleep(200);
    let alive = true;
    try { process.kill(childPid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  } finally {
    delete process.env.FAKE_MODE;
    delete process.env.FAKE_CHILD_PID_FILE;
  }
}, 10000);

const STREAM = buildArgs("u1", false, null);

test("messages sent mid-run reach Claude at its next step, in order", async () => {
  process.env.FAKE_STEP_MS = "150";
  try {
    const h = startRun({ bin: FAKE, cwd: tempDir(), args: STREAM, input: "do it", onEvent: () => {} });
    await Bun.sleep(100);
    expect(h.send("also A")).toBe(true);
    expect(h.send("also B")).toBe(true);
    const r = await h.done;
    expect(r.code).toBe(0);
    const replays = r.events.filter((e) => e.type === "user" && e.isReplay).map((e) => e.message.content[0].text);
    expect(replays).toEqual(["do it", "also A", "also B"]);
    expect(r.events.filter((e) => e.type === "result").length).toBe(1);
    expect(r.events.at(-1).result).toContain("Steered: also A | also B");
    expect(h.send("too late")).toBe(false);
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
});

test("a message that lands after Claude's result gets its own turn before exit", async () => {
  let h: ReturnType<typeof startRun>;
  let sent = false;
  h = startRun({
    bin: FAKE, cwd: tempDir(), args: STREAM, input: "do it",
    // Sent while the final message is being written, i.e. just before the result line.
    onEvent: (e) => {
      if (e.type === "assistant" && e.message.content[0]?.type === "text" && !sent) sent = h.send("one more thing");
    },
  });
  const r = await h.done;
  expect(sent).toBe(true);
  expect(r.code).toBe(0);
  const results = r.events.filter((e) => e.type === "result");
  expect(results.length).toBe(2);
  expect(results[1].result).toContain("Reply: one more thing");
});

test("run without follow-ups exits once Claude has answered", async () => {
  const t0 = Date.now();
  const r = await startRun({ bin: FAKE, cwd: tempDir(), args: STREAM, input: "hi", onEvent: () => {} }).done;
  expect(r.code).toBe(0);
  expect(Date.now() - t0).toBeLessThan(5000);
});

test("buildArgs passes the board's MCP server so every run has the ckanban tools", () => {
  const cfg = mcpConfig(["/bin/bun", "/src/cli.ts", "mcp"]);
  expect(JSON.parse(cfg)).toEqual({ mcpServers: { ckanban: { command: "/bin/bun", args: ["/src/cli.ts", "mcp"] } } });
  const args = buildArgs("u1", false, null, PLANNING_DISALLOWED_TOOLS, cfg);
  expect(args[args.indexOf("--mcp-config") + 1]).toBe(cfg);
  expect(JSON.parse(mcpConfig()).mcpServers.ckanban.args.at(-1)).toBe("mcp");
});

test("buildArgs: planning chats skip plan mode but can't edit files", () => {
  const planning = buildArgs("u1", false, null, PLANNING_DISALLOWED_TOOLS);
  expect(planning[planning.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  const off = planning[planning.indexOf("--disallowedTools") + 1].split(",");
  for (const t of ["Edit", "Write", "NotebookEdit", "mcp__ckanban__run_schedule", "mcp__ckanban__schedule_job", "mcp__ckanban__start_huddle"]) expect(off).toContain(t);
  expect(buildArgs("u1", false, null)).not.toContain("--disallowedTools");
});

test("buildArgs turns Claude in Chrome on for work runs and planning chats", () => {
  for (const off of [[], PLANNING_DISALLOWED_TOOLS]) {
    const args = buildArgs("u1", false, null, off);
    expect(args).toContain("--chrome");
    expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
  }
});

test("permission asks: Chrome tools are allowed, other tools denied, other requests answered with an error", withMode("asks", async () => {
  const seen: any[] = [];
  const r = await startRun({ bin: FAKE, cwd: tempDir(), args: STREAM, input: "open example.com", onEvent: (e) => seen.push(e) }).done;
  expect(r.code).toBe(0);
  expect(r.events.at(-1).result).toContain("Asks: mcp__claude-in-chrome__navigate=allow Bash=deny other=error mcp__ckanban__move_ticket=deny");
  expect(seen.some((e) => e.type === "control_request")).toBe(false);
  // A Planning run (plan mode) may use the board tools; the daemon still checks each call.
  const p = await startRun({ bin: FAKE, cwd: tempDir(), args: STREAM, input: "move t_1 to done", planning: true, onEvent: () => {} }).done;
  expect(p.events.at(-1).result).toContain("Bash=deny other=error mcp__ckanban__move_ticket=allow");
}));

test("a background task keeps the run open until Claude picks its result up", withMode("background", async () => {
  const waits: (string[] | null)[] = [];
  const h = startRun({
    bin: FAKE, cwd: tempDir(), args: STREAM, input: "scan the logs", onEvent: () => {},
    onWaiting: (tasks) => waits.push(tasks && tasks.map((t) => t.description)),
  });
  const r = await h.done;
  expect(r.code).toBe(0);
  const results = r.events.filter((e) => e.type === "result");
  expect(results.length).toBe(2);
  expect(results[1].result).toContain("Background result: completed");
  expect(r.events.some((e) => e.subtype === "task_notification" && e.status === "killed")).toBe(false);
  expect(waits).toEqual([["Count timeouts"], null]);
}));

test("input still ends if Claude starts no turn after its last background task", withMode("bgsilent", async () => {
  const t0 = Date.now();
  const r = await startRun({ bin: FAKE, cwd: tempDir(), args: STREAM, input: "scan", onEvent: () => {}, graceMs: 200 }).done;
  expect(r.code).toBe(0);
  expect(r.events.filter((e) => e.type === "result").length).toBe(1);
  expect(r.events.find((e) => e.subtype === "task_notification")?.status).toBe("completed");
  expect(Date.now() - t0).toBeLessThan(5000);
}));

test("stop while waiting on a background task ends the run", withMode("background", async () => {
  process.env.FAKE_BG_MS = "30000";
  try {
    const waits: unknown[] = [];
    const h = startRun({ bin: FAKE, cwd: tempDir(), args: STREAM, input: "scan", onEvent: () => {}, onWaiting: (t) => waits.push(t) });
    while (!waits.length) await Bun.sleep(20);
    h.stop();
    await h.done;
    expect(h.stopped).toBe(true);
    expect(waits.at(-1)).toBeNull();
  } finally {
    delete process.env.FAKE_BG_MS;
  }
}), 10000);

test("idleMs (huddle monitor mode) keeps input open between turns, then ends it after the idle timeout", withMode("ok", async () => {
  const results: number[] = [];
  const t0 = Date.now();
  const h = startRun({
    bin: FAKE, cwd: tempDir(), args: ["--input-format", "stream-json", "--replay-user-messages"], input: "first", idleMs: 400,
    onEvent: (e) => { if (e.type === "result") results.push(Date.now()); },
  });
  let exited = false;
  void h.done.then(() => (exited = true));
  while (!results.length) await Bun.sleep(10);
  // Idle after its turn, but still alive: a message reaches the live session.
  await Bun.sleep(150);
  expect(exited).toBe(false);
  expect(h.send("second")).toBe(true);
  while (results.length < 2) await Bun.sleep(10);
  const r = await h.done;
  expect(r.code).toBe(0);
  expect(r.events.filter((e) => e.type === "result").map((e) => e.result.split("\n")[0])).toEqual(["Work complete.", "Reply: second"]);
  // It ended about idleMs after the last turn, not right away.
  expect(Date.now() - results[1]).toBeGreaterThanOrEqual(350);
  expect(Date.now() - t0).toBeLessThan(5000);
}), 10000);

test("without idleMs input ends as soon as Claude is idle; endWhenIdle ends a kept-open run at once", withMode("ok", async () => {
  const quick = startRun({ bin: FAKE, cwd: tempDir(), args: ["--input-format", "stream-json", "--replay-user-messages"], input: "x", onEvent: () => {} });
  const t0 = Date.now();
  await quick.done;
  expect(Date.now() - t0).toBeLessThan(3000);
  let idle = false;
  const kept = startRun({
    bin: FAKE, cwd: tempDir(), args: ["--input-format", "stream-json", "--replay-user-messages"], input: "x", idleMs: 60_000,
    onEvent: (e) => { if (e.type === "result") idle = true; },
  });
  while (!idle) await Bun.sleep(10);
  const t1 = Date.now();
  kept.endWhenIdle();
  expect((await kept.done).code).toBe(0);
  expect(Date.now() - t1).toBeLessThan(3000);
}), 10000);

test("controlResponse allows the board tools only for Planning runs; Chrome and huddle tools work for every run", () => {
  const ask = (tool: string, planning?: boolean) =>
    (controlResponse({ request_id: "r", request: { subtype: "can_use_tool", tool_name: tool, input: { id: "t_1" } } }, planning) as any).response.response.behavior;
  const board = ["move_ticket", "update_ticket", "comment_ticket", "create_ticket", "chat_ticket", "stop_ticket", "plan_control", "adopt_tickets", "suggest_tags"];
  for (const t of board) {
    expect(ask(`mcp__ckanban__${t}`, true)).toBe("allow");
    expect(ask(`mcp__ckanban__${t}`)).toBe("deny");
  }
  for (const planning of [false, true]) {
    expect(ask("mcp__ckanban__huddle_post", planning)).toBe("allow");
    expect(ask("mcp__claude-in-chrome__navigate", planning)).toBe("allow");
    // Deleting, file edits and shell commands stay blocked in plan mode.
    for (const t of ["mcp__ckanban__delete_ticket", "mcp__ckanban__run_schedule", "Edit", "Write", "Bash"]) expect(ask(t, planning)).toBe("deny");
  }
});

test("a run doesn't inherit the daemon's run identity vars (a daemon started from a run)", () => {
  const env = inheritedEnv({ PATH: "/bin", CKANBAN_TICKET: "p/t_1", CKANBAN_HUDDLE_AGENT: "h/x/tok", CKANBAN_OUTPUT_DIR: "/o", CKANBAN_PORT: "1" });
  expect(env).toEqual({ PATH: "/bin", CKANBAN_PORT: "1" });
});
