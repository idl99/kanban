// Phone access over Tailscale: `tailscale serve` proxies https://<this Mac>.<tailnet>.ts.net to the daemon on
// 127.0.0.1, and the daemon accepts that host only with the owner's Tailscale login (see allowedRemote).
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import qrcode from "qrcode-generator";

export interface RemoteConfig {
  enabled: boolean;
  /** MagicDNS name, e.g. leos-mbp.tail1234.ts.net (no trailing dot). */
  host: string;
  /** Tailscale login allowed in (Tailscale-User-Login header set by `tailscale serve`). */
  allowedLogin: string;
  updatedAt: string;
}

export interface RemoteStatus {
  enabled: boolean;
  url: string | null;
  host: string | null;
  allowedLogin: string | null;
  /** Last request from the tailnet host (since the daemon started). */
  lastVisit: string | null;
  /** `off` disabled access but couldn't remove the serve mapping. */
  warning?: string;
}

/** Header on every answer of the daemon's phone access listener, so `on` never points serve at some other program. */
export const LISTENER_HEADER = "x-ckanban-listener";

/** True when the daemon's phone access listener answers on this loopback port. */
export async function isPhoneListener(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/remote`, { signal: AbortSignal.timeout(3000) });
    return r.headers.get(LISTENER_HEADER) === "remote";
  } catch {
    return false;
  }
}

export type TailscaleRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export class RemoteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Header `tailscale serve` adds with the visitor's login (it strips any copy the client sent). */
export const LOGIN_HEADER = "tailscale-user-login";
const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const HINT = "Install Tailscale (https://tailscale.com/download) and sign in, then try again.";

/** The `tailscale` CLI: the app's own binary (the Homebrew/PATH `tailscale` is often a shell wrapper around it), else PATH. */
export function tailscaleBin(): string | null {
  return existsSync(APP_CLI) ? APP_CLI : Bun.which("tailscale");
}

/** `tailscale serve` prints this and then waits for the user when Serve or HTTPS isn't enabled on the tailnet yet. */
const ENABLE_LINK = /To enable, visit:\s*(https:\/\/\S+)/;
const RUN_TIMEOUT_MS = 30_000;

export const defaultRunner: TailscaleRunner = async (args) => {
  const bin = tailscaleBin();
  if (!bin) throw new RemoteError(424, `tailscale CLI not found. ${HINT}`);
  // Own process group, so a timeout also ends a wrapper script's child.
  const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true });
  let stdout = "", stderr = "";
  let stop: (r: { code: number; stdout: string; stderr: string }) => void = () => {};
  const stopped = new Promise<{ code: number; stdout: string; stderr: string }>((r) => (stop = r));
  const end = (code: number) => {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {}
    stop({ code, stdout, stderr });
  };
  const read = async (stream: ReadableStream<Uint8Array>, add: (t: string) => void) => {
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      add(dec.decode(chunk, { stream: true }));
      if (ENABLE_LINK.test(stdout + stderr)) end(1);
    }
  };
  const timer = setTimeout(() => {
    stderr += `\n(gave up after ${RUN_TIMEOUT_MS / 1000}s)`;
    end(124);
  }, RUN_TIMEOUT_MS);
  const done = Promise.all([read(p.stdout, (t) => (stdout += t)), read(p.stderr, (t) => (stderr += t)), p.exited])
    .then(([, , code]) => ({ code, stdout, stderr }));
  const r = await Promise.race([done, stopped]);
  clearTimeout(timer);
  return r;
};

/** The daemon's phone access listener: CKANBAN_REMOTE_PORT, config.json remotePort, else the board port + 1. */
export function remoteListenPort(boardPort: number, configured?: number): number {
  return Number(process.env.CKANBAN_REMOTE_PORT) || configured || boardPort + 1;
}

export function remoteUrl(host: string): string {
  return `https://${host}`;
}

/** QR code of a URL, as an SVG tag (UI) or block characters (terminal). */
export function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export function qrTerminal(text: string): string {
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  // Two module rows per text line (▀ ▄ █), with a 2-module quiet zone; light-on-dark terminals invert, so draw light modules.
  const lines: string[] = [];
  for (let r = -2; r < n + 2; r += 2) {
    let line = "";
    for (let c = -2; c < n + 2; c++) {
      const top = !dark(r, c), bottom = !dark(r + 1, c);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Remote access settings in `<root>/remote.json`, shared by the CLI and the daemon (re-read when the file changes). */
export class RemoteAccess {
  private cache: { mtime: number; config: RemoteConfig | null } | null = null;
  private lastVisit: string | null = null;

  constructor(private root: string, private port: () => number, private run: TailscaleRunner = defaultRunner,
    private probe: (port: number) => Promise<boolean> = isPhoneListener) {}

  private get file() {
    return join(this.root, "remote.json");
  }

  /** Current settings; null when never set up or the file is unreadable. Cheap: stats the file per call. */
  config(): RemoteConfig | null {
    let mtime: number;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      this.cache = null;
      return null;
    }
    if (this.cache?.mtime === mtime) return this.cache.config;
    let config: RemoteConfig | null = null;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (raw && typeof raw.host === "string" && typeof raw.allowedLogin === "string") {
        config = { enabled: raw.enabled === true, host: raw.host, allowedLogin: raw.allowedLogin, updatedAt: String(raw.updatedAt ?? "") };
      }
    } catch {}
    this.cache = { mtime, config };
    return config;
  }

  /** Enabled settings, for the request check. */
  active(): RemoteConfig | null {
    const c = this.config();
    return c?.enabled && c.host && c.allowedLogin ? c : null;
  }

  noteVisit(at: string) {
    this.lastVisit = at;
  }

  status(): RemoteStatus {
    const c = this.config();
    const on = !!this.active();
    return {
      enabled: on,
      url: c?.host ? remoteUrl(c.host) : null,
      host: c?.host ?? null,
      allowedLogin: c?.allowedLogin ?? null,
      lastVisit: on ? this.lastVisit : null,
    };
  }

  private write(config: RemoteConfig) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmp, this.file);
    this.cache = null;
  }

  private async tailscale(args: string[]) {
    const r = await this.run(args);
    if (r.code !== 0) {
      const link = (r.stdout + r.stderr).match(ENABLE_LINK)?.[1];
      if (link) throw new RemoteError(424, `Tailscale Serve isn't enabled on your tailnet yet. Enable it at ${link} and try again.`);
      const msg = (r.stderr || r.stdout).trim().split("\n").slice(0, 6).join("\n");
      throw new RemoteError(502, `tailscale ${args[0]} failed${msg ? `: ${msg}` : ""}`);
    }
    return r.stdout;
  }

  /** This Mac's MagicDNS name and the signed-in user's login, from `tailscale status --json`. */
  async identity(): Promise<{ host: string; login: string }> {
    let s: any;
    try {
      s = JSON.parse(await this.tailscale(["status", "--json"]));
    } catch (e) {
      if (e instanceof RemoteError) throw e;
      throw new RemoteError(502, "could not read `tailscale status --json`");
    }
    if (s?.BackendState !== "Running") {
      throw new RemoteError(424, `Tailscale is not connected (state: ${s?.BackendState ?? "unknown"}). ${HINT}`);
    }
    const host = String(s?.Self?.DNSName ?? "").replace(/\.$/, "");
    const login = String(s?.User?.[String(s?.Self?.UserID)]?.LoginName ?? "");
    if (!host) throw new RemoteError(424, "this Mac has no MagicDNS name: turn on MagicDNS in the Tailscale admin console (DNS page).");
    if (!login) throw new RemoteError(424, "could not find the signed-in Tailscale user (tagged devices are not supported).");
    return { host, login };
  }

  /** Point `tailscale serve` (HTTPS 443, tailnet only) at the daemon and let the signed-in user in. */
  async on(): Promise<RemoteStatus> {
    const { host, login } = await this.identity();
    const port = this.port();
    if (!port || !(await this.probe(port))) {
      throw new RemoteError(409, `the daemon's phone access listener isn't on 127.0.0.1:${port || "?"}: restart the daemon ` +
        "(`ckanban restart`) and try again; if the port is taken, set remotePort in ~/.claude-kanban/config.json");
    }
    await this.tailscale(["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
    this.write({ enabled: true, host, allowedLogin: login, updatedAt: new Date().toISOString() });
    return this.status();
  }

  /** Remove the serve mapping and refuse the tailnet host again. Settings are kept (disabled) for the next `on`. */
  async off(): Promise<RemoteStatus> {
    const c = this.config();
    // Disable first: even if tailscale fails below, the daemon stops letting the tailnet in.
    if (c) this.write({ ...c, enabled: false, updatedAt: new Date().toISOString() });
    else rmSync(this.file, { force: true });
    try {
      await this.tailscale(["serve", "--https=443", "off"]);
    } catch (e) {
      if (!(e instanceof RemoteError)) throw e;
      return { ...this.status(), warning: e.message };
    }
    return this.status();
  }
}
