// Saving an automation or a pass must come from the user, not from something the board started. Runs send
// RUN_HEADER, but a run's shell can leave it out, and can detach a process from the daemon (double fork, setsid) so
// it no longer looks like the daemon's child. So the daemon checks who is on the other end of a local connection
// the other way round: only a web browser that the daemon didn't start may save. Anything it can't identify counts
// as not the user (fail closed), and so does a browser started to be driven by a program (headless, remote debugging).
// It keeps runs, check scripts and the board's terminal from saving by themselves; it isn't a wall against code that
// runs as the user, which could also edit the board's data folder directly.

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

/** pid -> parent pid for every process, from `ps -A -o pid=,ppid=`. */
export function parentMap(ps: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const line of ps.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid > 0 && Number.isFinite(ppid)) m.set(pid, ppid);
  }
  return m;
}

/** pid -> executable path, from `ps -A -o pid=,comm=` (macOS prints the full path). */
export function commandMap(ps: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const line of ps.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (match) m.set(Number(match[1]), match[2]);
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

/** The process that holds a browser's connections: Chrome-based browsers' helpers, Safari's WebKit networking, Firefox. */
const BROWSER = /\/(Google Chrome|Google Chrome Helper|Chromium|Chromium Helper|Brave Browser|Brave Browser Helper|Microsoft Edge|Microsoft Edge Helper|Arc|Arc Helper|Vivaldi|Vivaldi Helper|Opera|Opera Helper|Orion|Firefox|firefox|plugin-container)(\.app)?(\/|$)|com\.apple\.WebKit\.Networking/;

export function isBrowser(command: string): boolean {
  return BROWSER.test(command);
}

/** A browser started to be driven by a program, not by a person: headless, or with remote debugging or automation on. */
const DRIVEN = /\s--(headless|remote-debugging-port|remote-debugging-pipe|enable-automation|marionette|remote-allow-origins)\b/;

/** Whether pid or any process above it runs as a driven browser (its args, from `ps -A -o pid=,args=`). */
export function drivenBrowser(pid: number, parents: Map<number, number>, args: Map<number, string>): boolean {
  for (let p = pid, i = 0; p > 1 && i < 200; p = parents.get(p) ?? 0, i++) if (DRIVEN.test(` ${args.get(p) ?? ""}`)) return true;
  return false;
}

/**
 * Whether the client on `peerPort` of a local connection to the daemon is a web browser the daemon didn't start.
 * Anything else, or nothing found, is not the user.
 */
export async function fromUserBrowser(peerPort: number, daemonPid = process.pid): Promise<boolean> {
  if (!peerPort) return false;
  const pids = lsofPids(await out(["lsof", "-nP", `-iTCP:${peerPort}`, "-sTCP:ESTABLISHED", "-Fp"])).filter((p) => p !== daemonPid);
  if (!pids.length) return false;
  const [parents, commands, args] = await Promise.all([
    out(["ps", "-A", "-o", "pid=,ppid="]).then(parentMap), out(["ps", "-A", "-o", "pid=,comm="]).then(commandMap),
    out(["ps", "-A", "-o", "pid=,args="]).then(commandMap),
  ]);
  return pids.every((p) => !descendsFrom(p, daemonPid, parents) && isBrowser(commands.get(p) ?? "") && !drivenBrowser(p, parents, args));
}
