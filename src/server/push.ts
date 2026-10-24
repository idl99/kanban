// Phone push (notify.ts): devices that turned notifications on in the board (NotificationsDialog), kept in
// `<root>/push.json` with the board's VAPID keys, and the sending side (webpush.ts). A device whose board is on screen
// right now (visibility heartbeat from the page) is skipped: the user already sees it.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "./util";
import { deviceId, generateVapidKeys, pushRequest, type PushTarget, type VapidKeys } from "./webpush";

export interface PushDevice extends PushTarget {
  id: string;
  /** e.g. "iPhone · Safari (Home Screen)". */
  label: string;
  createdAt: string;
  /** Turned on in a browser on this Mac (the board's localhost address): its notifications replace the macOS banner. */
  thisMac?: boolean;
}

interface PushFile {
  vapid: VapidKeys;
  devices: PushDevice[];
}

/** What the page sends in a notification. The service worker shows title/body and opens url's ticket on tap. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export interface PushResult {
  sent: number;
  /** Devices dropped because their push service said they're gone (404/410). */
  removed: number;
  /** Devices skipped because the board is on screen there. */
  onScreen: number;
  error: string | null;
}

/** How long a "board on screen" heartbeat counts; the page sends one every 15 s while visible. */
export const VISIBLE_MS = 40_000;

export class PushService {
  private visibleUntil = new Map<string, number>();
  private fetch: (url: string, init: RequestInit) => Promise<Response>;
  private now: () => number;

  constructor(private root: string, o: { fetch?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number } = {}) {
    this.fetch = o.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }));
    this.now = o.now ?? Date.now;
  }

  private get file() {
    return join(this.root, "push.json");
  }

  private read(): PushFile {
    if (existsSync(this.file)) {
      try {
        const f = JSON.parse(readFileSync(this.file, "utf8"));
        if (f?.vapid?.publicKey && f?.vapid?.privateKey) return { vapid: f.vapid, devices: Array.isArray(f.devices) ? f.devices : [] };
      } catch {}
    }
    const fresh = { vapid: generateVapidKeys(), devices: [] };
    this.write(fresh);
    return fresh;
  }

  /** Private key inside: owner-only. */
  private write(f: PushFile) {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(f, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  publicKey(): string {
    return this.read().vapid.publicKey;
  }

  devices(): { id: string; label: string; createdAt: string }[] {
    return this.read().devices.map(({ id, label, createdAt }) => ({ id, label, createdAt }));
  }

  /** Whether a browser on this Mac gets notifications (they open the ticket when clicked, unlike the macOS banner). */
  hasThisMac(): boolean {
    return this.read().devices.some((d) => d.thisMac);
  }

  /** Add (or refresh) a device. Throws on input that isn't a browser push subscription. */
  subscribe(raw: any, label: unknown, thisMac = false): PushDevice {
    const endpoint = typeof raw?.endpoint === "string" ? raw.endpoint : "";
    let u: URL;
    try {
      u = new URL(endpoint);
    } catch {
      throw new Error("endpoint is not a valid URL");
    }
    if (u.protocol !== "https:") throw new Error("endpoint must be https");
    const p256dh = raw?.keys?.p256dh, auth = raw?.keys?.auth;
    if (typeof p256dh !== "string" || typeof auth !== "string" || !/^[\w-]+=*$/.test(p256dh) || !/^[\w-]+=*$/.test(auth)) {
      throw new Error("keys.p256dh and keys.auth are required");
    }
    const f = this.read();
    const id = deviceId(endpoint);
    const device: PushDevice = {
      id, endpoint, keys: { p256dh, auth },
      label: typeof label === "string" && label.trim() ? label.trim().slice(0, 80) : "Browser",
      createdAt: f.devices.find((d) => d.id === id)?.createdAt ?? nowIso(),
      ...(thisMac ? { thisMac: true } : {}),
    };
    f.devices = [...f.devices.filter((d) => d.id !== id), device];
    this.write(f);
    return device;
  }

  /** Remove by device id or endpoint; true when one was there. */
  remove(idOrEndpoint: string): boolean {
    const f = this.read();
    const kept = f.devices.filter((d) => d.id !== idOrEndpoint && d.endpoint !== idOrEndpoint);
    if (kept.length === f.devices.length) return false;
    f.devices = kept;
    this.write(f);
    this.visibleUntil.delete(idOrEndpoint);
    return true;
  }

  /** A known device was seen in a browser on this Mac (devices turned on before `thisMac` existed); true when it changed. */
  markThisMac(endpoint: string): boolean {
    const f = this.read();
    const d = f.devices.find((x) => x.endpoint === endpoint);
    if (!d || d.thisMac) return false;
    d.thisMac = true;
    this.write(f);
    return true;
  }

  /** The page's heartbeat: its board is on screen (or not anymore). */
  setVisible(endpoint: string, visible: boolean): void {
    const id = deviceId(endpoint);
    if (visible) this.visibleUntil.set(id, this.now() + VISIBLE_MS);
    else this.visibleUntil.delete(id);
  }

  isVisible(id: string): boolean {
    const until = this.visibleUntil.get(id);
    return until !== undefined && until > this.now();
  }

  /**
   * Send to every device (or only one, or only this Mac's browsers), skipping those with the board on screen unless
   * skipVisible is false.
   */
  async send(p: PushPayload, o: { only?: string; thisMac?: boolean; skipVisible?: boolean } = {}): Promise<PushResult> {
    const f = this.read();
    const wanted = f.devices.filter((d) => (o.only ? d.id === o.only || d.endpoint === o.only : true) && (!o.thisMac || d.thisMac));
    const targets = wanted.filter((d) => !(o.skipVisible !== false && this.isVisible(d.id)));
    const errors: string[] = [];
    const gone: string[] = [];
    let sent = 0;
    await Promise.all(targets.map(async (d) => {
      try {
        const { url, init } = pushRequest(d, JSON.stringify(p), f.vapid);
        const r = await this.fetch(url, init);
        if (r.status === 404 || r.status === 410) gone.push(d.id);
        else if (!r.ok) errors.push(`push to ${d.label} answered ${r.status} ${r.statusText}`.trim());
        else sent++;
      } catch (e) {
        errors.push(`push to ${d.label} failed: ${(e as Error).message}`);
      }
    }));
    for (const id of gone) this.remove(id);
    return { sent, removed: gone.length, onScreen: wanted.length - targets.length, error: errors[0] ?? null };
  }
}
