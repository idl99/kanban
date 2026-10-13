import { useEffect, useState } from "react";
import { api, type PushDevice } from "./api";
import { PUSH_HINT_KEY, pushState, turnOff, turnOn, type PushStatus } from "./push";
import { timeAgo } from "./time";
import { toast } from "./toast";
import { usePhone } from "./usePhone";

/** Notifications dialog → "This phone": turn notifications on for the device the board is open on (push.ts). */
export function PushSection({ profile }: { profile: string | null }) {
  const phone = usePhone();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [busy, setBusy] = useState<"on" | "off" | "test" | null>(null);
  const [manage, setManage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => pushState().then((s) => { setStatus(s.status); setMyId(s.myId); setDevices(s.devices); }).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  const act = async (kind: "on" | "off" | "test", fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const on = () => act("on", async () => {
    const s = await turnOn();
    if (s === "on") {
      try { localStorage.setItem(PUSH_HINT_KEY, "1"); } catch {}
      toast("Notifications are on for this device", { tone: "ok" });
    }
    await load();
  });
  const off = () => act("off", async () => { await turnOff(); await load(); });
  const test = () => act("test", async () => {
    const r = await api.pushTest(myId!, profile);
    if (r.ok) toast("Test sent to this device", { tone: "ok" });
    else setError(r.error);
    await load();
  });
  const remove = (id: string) => act("off", async () => { setDevices((await api.pushRemove({ id })).devices); });

  const name = phone ? "This phone" : "This device";
  const me = devices.find((d) => d.id === myId);
  const others = devices.filter((d) => d.id !== myId || status !== "on");
  const tone = status === "on" ? " ok" : status === "ios-browser" || status === "denied" ? " warn" : "";

  if (!status) return <div className="push-device"><span className="muted small"><span className="spinner" /> Checking this device…</span></div>;
  return (
    <div className={`push-device${tone}`}>
      <div className="push-device-head">
        <span className="push-device-title">{name}</span>
        {status === "on" && <span className="pill ok">On</span>}
      </div>
      {status === "off" && (
        <>
          <span className="muted small">Get a notification on this {phone ? "phone" : "device"} when a ticket needs you. Nothing comes while the board is open on screen.</span>
          <div><button type="button" className="btn primary" disabled={!!busy} onClick={() => void on()}>{busy === "on" ? "Turning on…" : `Turn on for this ${phone ? "phone" : "device"}`}</button></div>
        </>
      )}
      {status === "ios-browser" && (
        <>
          <span className="small">{/iPad/.test(navigator.userAgent) ? "iPad" : "iPhone"} only shows notifications from the board after you add it to your Home Screen:</span>
          <ol className="small push-steps">
            <li>Tap <b>Share</b> <span className="muted">(square with arrow)</span></li>
            <li>Tap <b>Add to Home Screen</b></li>
            <li>Open the board from the new icon and come back here</li>
          </ol>
        </>
      )}
      {status === "on" && (
        <>
          <span className="muted small">{me?.label}{me && <> · Turned on {timeAgo(me.createdAt)}.</>}</span>
          <div className="push-actions">
            <button type="button" className="btn" disabled={!!busy} onClick={() => void test()}>{busy === "test" ? "Sending…" : "Send test"}</button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => void off()}>{busy === "off" ? "Turning off…" : "Turn off"}</button>
          </div>
        </>
      )}
      {status === "denied" && (
        <span className="small">
          Notifications are blocked for the board. Allow them in your {phone ? "phone's settings for this app" : "browser's site settings"}, then reopen it.
        </span>
      )}
      {status === "insecure" && (
        <span className="muted small">This device can only get notifications when the board is opened on its secure address (Phone access link, or localhost on this Mac).</span>
      )}
      {status === "unsupported" && <span className="muted small">This browser can't show notifications from the board.</span>}
      {others.length > 0 && (
        <span className="muted small">
          {others.length} {status === "on" ? "other " : ""}device{others.length === 1 ? "" : "s"} also get{others.length === 1 ? "s" : ""} notifications.{" "}
          <button type="button" className="link-btn small" aria-expanded={manage} onClick={() => setManage((m) => !m)}>{manage ? "Hide" : "Manage"}</button>
        </span>
      )}
      {manage && others.length > 0 && (
        <ul className="push-list">
          {others.map((d) => (
            <li key={d.id}>
              <span>{d.label} <span className="muted small">· {timeAgo(d.createdAt)}</span></span>
              <button type="button" className="btn small" disabled={!!busy} onClick={() => void remove(d.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  );
}
