import { useEffect, useState } from "react";
import { api, copy, type RemoteState } from "./api";
import { Modal } from "./Modal";
import { timeAgo } from "./time";
import { toast } from "./toast";
import { useNow } from "./useNow";

/** Header menu → Phone access: the tailnet link, its QR code and the on/off switch (same as `ckanban remote`). */
export function PhoneAccessDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<RemoteState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useNow();

  useEffect(() => {
    api.remote().then(setState).catch((e) => setError(e.message));
  }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.setRemote(enabled);
      setState(next);
      if (next.warning) toast(`Phone access is off, but ${next.warning}`, { tone: "error" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const on = !!state?.enabled && !!state.url;
  return (
    <Modal title="Phone access" onClose={onClose} focusDialog>
      <div className="phone-access">
        <p className="muted small">Open the board from your phone over Tailscale. Same as <code>ckanban remote on</code>.</p>
        {!state && !error && <div className="muted small"><span className="spinner" /> Checking…</div>}
        {state && (
          <div className={`pa-state ${on ? "on" : ""}`} role="status">
            <span className="pa-dot" aria-hidden />{on ? "On · tailscale serve active" : "Off"}
          </div>
        )}
        {on && (
          <div className="pa-grid">
            {/* Generated on this Mac (qrcode-generator), no network. */}
            <div className="pa-qr" aria-label={`QR code for ${state!.url}`} role="img" dangerouslySetInnerHTML={{ __html: state!.qrSvg ?? "" }} />
            <div className="pa-info">
              <div className="pa-url">{state!.url}</div>
              <div className="pa-kv">Allowed login: <b>{state!.allowedLogin}</b></div>
              <div className="pa-kv">Last phone visit: <b>{state!.lastVisit ? timeAgo(state!.lastVisit) : "not yet"}</b></div>
            </div>
          </div>
        )}
        {state && !on && (
          <p className="small">
            Needs Tailscale on this Mac and your phone, signed in to the same account, with MagicDNS and HTTPS certificates
            turned on for your tailnet.
          </p>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="pa-warn">Only devices on your tailnet signed in as you can open it. Never public (no Funnel).</div>
        <div className="form-actions">
          {state?.local === false ? (
            <span className="muted small">Turn phone access on or off on the Mac.</span>
          ) : on ? (
            <>
              <button className="btn" disabled={busy} onClick={() => toggle(false)}>{busy ? "Turning off…" : "Turn off"}</button>
              <button className="btn primary" onClick={() => copy(state!.url!).then(() => toast("Link copied", { tone: "ok" }))}>Copy link</button>
            </>
          ) : (
            <button className="btn primary" disabled={busy || !state} onClick={() => toggle(true)}>{busy ? "Turning on…" : "Turn on"}</button>
          )}
        </div>
      </div>
    </Modal>
  );
}
