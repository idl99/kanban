// Phone notifications on this device (Web Push, src/server/push.ts): what this browser supports, turning it on/off,
// and the heartbeat that tells the daemon when the board is on screen here (no push while you look at it).
import { api, type PushDevice } from "./api";

/** ok: can turn on; insecure: not https/localhost; ios-browser: iPhone/iPad Safari tab (needs Home Screen first). */
export type PushSupport = "ok" | "insecure" | "ios-browser" | "unsupported";
export type PushStatus = PushSupport | "denied" | "off" | "on";

export const PUSH_HINT_KEY = "ckanban.pushHintDone";
/** Fired on window when this device turned notifications on or off. */
const CHANGED = "ckanban-push-changed";

export function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return "insecure";
  if (isIOS() && !isStandalone()) return "ios-browser";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return "ok";
}

/** "iPhone · Safari (Home Screen)", "Android · Chrome", "Mac · Chrome". */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const device = /iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "iPad"
    : /iPhone|iPod/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Browser";
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox|FxiOS/.test(ua) ? "Firefox"
    : /Chrome|CriOS/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "";
  const where = isStandalone() ? (device === "iPhone" || device === "iPad" || device === "Android" ? " (Home Screen)" : " (app)") : "";
  return browser ? `${device} · ${browser}${where}` : device;
}

/** The daemon's device id for an endpoint (sha256, 12 hex), see deviceId in src/server/webpush.ts. */
export async function deviceIdOf(endpoint: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

function keyBytes(b64url: string): Uint8Array {
  const s = atob(b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64url.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "ok") return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** This device's state, and the daemon's device list (to tell whether it still knows this device). */
export async function pushState(): Promise<{ status: PushStatus; myId: string | null; devices: PushDevice[] }> {
  const support = pushSupport();
  const { devices } = await api.push();
  if (support !== "ok") return { status: support, myId: null, devices };
  if (Notification.permission === "denied") return { status: "denied", myId: null, devices };
  const sub = await currentSubscription();
  const myId = sub ? await deviceIdOf(sub.endpoint) : null;
  const on = !!myId && Notification.permission === "granted" && devices.some((d) => d.id === myId);
  return { status: on ? "on" : "off", myId, devices };
}

/** Ask for permission (call straight from a tap), subscribe and register this device with the daemon. */
export async function turnOn(): Promise<PushStatus> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const { publicKey } = await api.push();
  const options = { userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource };
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // Subscribed with another key (e.g. the daemon's push.json was reset): start over.
    const key = sub.options.applicationServerKey;
    const same = key && new Uint8Array(key).join() === keyBytes(publicKey).join();
    if (!same) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe(options);
  await api.pushSubscribe(sub.toJSON(), deviceLabel());
  window.dispatchEvent(new Event(CHANGED));
  return "on";
}

export async function turnOff(): Promise<void> {
  const sub = await currentSubscription();
  if (sub) {
    await api.pushRemove({ endpoint: sub.endpoint });
    await sub.unsubscribe().catch(() => false);
  }
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * While this device gets notifications: tell the daemon every 15 s that the board is on screen, and at once when it
 * isn't (VISIBLE_MS in src/server/push.ts). Also opens the ticket a tapped notification points at (sw.js).
 */
export function startPushClient(): () => void {
  if (pushSupport() !== "ok") return () => {};
  let endpoint: string | null = null;
  const beat = () => {
    if (!endpoint) return;
    const visible = document.visibilityState === "visible";
    if (visible) void api.pushVisible(endpoint, true).catch(() => {});
    // Leaving the page: a beacon still gets out while the page is being put away.
    else navigator.sendBeacon("/api/push/visible", new Blob([JSON.stringify({ endpoint, visible: false })], { type: "application/json" }));
  };
  const refresh = () => void currentSubscription().then((s) => {
    endpoint = s?.endpoint ?? null;
    beat();
  }).catch(() => {});
  const onMessage = (e: MessageEvent) => {
    if (e.data?.type === "open" && typeof e.data.hash === "string" && e.data.hash) window.location.hash = e.data.hash;
  };
  refresh();
  const timer = setInterval(() => { if (document.visibilityState === "visible") beat(); }, 15_000);
  document.addEventListener("visibilitychange", beat);
  window.addEventListener(CHANGED, refresh);
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", beat);
    window.removeEventListener(CHANGED, refresh);
    navigator.serviceWorker.removeEventListener("message", onMessage);
  };
}
