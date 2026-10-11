import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ERRORS, extractReadHtml, findOutcome, helperCommand, helperEnv, jobPrompts, paneState, runArtifactJob, screenText, tmuxArgs } from "../src/server/artifact";
import { ptySupported } from "../src/server/shell";

const L = (o: unknown) => JSON.stringify(o);
const use = (id: string, input: object, name = "Artifact") =>
  L({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: unknown, extra: object = {}) =>
  L({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] }, ...extra });

const URL = "https://claude.ai/artifact/NJd6w5oY733D1GdTJsrhHB";
const SHELL = `<!doctype html><html><head><meta charset=utf8><style>body{margin:0}</style></head><body>\n`;
const READ = `[Artifact ac85 (version 1) — owned by you; raw HTML follows]
The artifact HTML inside the <cowritten-artifact-html> tag below was not published from this session:
<cowritten-artifact-html>
${SHELL}<title>Page</title>
<h1>Hi</h1>

</body></html>
</cowritten-artifact-html>

IMPORTANT: The artifact HTML inside the <cowritten-artifact-html> tag above was not published from this session.`;

test("helperEnv drops the SDK markers and stops the browser opening", () => {
  const env = helperEnv({ PATH: "/bin", CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "s", HOME: "/h", GONE: undefined });
  expect(env).toEqual({ PATH: "/bin", HOME: "/h", CLAUDE_CODE_ARTIFACT_AUTO_OPEN: "0" });
});

test("tmuxArgs unsets the markers inside the pane too", () => {
  const a = tmuxArgs({ name: "ckanban-artifact-x", cwd: "/w", bin: "claude", sessionId: "sid", model: "haiku", prompt: "go" });
  expect(a.slice(0, 5)).toEqual(["tmux", "new-session", "-d", "-s", "ckanban-artifact-x"]);
  expect(a.slice(a.indexOf("-c"), a.indexOf("-c") + 2)).toEqual(["-c", "/w"]);
  const env = a.indexOf("env");
  expect(a.slice(env, env + 5)).toEqual(["env", "-u", "CLAUDE_CODE_ENTRYPOINT", "-u", "CLAUDECODE"]);
  expect(a.slice(env, a.indexOf("CLAUDE_CODE_ARTIFACT_AUTO_OPEN=0"))).toContain("CLAUDE_CODE_CHILD_SESSION");
  expect(a).toContain("bypassPermissions");
  expect(a.slice(-3)).toEqual(["--session-id", "sid", "go"]);
});

test("jobPrompts: new publish is one turn, republish reads first", () => {
  expect(jobPrompts({ kind: "read", url: URL })).toHaveLength(1);
  const fresh = jobPrompts({ kind: "publish", file: "/o/p.html", title: "My page" });
  expect(fresh).toHaveLength(1);
  expect(fresh[0]).toContain("/o/p.html");
  expect(fresh[0]).toContain('"My page"');
  const again = jobPrompts({ kind: "publish", file: "/o/p.html", url: URL });
  expect(again).toHaveLength(2);
  expect(again[0]).toContain('action "read"');
  expect(again[1]).toContain(`passing url ${URL}`);
  // Typed into the terminal, where a newline would submit early.
  for (const p of [...fresh, ...again]) expect(p).not.toContain("\n");
});

test("helperCommand points at the CLI", () => {
  expect(helperCommand()).toContain("cli.ts");
});

test("extractReadHtml strips the viewer shell and ignores tag mentions in prose", () => {
  expect(extractReadHtml(READ)).toBe("<title>Page</title>\n<h1>Hi</h1>\n");
  expect(extractReadHtml("no page here")).toBeNull();
});

test("findOutcome: publish result, skipping quickstart and reads", () => {
  const raw = [
    use("q", { action: "quickstart", intent: "other" }),
    result("q", "Quickstart for a page."),
    use("r", { action: "read", url: URL }),
    result("r", READ),
    use("p", { file_path: "/o/p.html", url: URL }),
    L({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "p", content: `Published /o/p.html at ${URL} (Version 3, version id 1)` }] },
      toolUseResult: { url: URL },
    }),
  ].join("\n");
  expect(findOutcome(raw, "publish")).toEqual({ ok: true, kind: "publish", url: URL, text: `Published /o/p.html at ${URL}` });
  expect(findOutcome(raw, "read")).toEqual({ ok: true, kind: "read", html: "<title>Page</title>\n<h1>Hi</h1>\n" });
});

test("findOutcome: still working, refused, and tool missing", () => {
  expect(findOutcome(use("p", { file_path: "/o/p.html" }), "publish")).toBeNull();
  expect(findOutcome("garbage\n", "publish")).toBeNull();

  const refused = [use("p", { file_path: "/o/p.html", url: URL }), result("p", "You hadn't viewed the live version of this artifact, so the publish was refused.")].join("\n");
  expect(findOutcome(refused, "publish")).toEqual({ ok: false, error: "You hadn't viewed the live version of this artifact, so the publish was refused." });

  const missing = [use("p", { file_path: "/o/p.html" }), result("p", "<tool_use_error>Error: No such tool available: Artifact</tool_use_error>", { is_error: true })].join("\n");
  const r = findOutcome(missing, "publish");
  expect(r?.ok).toBe(false);
  expect(!r?.ok && r?.error).toBe(ERRORS.noArtifactTool);

  const errored = [use("p", { file_path: "/o/p.html" }), result("p", "<tool_use_error>file too big</tool_use_error>", { is_error: true })].join("\n");
  expect(findOutcome(errored, "publish")).toEqual({ ok: false, error: "file too big" });
});

test("paneState spots the prompts that would block the helper", () => {
  expect(paneState("Quick safety check\n ❯ No, exit\n   Yes, I trust this folder")).toBe("trust");
  expect(paneState("WARNING: Claude Code running in Bypass Permissions mode\n ❯ No, exit\n   Yes, I accept")).toBe("bypass");
  expect(paneState("⏺ Artifact(read ...)")).toBeNull();
  expect(paneState("Select login method")).toBe("login");
  expect(paneState('❯ Publish ... Use the title "Invalid API key handling".', ['Use the title "Invalid API key handling".'])).toBeNull();
});

// --- runArtifactJob on the built-in terminal, with a fake `claude` ---

const FAKE_CLAUDE = `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const sid = args[args.indexOf("--session-id") + 1];
const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "fake");
mkdirSync(dir, { recursive: true });
const file = join(dir, sid + ".jsonl");
const line = (o) => appendFileSync(file, JSON.stringify(o) + "\\n");
const use = (id, input) => line({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Artifact", input }] } });
const result = (id, content) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
const mode = process.env.FAKE_MODE;
if (process.env.FAKE_PID) writeFileSync(process.env.FAKE_PID, String(process.pid));
if (mode === "publish" || mode === "republish") {
  if (mode === "republish") {
    use("r", { action: "read", url: "${URL}" });
    result("r", ${JSON.stringify(READ)});
    for await (const typed of console) {
      if (typed.includes("Now publish")) break;
    }
  }
  use("p", { file_path: "/o/p.html" });
  result("p", "Published /o/p.html at https://claude.ai/artifact/abc (Version 1)");
} else if (mode === "login") {
  console.log("Not logged in · Please run /login");
} else if (mode === "echo") {
  // Like Claude's input box: the prompt, title and all, is on screen while it works.
  console.log("❯ " + args[args.length - 1]);
  await Bun.sleep(300);
  use("p", { file_path: "/o/p.html" });
  result("p", "Published /o/p.html at https://claude.ai/artifact/abc (Version 1)");
} else if (mode === "exit") {
  process.exit(0);
}
await Bun.sleep(60_000);
`;

function fixture(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "ck-artifact-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  // A tmux that only leaves a mark, to prove the built-in terminal never calls it.
  const spy = join(dir, "bin");
  mkdirSync(spy);
  writeFileSync(join(spy, "tmux"), `#!/bin/sh\ntouch ${join(dir, "tmux-called")}\n`);
  chmodSync(join(spy, "tmux"), 0o755);
  const env = { ...process.env, PATH: `${spy}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: join(dir, "config"), FAKE_MODE: mode, FAKE_PID: join(dir, "pid") };
  const opts = { bin, cwd: join(dir, "helper"), env, pollMs: 50, timeoutMs: 10_000 };
  const pid = () => Number(readFileSync(join(dir, "pid"), "utf8"));
  const tmuxCalled = () => existsSync(join(dir, "tmux-called"));
  return { dir, opts, pid, tmuxCalled };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number) {
  for (let i = 0; i < 60 && alive(pid); i++) await Bun.sleep(50);
  return !alive(pid);
}

test.skipIf(!ptySupported())("runArtifactJob publishes on the built-in terminal, without tmux, and stops Claude after", async () => {
  const f = fixture("publish");
  const r = await runArtifactJob({ kind: "publish", file: "/o/p.html" }, f.opts);
  expect(r).toEqual({ ok: true, kind: "publish", url: "https://claude.ai/artifact/abc", text: "Published /o/p.html at https://claude.ai/artifact/abc" });
  expect(f.tmuxCalled()).toBe(false);
  expect(await gone(f.pid())).toBe(true);
});

test.skipIf(!ptySupported())("runArtifactJob types the second turn of a republish into the terminal", async () => {
  const f = fixture("republish");
  const r = await runArtifactJob({ kind: "publish", file: "/o/p.html", url: URL }, f.opts);
  expect(r.ok && r.kind === "publish" && r.url).toBe("https://claude.ai/artifact/abc");
  expect(f.tmuxCalled()).toBe(false);
});

test.skipIf(!ptySupported())("runArtifactJob kills Claude when it times out", async () => {
  const f = fixture("hang");
  const r = await runArtifactJob({ kind: "publish", file: "/o/p.html" }, { ...f.opts, timeoutMs: 800 });
  expect(r.ok).toBe(false);
  expect(!r.ok && r.error).toContain("took too long");
  expect(await gone(f.pid())).toBe(true);
});

test.skipIf(!ptySupported())("runArtifactJob explains login and early exits in plain words", async () => {
  const login = await runArtifactJob({ kind: "publish", file: "/o/p.html" }, fixture("login").opts);
  expect(login).toEqual({ ok: false, error: ERRORS.login });
  const exited = await runArtifactJob({ kind: "publish", file: "/o/p.html" }, fixture("exit").opts);
  expect(exited).toEqual({ ok: false, error: ERRORS.exited });
  const missing = await runArtifactJob({ kind: "publish", file: "/o/p.html" }, { ...fixture("publish").opts, bin: "/nonexistent/claude" });
  expect(missing).toEqual({ ok: false, error: ERRORS.notInstalled });
  for (const e of [login, exited, missing]) expect(!e.ok && e.error).not.toMatch(/tmux|brew/);
});

test.skipIf(!ptySupported())("runArtifactJob isn't fooled by a login phrase in the title it typed", async () => {
  const r = await runArtifactJob({ kind: "publish", file: "/o/p.html", title: "Fix: Not logged in banner" }, fixture("echo").opts);
  expect(r.ok && r.kind === "publish" && r.url).toBe("https://claude.ai/artifact/abc");
});

test("runArtifactJob without a built-in terminal or tmux asks for an update, not for tmux", async () => {
  const f = fixture("publish");
  const r = await runArtifactJob({ kind: "publish", file: "/o/p.html" }, { ...f.opts, pty: false, env: { ...f.opts.env, PATH: "/nonexistent" } });
  expect(r).toEqual({ ok: false, error: "Publishing needs a newer ckanban runtime. Update ckanban." });
});

test("screenText drops escape codes and keeps spacing", () => {
  expect(screenText("\x1b[1mYes,\x1b[1CI trust\x1b[0m this folder\x1b]0;title\x07")).toBe("Yes, I trust this folder");
  expect(paneState(screenText("\x1b[2J\x1b[31mPlease run /login\x1b[0m"))).toBe("login");
});
