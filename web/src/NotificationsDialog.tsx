import { useEffect, useState } from "react";
import { api, type NotifyKind, type NotifyState } from "./api";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { timeAgo } from "./time";
import { toast } from "./toast";

const KINDS: { kind: NotifyKind; label: string }[] = [
  { kind: "questions", label: "Questions for you" },
  { kind: "proposal", label: "Proposal to review" },
  { kind: "review", label: "Ready for review" },
  { kind: "failed", label: "Run failed" },
  { kind: "stalled", label: "Run stalled (no output)" },
  { kind: "limit", label: "Usage limit hit" },
  { kind: "blocked", label: "Blocked / plan stuck" },
  { kind: "huddle", label: "Huddle asks you" },
  { kind: "reply", label: "Claude replied in Planning" },
];

/** Header menu → Notifications: where "needs you" goes (ntfy / webhook, macOS banner) and for which kinds. */
export function NotificationsDialog({ profile, onClose }: { profile: string | null; onClose: () => void }) {
  const [state, setState] = useState<NotifyState | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);

  useEffect(() => {
    api.notify().then((s) => { setState(s); setUrl(s.webhookUrl); }).catch((e) => setError(e.message));
  }, []);

  const save = async (patch: Parameters<typeof api.setNotify>[0]) => {
    setError(null);
    try {
      const next = await api.setNotify(patch);
      setState(next);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const saveUrl = async () => {
    if (!state || url.trim() === state.webhookUrl) return true;
    setBusy("save");
    const ok = await save({ webhookUrl: url });
    setBusy(null);
    return ok;
  };

  const test = async () => {
    if (!(await saveUrl())) return;
    setBusy("test");
    try {
      const r = await api.testNotify(profile);
      setState(r.state);
      if (r.error) setError(r.error);
      else toast(r.webhook ? "Test notification sent" : "Test banner shown (no webhook set)", { tone: "ok" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const ntfy = state?.format === "ntfy" || (state?.format === "auto" && /ntfy/i.test(url));
  return (
    <Modal title="Notifications" onClose={onClose} focusDialog>
      <form className="form notify-form" onSubmit={(e) => { e.preventDefault(); void saveUrl(); }}>
        <p className="muted small">
          When a ticket starts needing you (questions, a proposal, review, a failed run, the usage limit), the board tells you once.
        </p>
        {!state && !error && <div className="muted small"><span className="spinner" /> Loading…</div>}
        {state && (
          <>
            <label>
              Webhook URL
              <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => void saveUrl()}
                placeholder="https://ntfy.sh/your-secret-topic" spellCheck={false} autoComplete="off" />
              <span className="muted small setup-hint">
                {ntfy
                  ? "ntfy: install the ntfy app on your phone and subscribe to the same topic. Pick a long, hard-to-guess topic name."
                  : "Any URL that takes a POST. ntfy topic URLs work as-is; others get JSON {board, ticketId, title, kind, url}."}
              </span>
            </label>
            <label>
              Format
              <Select ariaLabel="Webhook format" value={state.format} onChange={(format) => void save({ format })}
                options={[
                  { value: "auto", label: "Auto", hint: "ntfy when the URL has “ntfy” in it, else JSON" },
                  { value: "ntfy", label: "ntfy (plain text + headers)" },
                  { value: "json", label: "JSON" },
                ]} />
            </label>
            <label className="board-switch">
              <input type="checkbox" checked={state.mac} onChange={(e) => void save({ mac: e.target.checked })} />
              <span>
                macOS banner on this Mac
                <span className="muted small">Also used for “Plan done”.</span>
              </span>
            </label>
            <div className="form-section"><span>Notify me about</span></div>
            <div className="notify-kinds">
              {KINDS.map(({ kind, label }) => (
                <label key={kind} className="board-switch">
                  <input type="checkbox" checked={state.kinds[kind]} onChange={(e) => void save({ kinds: { [kind]: e.target.checked } })} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <span className="muted small">
              Links open the ticket on your phone when Phone access is on, else on this Mac.
              {state.lastSentAt && <> Last sent {timeAgo(state.lastSentAt)}.</>}
            </span>
          </>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="form-actions">
          <button type="button" className="btn" disabled={!state || !!busy} onClick={test}>{busy === "test" ? "Sending…" : "Send test notification"}</button>
          <div className="spacer" />
          <button type="button" className="btn primary" disabled={busy === "save"} onClick={async () => { if (await saveUrl()) onClose(); }}>Done</button>
        </div>
      </form>
    </Modal>
  );
}
