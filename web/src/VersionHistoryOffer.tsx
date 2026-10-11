import { useEffect, useState } from "react";
import { api, type RepoKind, type VersionHistory } from "./api";

/**
 * "This folder has no version history": offers to turn it on (a local git repo with one first snapshot; nothing is
 * uploaded) for a plain folder or a repo with no commits. Hidden when git isn't installed. New board and board settings.
 */
export function VersionHistoryOffer({ path, onRepo }: { path: string; /** What the folder's version history is (null: unknown). */ onRepo?: (repo: RepoKind | null) => void }) {
  const [info, setInfo] = useState<VersionHistory | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setInfo(null);
    setDismissed(false);
    setDone(false);
    setErr(null);
    onRepo?.(null);
    const p = path.trim();
    if (!p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p)) return;
    let live = true;
    // Typing a path checks it once the user pauses.
    const timer = setTimeout(() => {
      api.versionHistory(p).then((v) => {
        if (!live) return;
        setInfo(v);
        onRepo?.(v.repo);
      }).catch(() => {});
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [path]);

  const turnOn = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.enableVersionHistory(path.trim());
      setDone(true);
      onRepo?.(r.repo);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (done) return <div className="vh-ok" role="status">✓ Version history is on (first snapshot saved).</div>;
  if (!info?.git || dismissed || (info.repo !== "plain" && info.repo !== "empty")) return null;
  return (
    <div className="vh-offer" role="region" aria-label="Version history">
      <b>This folder has no version history.</b>
      <div>Turn it on so every ticket works on its own copy and you can undo any change. It stays on this computer; nothing is uploaded.</div>
      {err && <div className="field-error">{err}</div>}
      <div className="vh-actions">
        <button type="button" className="btn primary" onClick={turnOn} disabled={busy}>{busy ? "Turning on…" : "Turn on version history"}</button>
        <button type="button" className="btn" onClick={() => setDismissed(true)} disabled={busy}>Not now</button>
      </div>
    </div>
  );
}
