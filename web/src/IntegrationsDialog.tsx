import { useEffect, useState } from "react";
import { api, copy, type IntegrationAccount, type IntegrationCatalog } from "./api";
import { accountState } from "./automations";
import { ConfirmDialog } from "./ConfirmDialog";
import { CopyIcon } from "./icons";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { timeAgo } from "./time";

type Provider = IntegrationCatalog["providers"][number];

/**
 * Accounts of other services (Linear, ...), shared by all boards. Every provider draws itself from the server's
 * catalog (setup steps, fields), so a new integration needs no code here. refreshKey: bumps when the server says
 * an account changed (the sign-in tab finished).
 */
export function IntegrationsDialog({ refreshKey, onClose }: { refreshKey: number; onClose: () => void }) {
  const [data, setData] = useState<{ catalog: IntegrationCatalog; accounts: IntegrationAccount[] } | null>(null);
  const [form, setForm] = useState<{ provider: string; account?: IntegrationAccount } | null>(null);
  const [confirm, setConfirm] = useState<IntegrationAccount | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.integrations().then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [refreshKey]);

  const provider = (id: string): Provider | undefined => data?.catalog.providers.find((p) => p.id === id);

  /** Opens the service's approval page in a new tab; the server finishes the sign-in when it sends the user back. */
  const authorize = async (a: IntegrationAccount) => {
    setBusy(`auth:${a.id}`);
    setErr(null);
    try {
      const { url } = await api.authorizeIntegration(a.id);
      window.open(url, "_blank", "noopener");
      setNote(`Approve ckanban in the tab that just opened. This list updates when you are done.`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const row = (a: IntegrationAccount) => {
    const p = provider(a.provider);
    const st = accountState(a);
    return (
      <div key={a.id} className="mcp-row">
        <div className="mcp-main">
          <div className="mcp-name">
            <span>{a.providerName ?? a.provider}</span>
            {a.identity && <span className="muted small">{a.identity.userName}</span>}
            <span className={`badge ${st.tone}`}>{st.label}</span>
          </div>
          <div className="muted small">
            {a.identity ? `Workspace: ${a.identity.workspace} · ` : ""}Added {timeAgo(a.createdAt)}
          </div>
          {a.error && <div className="mcp-msg">{a.error}</div>}
          {!p && <div className="mcp-msg">This version of ckanban does not know this integration. Its automations are paused.</div>}
        </div>
        <div className="mcp-actions">
          {p?.oauth && (
            <button className={`btn small${a.status === "connected" ? "" : " primary"}`} disabled={busy === `auth:${a.id}`} onClick={() => authorize(a)}>
              {a.status === "connected" ? "Sign in again" : "Authorize"}
            </button>
          )}
          {p && p.fields.length > 0 && <button className="btn small ghost" onClick={() => setForm({ provider: a.provider, account: a })}>Edit</button>}
          <button className="btn small ghost danger" onClick={() => setConfirm(a)}>Disconnect</button>
        </div>
      </div>
    );
  };

  return (
    <Modal title="Integrations" onClose={onClose} wide>
      <div className="form mcp">
        <span className="muted small">Accounts that automations can listen to. They are shared by all boards, and the keys stay on this computer.</span>
        {err && <div className="form-error">{err}</div>}
        {note && <div className="muted small">{note}</div>}
        {!data && !err && <div className="muted">Loading…</div>}
        {data && !data.accounts.length && <div className="muted">Nothing connected yet.</div>}
        {data && data.accounts.length > 0 && <div className="mcp-section">{data.accounts.map(row)}</div>}
        {data && (
          <div className="field">
            <div className="field-label">Add an integration</div>
            <Select<string> value={form && !form.account ? form.provider : ""} ariaLabel="Add an integration"
              options={data.catalog.providers.map((p) => ({ value: p.id, label: p.name }))}
              renderValue={(o) => o?.label ?? "Choose…"}
              onChange={(id) => { setNote(null); setForm({ provider: id }); }} />
          </div>
        )}
        {data && form && provider(form.provider) && (
          <ConnectForm key={form.account?.id ?? form.provider} provider={provider(form.provider)!} callbackUrl={data.catalog.callbackUrl} account={form.account}
            onCancel={() => setForm(null)}
            onSaved={async (a, authorizeNow) => {
              setForm(null);
              await load();
              if (authorizeNow) await authorize(a);
            }} />
        )}
      </div>
      {confirm && (
        <ConfirmDialog title={`Disconnect ${confirm.providerName ?? confirm.provider}?`} confirmLabel="Disconnect" busyLabel="Disconnecting…"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await api.deleteIntegration(confirm.id);
            setConfirm(null);
            await load();
          }}>
          <p>Automations that use it stop until you pick another connection. Tickets they already made stay on the board.</p>
        </ConfirmDialog>
      )}
    </Modal>
  );
}

/** Setup steps and credential fields of one provider, from the catalog. With an account: editing it. */
function ConnectForm({ provider, callbackUrl, account, onSaved, onCancel }: {
  provider: Provider;
  callbackUrl: string;
  account?: IntegrationAccount;
  onSaved: (a: IntegrationAccount, authorize: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(account?.credentials ?? {}) }));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const a = account ? await api.updateIntegration(account.id, values) : await api.addIntegration(provider.id, values);
      await onSaved(a, provider.oauth && a.status !== "connected");
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  // The callback address inside a step gets a copy button.
  const step = (text: string) => {
    const at = text.indexOf(callbackUrl);
    if (at < 0) return text;
    return (
      <>
        {text.slice(0, at)}<code>{callbackUrl}</code>{" "}
        <button type="button" className="btn small ghost icon-label" onClick={async () => { setCopied(await copy(callbackUrl)); setTimeout(() => setCopied(false), 1500); }}>
          <CopyIcon size={12} /> {copied ? "Copied" : "Copy"}
        </button>
        {text.slice(at + callbackUrl.length)}
      </>
    );
  };

  return (
    <form className="mcp-add" onSubmit={submit}>
      <div className="field-label">{account ? `Edit ${provider.name}` : `Connect ${provider.name}`}</div>
      <ol className="int-steps">{provider.steps.map((s, i) => <li key={i} className="muted">{step(s)}</li>)}</ol>
      {provider.fields.map((f) => (
        <label key={f.id}>
          {f.label}
          <input type={f.secret ? "password" : "text"} value={values[f.id] ?? ""} autoComplete="off" spellCheck={false}
            placeholder={f.secret && account?.secretsSet.includes(f.id) ? "Saved. Leave empty to keep it." : ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))} />
        </label>
      ))}
      {err && <div className="form-error">{err}</div>}
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "Saving…" : provider.oauth ? `Authorize with ${provider.name}` : account ? "Save" : "Connect"}
        </button>
      </div>
    </form>
  );
}
