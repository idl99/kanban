// Saving an automation or a pass must come from the user, not from something the board started. Runs send
// RUN_HEADER, but a run's shell can leave it out. So the daemon also looks at who is on the other end of the
// connection: a local request from a process the daemon started (a run, a huddle agent, a check script, the board's
// terminal) is refused. The browser, and ckanban in the user's own terminal, are not the daemon's children.

/** Runs a command and returns its stdout; "" when it fails. */
async function out(argv: string[]): Promise<string> {
  try {
    const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [text] = await Promise.all([new Response(p.stdout as ReadableStream).text(), p.exited]);
    return text;
  } catch {
    return "";
  }
}

/** pid -> parent pid for every process, from `ps`. */
export function parentMap(ps: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const line of ps.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid > 0 && Number.isFinite(ppid)) m.set(pid, ppid);
  }
  return m;
}

/** Whether `pid` is `ancestor` or one of its descendants. */
export function descendsFrom(pid: number, ancestor: number, parents: Map<number, number>): boolean {
  for (let p = pid, i = 0; p > 1 && i < 200; p = parents.get(p) ?? 0, i++) if (p === ancestor) return true;
  return false;
}

/** Pids with a TCP socket on this local port (lsof -F output: lines "p<pid>"). */
export function lsofPids(text: string): number[] {
  return text.split("\n").filter((l) => l.startsWith("p")).map((l) => Number(l.slice(1))).filter((n) => n > 0);
}

/**
 * Whether the client on `peerPort` of a local connection to the daemon is a process the daemon started. Unknown
 * (no lsof, no match) counts as not started by the board.
 */
export async function fromBoardProcess(peerPort: number, daemonPid = process.pid): Promise<boolean> {
  if (!peerPort) return false;
  const pids = lsofPids(await out(["lsof", "-nP", `-iTCP:${peerPort}`, "-sTCP:ESTABLISHED", "-Fp"])).filter((p) => p !== daemonPid);
  if (!pids.length) return false;
  const parents = parentMap(await out(["ps", "-A", "-o", "pid=,ppid="]));
  return pids.some((p) => descendsFrom(p, daemonPid, parents));
}
