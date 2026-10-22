import { useEffect, useRef, useState } from "react";
import { api, type IntegrationAccount, type IntegrationCatalog, type Loop, type LoopRule, type Profile } from "./api";
import {
  addValue, insertAt, loopStatus, loopSubtitle, MATCH_LABEL, newRule, NO_RULES, OPERATOR_LABEL, providerOf, removeValue, triggerOf, withField,
  type CatalogTrigger,
} from "./automations";
import { ConfirmDialog } from "./ConfirmDialog";
import { CloseIcon } from "./icons";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { timeAgo } from "./time";

type Option = { value: string; label: string };
type Data = { catalog: IntegrationCatalog; accounts: IntegrationAccount[]; loops: Loop[] };

/**
 * The board's automations: when something happens in a connected service and passes the rules, the board acts
 * (v1: creates a ticket). The trigger, rule fields, variables and action settings all come from the server's
 * catalog, so a new integration needs no code here. refreshKey: bumps when a loop or account changed on the server.
 */
export function AutomationsDialog({ profile, boards, refreshKey, onOpenIntegrations, onClose }: {
  profile: Profile;
  /** Every board, for "Copy to board". */
  boards: Profile[];
  refreshKey: number;
  onOpenIntegrations: () => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | "new" | null>(null);

  useEffect(() => {
    Promise.all([api.integrations(), api.loops(profile.slug)])
      .then(([i, loops]) => setData({ catalog: i.catalog, accounts: i.accounts, loops }))
      .catch((e) => setErr(e.message));
  }, [profile.slug, refreshKey]);

  const reload = async () => {
    const [i, loops] = await Promise.all([api.integrations(), api.loops(profile.slug)]);
    setData({ catalog: i.catalog, accounts: i.accounts, loops });
  };

  const usable = data?.accounts.filter((a) => providerOf(data.catalog, a.provider)) ?? [];
  const loop = data && selected && selected !== "new" ? data.loops.find((l) => l.id === selected) ?? null : null;

  return (
    <Modal title={`Automations · ${profile.name}`} onClose={onClose} wide>
      <div className="form mcp">
        <span className="muted small">
          An automation listens to a connected service. When something happens there and passes your rules, this board creates a ticket.
          It only reacts to things that happen after you switch it on. Checks run about once a minute while ckanban is running.
        </span>
        {err && <div className="form-error">{err}</div>}
        {!data && !err && <div className="muted">Loading…</div>}
        {data && !usable.length && (
          <div className="auto-empty">
            <div>Connect a service first, so an automation has something to listen to.</div>
            <button className="btn primary" onClick={onOpenIntegrations}>Open Integrations</button>
          </div>
        )}
        {data && (usable.length > 0 || data.loops.length > 0) && (
          <div className="auto-wrap">
            <div className="auto-list" role="list" aria-label="Automations">
              {data.loops.map((l) => {
                const st = loopStatus(l);
                return (
                  <button key={l.id} role="listitem" className={`auto-item${selected === l.id ? " sel" : ""}`} onClick={() => setSelected(l.id)}>
                    <span className="auto-item-main">
                      <span className="auto-item-name">{l.name}</span>
                      <span className="muted small">
                        {loopSubtitle(data.catalog, l)}{l.lastFiredAt ? ` · fired ${timeAgo(l.lastFiredAt)}` : " · never fired"}
                      </span>
                    </span>
                    <span className={`badge ${st.tone}`}>{st.label}</span>
                  </button>
                );
              })}
              {!data.loops.length && <div className="muted small">No automations yet.</div>}
              {usable.length > 0 && (
                <button className="btn" onClick={() => setSelected("new")}>+ New automation</button>
              )}
            </div>
            <div className="auto-editor">
              {!selected && <div className="muted">Pick an automation, or create a new one.</div>}
              {selected === "new" && (
                <LoopEditor key="new" slug={profile.slug} catalog={data.catalog} accounts={usable} loop={null}
                  onSaved={async (l) => { await reload(); setSelected(l.id); }} onDeleted={() => setSelected(null)} />
              )}
              {loop && (
                <LoopEditor key={loop.id} slug={profile.slug} catalog={data.catalog} accounts={usable} loop={loop} otherBoards={boards.filter((b) => b.slug !== profile.slug)}
                  onSaved={async () => { await reload(); }} onDeleted={async () => { setSelected(null); await reload(); }} />
              )}
              {selected && selected !== "new" && !loop && <div className="muted">This automation no longer exists.</div>}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function LoopEditor({ slug, catalog, accounts, loop, otherBoards = [], onSaved, onDeleted }: {
  slug: string;
  otherBoards?: Profile[];
  catalog: IntegrationCatalog;
  accounts: IntegrationAccount[];
  loop: Loop | null;
  onSaved: (l: Loop) => Promise<void>;
  onDeleted: () => void | Promise<void>;
}) {
  const connected = accounts.filter((a) => a.status === "connected" || a.id === loop?.accountId);
  const firstAccount = connected[0] ?? accounts[0];
  const [name, setName] = useState(loop?.name ?? "");
  const [enabled, setEnabled] = useState(loop?.enabled ?? true);
  const [accountId, setAccountId] = useState(loop?.accountId ?? firstAccount?.id ?? "");
  const provider = providerOf(catalog, accounts.find((a) => a.id === accountId)?.provider ?? loop?.provider ?? "");
  const [triggerId, setTriggerId] = useState(loop?.trigger ?? provider?.triggers[0]?.id ?? "");
  const trigger: CatalogTrigger | undefined = provider?.triggers.find((t) => t.id === triggerId);
  const [match, setMatch] = useState<"all" | "any">(loop?.match ?? "all");
  const [rules, setRules] = useState<LoopRule[]>(loop?.rules ?? []);
  const [actionType, setActionType] = useState(loop?.action.type ?? catalog.actions[0]?.id ?? "");
  const action = catalog.actions.find((a) => a.id === actionType);
  const [settings, setSettings] = useState<Record<string, string>>(() => {
    const own = loop?.action.settings ?? {};
    return Object.fromEntries((action?.settings ?? []).map((s) => [s.id, own[s.id] ?? s.default]));
  });
  const [instructions, setInstructions] = useState(loop?.instructions ?? trigger?.defaultInstructions ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const options = useRef(new Map<string, Promise<Option[]>>());
  const unsupported = loop?.state === "unsupported";

  const pickAccount = (id: string) => {
    const p = providerOf(catalog, accounts.find((a) => a.id === id)?.provider ?? "");
    setAccountId(id);
    // A different service has other triggers and fields.
    if (p && !p.triggers.some((t) => t.id === triggerId)) {
      setTriggerId(p.triggers[0]?.id ?? "");
      setRules([]);
      if (!loop) setInstructions(p.triggers[0]?.defaultInstructions ?? "");
    }
  };
  const pickTrigger = (id: string) => {
    const t = provider?.triggers.find((x) => x.id === id);
    setTriggerId(id);
    setRules((rs) => rs.filter((r) => t?.fields.some((f) => f.id === r.field)));
    if (!loop && (!instructions.trim() || instructions === trigger?.defaultInstructions)) setInstructions(t?.defaultInstructions ?? "");
  };

  const loadOptions = (field: string): Promise<Option[]> => {
    const key = `${accountId}/${triggerId}/${field}`;
    let p = options.current.get(key);
    if (!p) {
      p = api.integrationOptions(accountId, triggerId, field);
      p.catch(() => options.current.delete(key));
      options.current.set(key, p);
    }
    return p;
  };

  const insertVariable = (v: string) => {
    const el = area.current;
    const r = insertAt(instructions, el?.selectionStart ?? instructions.length, el?.selectionEnd ?? instructions.length, `{{${v}}}`);
    setInstructions(r.text);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(r.caret, r.caret); });
  };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy("save");
    setErr(null);
    try {
      const input = { name: name.trim(), enabled, accountId, trigger: triggerId, match, rules, action: { type: actionType, settings }, instructions };
      await onSaved(loop ? await api.updateLoop(slug, loop.id, input) : await api.createLoop(slug, input));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const toggleOnly = async (on: boolean) => {
    setEnabled(on);
    if (!loop) return;
    setBusy("toggle");
    setErr(null);
    try {
      await onSaved(await api.updateLoop(slug, loop.id, { enabled: on }));
    } catch (e: any) {
      setErr(e.message);
      setEnabled(!on);
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    setErr(null);
    try {
      await api.checkLoop(slug, loop!.id);
      await onSaved(loop!);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const copyTo = async (board: Profile) => {
    setBusy("copy");
    setErr(null);
    setNote(null);
    try {
      await api.copyLoop(slug, loop!.id, board.slug);
      setNote(`Copied to ${board.name}. The copy is switched off there; open that board's Automations, check it and switch it on.`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const problems = loop?.problems ?? [];
  const setRule = (i: number, r: LoopRule) => setRules((rs) => rs.map((x, j) => (j === i ? r : x)));

  return (
    <form className="mcp-add auto-form" onSubmit={save}>
      <div className="auto-head">
        <input className="auto-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Assigned to me" aria-label="Automation name" disabled={unsupported} />
        <label className="check-row">
          <input type="checkbox" checked={enabled} disabled={busy === "toggle"} onChange={(e) => (unsupported || loop ? toggleOnly(e.target.checked) : setEnabled(e.target.checked))} /> Enabled
        </label>
      </div>
      {problems.length > 0 && <div className="mcp-msg">{problems.map((p) => <div key={p}>{p}</div>)}</div>}
      {loop?.lastError && <div className="mcp-msg">Last check failed: {loop.lastError}</div>}
      {unsupported ? (
        <div className="muted small">This version of ckanban can't edit this automation. You can switch it off or delete it.</div>
      ) : (
        <>
          <div className="field">
            <div className="field-label">When</div>
            <div className="auto-row">
              <Select<string> value={accountId} ariaLabel="Connection" options={accounts.map((a) => ({ value: a.id, label: `${a.providerName ?? a.provider}${a.identity ? ` · ${a.identity.userName}` : ""}` }))}
                onChange={pickAccount} />
              <Select<string> value={triggerId} ariaLabel="Trigger" options={(provider?.triggers ?? []).map((t) => ({ value: t.id, label: t.label }))} onChange={pickTrigger} />
            </div>
            <span className="muted small">Only triggers of the chosen connection are listed. Filter fields and variables follow the trigger.</span>
          </div>

          <div className="field">
            <div className="field-label">Only when</div>
            {rules.length === 0 && <span className="muted small">{NO_RULES}</span>}
            {rules.length > 1 && (
              <div className="auto-row">
                <span className="muted small">Match</span>
                <Select<"all" | "any"> value={match} ariaLabel="Match" options={[{ value: "all", label: MATCH_LABEL.all }, { value: "any", label: MATCH_LABEL.any }]} onChange={setMatch} />
                <span className="muted small">of these rules</span>
              </div>
            )}
            {trigger && rules.map((r, i) => (
              <div key={i}>
                {i > 0 && <div className="auto-join muted small">{match === "all" ? "AND" : "OR"}</div>}
                <RuleRow trigger={trigger} rule={r} onChange={(x) => setRule(i, x)} onRemove={() => setRules((rs) => rs.filter((_, j) => j !== i))} load={loadOptions} />
              </div>
            ))}
            {trigger && trigger.fields.length > 0 && (
              <button type="button" className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => setRules((rs) => [...rs, newRule(trigger)])}>+ Add rule</button>
            )}
          </div>

          <div className="field">
            <div className="field-label">Then</div>
            <div className="auto-row">
              {catalog.actions.length > 1 && (
                <Select<string> value={actionType} ariaLabel="Action" options={catalog.actions.map((a) => ({ value: a.id, label: a.label }))}
                  onChange={(id) => { setActionType(id); setSettings({}); }} />
              )}
              {action?.settings.map((s) => (
                <span key={s.id} className="auto-setting">
                  <span className="muted small">{catalog.actions.length > 1 ? s.label : `${action.label}, ${s.label.charAt(0).toLowerCase()}${s.label.slice(1)}`}</span>
                  <Select<string> value={settings[s.id] ?? s.default} ariaLabel={s.label} options={s.options} onChange={(v) => setSettings((x) => ({ ...x, [s.id]: v }))} />
                </span>
              ))}
            </div>
          </div>

          <label className="field">
            <span className="field-label">Instructions</span>
            <textarea ref={area} rows={7} className="mono" value={instructions} onChange={(e) => setInstructions(e.target.value)}
              placeholder="What Claude should do. The ticket description is this text with the variables filled in." />
          </label>
          {trigger && trigger.variables.length > 0 && (
            <div className="auto-vars">
              <span className="muted small">Variables for this trigger (click to insert):</span>
              {trigger.variables.map((v) => (
                <button key={v.name} type="button" className="chip-btn" title={v.label} onClick={() => insertVariable(v.name)}><code>{`{{${v.name}}}`}</code></button>
              ))}
            </div>
          )}
        </>
      )}

      {err && <div className="form-error">{err}</div>}
      {note && <div className="muted small">{note}</div>}
      {loop && (
        <span className="muted small">
          {loop.lastCheckedAt ? `Last checked ${timeAgo(loop.lastCheckedAt)}` : "Not checked yet"}
          {loop.lastFiredAt ? ` · last ticket ${timeAgo(loop.lastFiredAt)}` : ""}
        </span>
      )}
      <div className="form-actions">
        {loop && <button type="button" className="btn ghost danger" onClick={() => setConfirm(true)}>Delete</button>}
        {loop && !unsupported && otherBoards.length > 0 && (
          <Select<string> value="" ariaLabel="Copy to another board" options={otherBoards.map((b) => ({ value: b.slug, label: b.name }))}
            renderValue={() => (busy === "copy" ? "Copying…" : "Copy to board…")}
            onChange={(v) => { const b = otherBoards.find((x) => x.slug === v); if (b) void copyTo(b); }} />
        )}
        <div className="spacer" />
        {loop && !unsupported && <button type="button" className="btn ghost" disabled={busy === "check" || !loop.enabled} onClick={check} title="Ask the service now instead of waiting for the next check">{busy === "check" ? "Checking…" : "Check now"}</button>}
        {!unsupported && <button type="submit" className="btn primary" disabled={busy === "save"}>{busy === "save" ? "Saving…" : loop ? "Save" : "Create automation"}</button>}
      </div>
      {confirm && loop && (
        <ConfirmDialog title={`Delete ${loop.name}?`} confirmLabel="Delete" busyLabel="Deleting…" onCancel={() => setConfirm(false)}
          onConfirm={async () => { await api.deleteLoop(slug, loop.id); setConfirm(false); await onDeleted(); }}>
          <p>It stops listening. Tickets it already created stay on the board.</p>
        </ConfirmDialog>
      )}
    </form>
  );
}

function RuleRow({ trigger, rule, onChange, onRemove, load }: {
  trigger: CatalogTrigger;
  rule: LoopRule;
  onChange: (r: LoopRule) => void;
  onRemove: () => void;
  load: (field: string) => Promise<Option[]>;
}) {
  const field = trigger.fields.find((f) => f.id === rule.field);
  const [opts, setOpts] = useState<Option[] | null>(null);
  const [optErr, setOptErr] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    setOpts(null);
    setOptErr(null);
    if (!field?.pick) return;
    let live = true;
    load(field.id).then((o) => live && setOpts(o)).catch((e) => live && setOptErr(e.message));
    return () => { live = false; };
  }, [field?.id, field?.pick]);

  const label = (v: string) => opts?.find((o) => o.value === v)?.label ?? v;
  const left = (opts ?? []).filter((o) => !rule.values.includes(o.value));

  return (
    <div className="auto-rule">
      <Select<string> value={rule.field} ariaLabel="Field" options={trigger.fields.map((f) => ({ value: f.id, label: f.label }))} onChange={(id) => onChange(withField(trigger, rule, id))} />
      <Select<string> value={rule.op} ariaLabel="Operator" options={(field?.operators ?? []).map((o) => ({ value: o, label: OPERATOR_LABEL[o] ?? o }))} onChange={(op) => onChange({ ...rule, op })} />
      <div className="auto-values">
        {rule.values.map((v) => (
          <span key={v} className="auto-value">{label(v)}
            <button type="button" aria-label={`Remove ${label(v)}`} onClick={() => onChange({ ...rule, values: removeValue(rule.values, v) })}><CloseIcon size={10} /></button>
          </span>
        ))}
        {field?.pick ? (
          optErr ? <span className="form-error">{optErr}</span>
            : !opts ? <span className="muted small">Loading…</span>
            : left.length > 0 && (
              <Select<string> value="" ariaLabel="Add a value" options={left} renderValue={() => (rule.values.length ? "Add another…" : "Pick…")}
                onChange={(v) => onChange({ ...rule, values: addValue(rule.values, v) })} />
            )
        ) : (
          <input value={typed} placeholder="Type a value, press Enter" aria-label="Value" onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              onChange({ ...rule, values: addValue(rule.values, typed.trim()) });
              setTyped("");
            }} />
        )}
      </div>
      <button type="button" className="btn small ghost" aria-label="Remove rule" onClick={onRemove}>×</button>
    </div>
  );
}
