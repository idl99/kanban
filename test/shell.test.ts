import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSession, sessionProcessUnder, Shell, ShellManager, type ProcRow, type SpawnRequest } from "../src/server/shell";

class FakeShell {
  killed = false;
  exited = false;
  constructor(public req: SpawnRequest) {}
  kill() {
    this.killed = true;
  }
}

function manager() {
  const spawned: FakeShell[] = [];
  const m = new ShellManager((r) => {
    const s = new FakeShell(r);
    spawned.push(s);
    return s as unknown as Shell;
  });
  return { m, spawned };
}

test("a profile keeps one shell until it is restarted or killed", () => {
  const { m, spawned } = manager();
  const shell = m.get("p", "/w");
  expect(m.get("p", "/w")).toBe(shell);
  expect(m.current("p")).toBe(shell);
  const other = m.get("q", "/v");
  const next = m.get("p", "/w", 80, 24, true);
  expect((shell as unknown as FakeShell).killed).toBe(true);
  expect(next).not.toBe(shell);
  expect(spawned.map((s) => s.req.cwd)).toEqual(["/w", "/v", "/w"]);
  m.kill("p");
  expect(m.current("p")).toBeUndefined();
  expect(m.current("q")).toBe(other);
  m.killAll();
  expect((other as unknown as FakeShell).killed).toBe(true);
  expect(m.current("q")).toBeUndefined();
});

test("sessionProcessUnder finds the claude process with the session inside the board's PTY only", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const rows: ProcRow[] = [
    { pid: 100, ppid: 1, args: "/bin/zsh -l" },
    { pid: 101, ppid: 100, args: `claude --resume ${id}` },
    { pid: 200, ppid: 1, args: "/bin/zsh -l" },
    { pid: 201, ppid: 200, args: `node /x/claude-code/cli.js --resume ${id}` },
  ];
  expect(sessionProcessUnder(rows, [100], id)?.pid).toBe(101);
  expect(sessionProcessUnder(rows, [200], id)?.pid).toBe(201);
  expect(sessionProcessUnder(rows, [300], id)).toBeNull();
  expect(sessionProcessUnder(rows, [100], "other")).toBeNull();
});

test("closeSession types /exit, and signals only when Claude doesn't leave in time", async () => {
  const typed: string[] = [];
  let alive = true;
  const shell = { write: (d: string) => { typed.push(d); if (d === "\r") alive = false; } };
  const signals: string[] = [];
  expect(await closeSession(shell, 42, { graceMs: 300, isAlive: () => alive, signal: (_p, s) => signals.push(s) })).toBe(true);
  expect(typed.join("")).toBe("\x15/exit\r");
  expect(signals).toEqual([]);

  // Ignores /exit: SIGTERM, then SIGKILL.
  let left = 2;
  const stubborn = await closeSession({ write: () => {} }, 42, { graceMs: 150, isAlive: () => left > 0, signal: (_p, s) => { signals.push(s); if (s === "SIGKILL") left = 0; } });
  expect(stubborn).toBe(true);
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test.skipIf(typeof (Bun as any).Terminal !== "function")("findSession finds a session typed into the dock shell and closes it with /exit", async () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const cli = join(import.meta.dir, "fixtures", "fake-tui", "claude-code", "cli.js");
  const shells = new ShellManager((r) => new Shell(r.cwd, r.cols, r.rows, { shell: "/bin/sh", script: `${process.execPath} ${cli} --resume ${id}` }));
  const s = shells.get("p", tmpdir());
  let out = "";
  s.subscribe((e) => { if (e.type === "data") out += new TextDecoder().decode(e.data); });
  for (let i = 0; i < 50 && !out.includes("ready"); i++) await Bun.sleep(100);
  expect(await shells.findSession("other-session")).toBeNull();
  const owned = await shells.findSession(id);
  expect(owned).not.toBeNull();
  expect(await owned!.close()).toBe(true);
  for (let i = 0; i < 20 && !s.exited; i++) await Bun.sleep(50);
  expect(s.exited).toBe(true);
  shells.killAll();
}, 15000);
