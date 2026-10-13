import { useEffect, useState } from "react";
import { CloseIcon } from "./icons";
import { PUSH_HINT_KEY, pushState, pushSupport, turnOn } from "./push";
import { toast } from "./toast";

const done = () => {
  try {
    return localStorage.getItem(PUSH_HINT_KEY) === "1";
  } catch {
    return true;
  }
};

/**
 * Top of the phone board, once: offer notifications on this phone. Gone for good after Turn on, Not now or ×. An
 * iPhone Safari tab can't turn them on yet: Turn on opens the Notifications dialog with the Home Screen steps.
 */
export function PushHint({ onSetup }: { onSetup: () => void }) {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const support = pushSupport();
    if (done() || (support !== "ok" && support !== "ios-browser")) return;
    let live = true;
    pushState().then((s) => { if (live) setShow(s.status === "off" || s.status === "ios-browser"); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const close = () => {
    try { localStorage.setItem(PUSH_HINT_KEY, "1"); } catch {}
    setShow(false);
  };
  const on = async () => {
    if (pushSupport() !== "ok") {
      close();
      onSetup();
      return;
    }
    setBusy(true);
    try {
      const s = await turnOn();
      if (s === "on") toast("Notifications are on for this phone", { tone: "ok" });
      else if (s === "denied") toast("Notifications are blocked for the board: allow them in your phone's settings", { tone: "error" });
      close();
    } catch (e) {
      toast(`Couldn't turn on notifications: ${(e as Error).message}`, { tone: "error" });
      setBusy(false);
    }
  };

  if (!show) return null;
  return (
    <div className="push-hint" role="status">
      <div className="push-hint-text">
        <b>Get told on this phone</b>
        <span className="muted small">A notification when a ticket needs you, while the board isn't on screen.</span>
        <div className="push-actions">
          <button className="btn primary small" disabled={busy} onClick={() => void on()}>{busy ? "Turning on…" : "Turn on"}</button>
          <button className="btn small" disabled={busy} onClick={close}>Not now</button>
        </div>
      </div>
      <button className="icon-btn" aria-label="Close" title="Don't show again" onClick={close}><CloseIcon size={12} /></button>
    </div>
  );
}
