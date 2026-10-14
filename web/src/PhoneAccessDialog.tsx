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
  const [checking, setChecking] = useState(false);
  useNow();

  const load = () => api.remote().then(setState).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const recheck = async () => {
    setChecking(true);
    setError(null);
    await load();
    setChecking(false);
  };

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
  // Phone access is on, but Tailscale on this Mac isn't running (or can't be asked), so the phone can't connect.
  const down = on && (state!.tailscale === "stopped" || state!.tailscale === "unavailable");
  return (
    <Modal title="Phone access" onClose={onClose} focusDialog>
      <div className="phone-access">
        <p className="muted small">Open the board from your phone over Tailscale. Same as <code>ckanban remote on</code>.</p>
        {!state && !error && <div className="muted small"><span className="spinner" /> Checking…</div>}
        {state && (
          <div className={`pa-state ${down ? "down" : on ? "on" : ""}`} role="status">
            <span className="pa-dot" aria-hidden />
            {down
              ? state!.tailscale === "stopped" ? "Tailscale is off on this Mac · phone can't connect" : "Can't check Tailscale on this Mac"
              : on ? "On · Tailscale connected" : "Off"}
          </div>
        )}
        {down && (
          <div className="pa-fix">
            <b>To fix it</b>
            <ol>
              <li>Open the <b>Tailscale</b> app on this Mac.</li>
              <li>Then press <b>Check again</b>.</li>
              <li>So it doesn't happen after a restart: Tailscale menu → Settings → <b>Launch Tailscale at login</b>.</li>
            </ol>
          </div>
        )}
        {on && !down && (
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
              {down ? (
                <button className="btn primary" disabled={checking} onClick={recheck}>
                  {checking ? <><span className="spinner" /> Checking…</> : "Check again"}
                </button>
              ) : (
                <button className="btn primary" onClick={() => copy(state!.url!).then(() => toast("Link copied", { tone: "ok" }))}>Copy link</button>
              )}
            </>
          ) : (
            <button className="btn primary" disabled={busy || !state} onClick={() => toggle(true)}>{busy ? "Turning on…" : "Turn on"}</button>
          )}
        </div>
      </div>
    </Modal>
  );
}
