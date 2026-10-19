// Keep the Mac awake while Claude works. macOS sleeps an idle Mac even with runs going, and every session on the
// board then freezes until someone touches the keyboard. While there is active work on a board with "Keep this Mac
// awake" on, the daemon holds a `caffeinate -i` child (idle sleep only; the display may still turn off) and kills it
// once the work is done. `-w <daemon pid>` makes caffeinate exit by itself if the daemon dies, even on kill -9.

/** How often the daemon checks whether there is active work (the hold follows within this long). */
export const AWAKE_CHECK_MS = 2000;

export interface Hold {
  kill(): void;
  /** Resolves when the process exits (killed, or gone on its own). */
  exited: Promise<unknown>;
}

export interface StayAwakeOptions {
  /** Active work wants the Mac awake now. */
  wanted: () => boolean;
  /** The hold started or ended. */
  onChange?: (held: boolean) => void;
  platform?: string;
  pid?: number;
  spawn?: (argv: string[]) => Hold;
  intervalMs?: number;
}

export function caffeinateArgv(pid: number): string[] {
  return ["caffeinate", "-i", "-w", String(pid)];
}

function spawnHold(argv: string[]): Hold {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return { kill: () => p.kill(), exited: p.exited };
}

export class StayAwake {
  private hold: Hold | null = null;
  /** caffeinate could not start: don't try again on every check. */
  private broken = false;
  private readonly platform: string;
  private readonly pid: number;
  private readonly spawn: (argv: string[]) => Hold;

  constructor(private o: StayAwakeOptions) {
    this.platform = o.platform ?? process.platform;
    this.pid = o.pid ?? process.pid;
    this.spawn = o.spawn ?? spawnHold;
  }

  held(): boolean {
    return this.hold !== null;
  }

  /** Start or end the hold to match the work going on now. */
  check(): void {
    if (this.platform !== "darwin" || this.broken) return;
    const want = this.o.wanted();
    if (want && !this.hold) this.acquire();
    else if (!want && this.hold) this.release();
  }

  private acquire(): void {
    let hold: Hold;
    try {
      hold = this.spawn(caffeinateArgv(this.pid));
    } catch (e) {
      this.broken = true;
      console.log(`keep awake: could not start caffeinate (${(e as Error).message}); the Mac may sleep during runs`);
      return;
    }
    this.hold = hold;
    // Gone on its own (killed from outside): the next check starts a new one if work still wants it.
    void hold.exited.then(() => {
      if (this.hold !== hold) return;
      this.hold = null;
      this.o.onChange?.(false);
    });
    this.o.onChange?.(true);
  }

  private release(): void {
    const hold = this.hold;
    this.hold = null;
    hold?.kill();
    this.o.onChange?.(false);
  }

  /** Check every intervalMs; the returned function stops checking and ends the hold. */
  start(): () => void {
    this.check();
    const timer = setInterval(() => this.check(), this.o.intervalMs ?? AWAKE_CHECK_MS);
    return () => {
      clearInterval(timer);
      if (this.hold) this.release();
    };
  }
}
