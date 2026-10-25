import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { liveSessionMatch } from "./claude";
import { run } from "./git";
import { withUtf8Locale } from "./locale";

/** Bun ≥ 1.3.5 can spawn processes on a pseudo-terminal (`Bun.spawn({ terminal })`). */
export function ptySupported(): boolean {
  return typeof (Bun as any).Terminal === "function";
}

const MAX_SCROLLBACK = 200 * 1024;

export type ShellListener = (e: { type: "data"; data: Uint8Array } | { type: "exit"; code: number | null }) => void;

/** One interactive login shell on a PTY. Output is kept (bounded) so a reconnecting client can replay it. */
export class Shell {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private listeners = new Set<ShellListener>();
  private proc: ReturnType<typeof Bun.spawn>;
  exitCode: number | null | undefined = undefined;

  /** `script` runs via `shell -l -c` (login PATH, so it works under launchd); without it the shell is interactive. */
  constructor(cwd: string, cols: number, rows: number, opts: { shell?: string; script?: string } = {}) {
    let shell = opts.shell ?? (process.env.SHELL || "/bin/zsh");
    if (!existsSync(shell)) shell = "/bin/zsh";
    // Drop markers of a parent Claude session (daemon started from one) so `claude` runs normally in this shell.
    // Same for a board run's marker, which would make `ckanban` refuse to change the board from here.
    const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CKANBAN_TICKET, ...env } = process.env;
    this.proc = Bun.spawn(opts.script ? [shell, "-l", "-c", opts.script] : [shell, "-l"], {
      cwd,
      env: { ...withUtf8Locale(env), TERM: "xterm-256color", COLORTERM: "truecolor" },
      terminal: {
        cols, rows, name: "xterm-256color",
        data: (_t, data) => this.push(data),
      },
    });
    this.proc.exited.then((code) => {
      this.exitCode = code;
      for (const l of this.listeners) l({ type: "exit", code });
    });
  }

  get exited(): boolean {
    return this.exitCode !== undefined;
  }

  get pid(): number {
    return this.proc.pid;
  }

  /** Recent output, oldest first. */
  scrollback(): Uint8Array {
    const out = new Uint8Array(this.bytes);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  private push(data: Uint8Array) {
    const copy = data.slice();
    this.chunks.push(copy);
    this.bytes += copy.length;
    while (this.bytes > MAX_SCROLLBACK && this.chunks.length > 1) this.bytes -= this.chunks.shift()!.length;
    for (const l of this.listeners) l({ type: "data", data: copy });
  }

  subscribe(l: ShellListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  write(data: string) {
    if (!this.exited) this.proc.terminal?.write(data);
  }

  resize(cols: number, rows: number) {
    if (!this.exited && cols > 0 && rows > 0) this.proc.terminal?.resize(cols, rows);
  }

  kill() {
    if (this.exited) return;
    try {
      this.proc.kill("SIGHUP");
    } catch {}
    this.proc.terminal?.close();
  }
}

/** One row of the process table. */
export interface ProcRow {
  pid: number;
  ppid: number;
  args: string;
}

export async function processTable(): Promise<ProcRow[]> {
  const r = await run(["ps", "-axo", "pid=,ppid=,args="], homedir());
  if (r.code !== 0) return [];
  return r.stdout.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }] : [];
  });
}

/** The claude process with this session open that runs under one of `roots` (itself or a descendant), if any. */
export function sessionProcessUnder(rows: ProcRow[], roots: number[], sessionId: string): ProcRow | null {
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const under = (pid: number) => {
    for (let p: number | undefined = pid, hops = 0; p && hops < 64; p = parent.get(p), hops++) if (roots.includes(p)) return true;
    return false;
  };
  return rows.find((r) => liveSessionMatch([r.args], { id: sessionId, title: null }) && under(r.pid)) ?? null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until `pid` is gone; false after `ms`. */
async function exitedWithin(pid: number, ms: number, isAlive: (pid: number) => boolean): Promise<boolean> {
  const until = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() >= until) return false;
    await Bun.sleep(100);
  }
  return true;
}

/** A ticket's Claude session open in one of the board's own PTYs (the dock terminal). */
export interface OwnedSession {
  pid: number;
  /** Ends it gracefully (/exit), then by signal after a timeout. True once the process is gone. */
  close(): Promise<boolean>;
}

export interface CloseOptions {
  /** How long /exit gets before SIGTERM (and SIGTERM before SIGKILL). */
  graceMs?: number;
  isAlive?: (pid: number) => boolean;
  signal?: (pid: number, sig: NodeJS.Signals) => void;
}

/** Types /exit into Claude's prompt in the PTY, then signals the process if it is still there. */
export async function closeSession(shell: Pick<Shell, "write">, pid: number, o: CloseOptions = {}): Promise<boolean> {
  const grace = o.graceMs ?? 5000;
  const isAlive = o.isAlive ?? alive;
  const signal = o.signal ?? ((p, sig) => process.kill(p, sig));
  // Ctrl+U clears anything typed in Claude's prompt; Enter goes separately so it isn't taken as part of a paste.
  shell.write("\x15/exit");
  await Bun.sleep(150);
  shell.write("\r");
  if (await exitedWithin(pid, grace, isAlive)) return true;
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    try {
      signal(pid, sig);
    } catch {}
    if (await exitedWithin(pid, sig === "SIGTERM" ? grace : 1000, isAlive)) return true;
  }
  return false;
}

export interface SpawnRequest {
  cwd: string;
  cols: number;
  rows: number;
}

export function defaultSpawn() {
  return (r: SpawnRequest): Shell => new Shell(r.cwd, r.cols, r.rows);
}

/** One shell per profile, kept alive across page reloads until restarted, the profile is deleted or the daemon stops. */
export class ShellManager {
  private shells = new Map<string, Shell>();

  constructor(private spawn: (r: SpawnRequest) => Shell = defaultSpawn()) {}

  /** The profile's shell, starting one if there is none. `restart` replaces the current one. */
  get(slug: string, cwd: string, cols = 80, rows = 24, restart = false): Shell {
    let s = this.shells.get(slug);
    if (s && restart) {
      s.kill();
      s = undefined;
    }
    if (!s) {
      s = this.spawn({ cwd, cols, rows });
      this.shells.set(slug, s);
    }
    return s;
  }

  current(slug: string): Shell | undefined {
    return this.shells.get(slug);
  }

  /** Stops the profile's shell. */
  kill(slug: string) {
    this.shells.get(slug)?.kill();
    this.shells.delete(slug);
  }

  /** A Claude session running in one of the board's PTYs (e.g. `claude --resume <id>` typed into the dock shell). */
  async findSession(sessionId: string, procs: () => Promise<ProcRow[]> = processTable): Promise<OwnedSession | null> {
    const live = [...this.shells.values()].filter((s) => !s.exited);
    if (!live.length) return null;
    const rows = await procs();
    for (const s of live) {
      const p = sessionProcessUnder(rows, [s.pid], sessionId);
      if (p) return { pid: p.pid, close: () => closeSession(s, p.pid) };
    }
    return null;
  }

  killAll() {
    for (const s of this.shells.values()) s.kill();
    this.shells.clear();
  }
}
