import { useEffect, useState } from "react";
import { api, type Loop, type LoopColumn, type LoopInput, type LoopTest, type Pass, type Profile } from "./api";
import { COLUMN_LABEL, EVERY_CHOICES, everyLabel, loopStatus, loopSubtitle } from "./automations";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { timeAgo } from "./time";

type Data = { passes: Pass[]; loops: Loop[] };

const NEW_SCRIPT = `# Prints the items to watch as JSON, one per line: {"id": "...", "title": "...", "text": "...", "link": "..."}
# Call a connected service with: ckanban call <service> <tool> '<json arguments>'
`;
const DEFAULT_TEXT = "Look at this item from {{service}} and do what it needs.\n\nLink: {{link}}";

/**
 * The board's automations: a check script the board runs on a timer, without Claude; each item it finds for the first
 * time becomes a ticket. Most people set one up with Claude (a Planning chat); the editor here shows and fine-tunes it.
 * refreshKey: bumps when an automation or a pass changed on the server.
 */
export function AutomationsDialog({ profile, boards, refreshKey, onClose, onOpenTicket, onOpenConnections }: {
  profile: Profile;
  /** Every board, for "Copy to board". */
  boards: Profile[];
  refreshKey: number;
  onClose: () => void;
  /** Opens a ticket of this board (the setup chat, a ticket an automation made). */
  onOpenTicket: (id: string) => void;
  onOpenConnections: () => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const [p, loops] = await Promise.all([api.passes(), api.loops(profile.slug)]);
    setData({ passes: p.passes, loops });
    return loops;
  };
  useEffect(() => {
    reload().then((loops) => setSelected((s) => s ?? loops[0]?.id ?? null)).catch((e) => setErr(e.message));
  }, [profile.slug, refreshKey]);

  const setUpWithClaude = async () => {
    setBusy(true);
    setErr(null);
    try {
      const t = await api.automationSetup(profile.slug);
      onOpenTicket(t.id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const loop = data && selected && selected !== "new" ? data.loops.find((l) => l.id === selected) ?? null : null;

  return (
    <Modal title={`Automations · ${profile.name}`} onClose={onClose} wide>
      <div className="form mcp">
        {err && <div className="form-error">{err}</div>}
        {!data && !err && <div className="muted">Loading…</div>}
        {data && (
          <div className="auto-wrap">
            <div className="auto-list" role="list" aria-label="Automations">
              {data.loops.map((l) => {
                const st = loopStatus(l);
                return (
                  <button key={l.id} role="listitem" className={`auto-item${selected === l.id ? " sel" : ""}`} onClick={() => setSelected(l.id)}>
                    <span className="auto-item-main">
                      <span className="auto-item-name">{l.name}</span>
                      <span className="muted small auto-item-sub">{loopSubtitle(l, timeAgo)}</span>
                    </span>
                    <span className={`badge ${st.tone}`}>{st.label}</span>
                  </button>
                );
              })}
              {!data.loops.length && (
                <div className="muted small">
                  An automation checks a service on a timer, by itself and for free, and turns each new item into a ticket here.
                </div>
              )}
              <button className="btn primary" disabled={busy} onClick={setUpWithClaude}>✦ Set up with Claude</button>
              <button className="btn" onClick={() => setSelected("new")}>+ New, by hand</button>
            </div>
            <div className="auto-editor">
              {!selected && <div className="muted">Set one up with Claude: say what to watch, Claude writes and tests the check, and you save it.</div>}
              {selected === "new" && (
                <LoopEditor key="new" slug={profile.slug} passes={data.passes} loop={null} onOpenTicket={onOpenTicket} onOpenConnections={onOpenConnections}
                  onSaved={async (l) => { await reload(); setSelected(l.id); }} onDeleted={() => setSelected(null)} />
              )}
              {loop && (
                <LoopEditor key={loop.id} slug={profile.slug} passes={data.passes} loop={loop} otherBoards={boards.filter((b) => b.slug !== profile.slug)}
                  onOpenTicket={onOpenTicket} onOpenConnections={onOpenConnections}
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

const ITEM_STATE: Record<Loop["lastItems"][number]["state"], string> = {
  new: "NEW", skipped: "SKIPPED", seen: "", first: "",
};

function LoopEditor({ slug, passes, loop, otherBoards = [], onSaved, onDeleted, onOpenTicket, onOpenConnections }: {
  slug: string;
  passes: Pass[];
  loop: Loop | null;
  otherBoards?: Profile[];
  onSaved: (l: Loop) => Promise<void>;
  onDeleted: () => void | Promise<void>;
  onOpenTicket: (id: string) => void;
  onOpenConnections: () => void;
}) {
  const [name, setName] = useState(loop?.name ?? "");
  const [enabled, setEnabled] = useState(loop?.enabled ?? true);
  const [service, setService] = useState(loop?.service ?? "");
  const [passIds, setPassIds] = useState<string[]>(loop?.passes ?? []);
  const [script, setScript] = useState(loop?.script ?? NEW_SCRIPT);
  const [every, setEvery] = useState(loop?.everyMinutes ?? 15);
  const [column, setColumn] = useState<LoopColumn>(loop?.column ?? "backlog");
  const [autoStart, setAutoStart] = useState(loop?.autoStart ?? false);
  const [askOn, setAskOn] = useState(loop?.askClaude.on ?? false);
  const [askPrompt, setAskPrompt] = useState(loop?.askClaude.prompt ?? "");
  const [instructions, setInstructions] = useState(loop?.instructions ?? DEFAULT_TEXT);
  const [showScript, setShowScript] = useState(!loop);
  const [test, setTest] = useState<LoopTest | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const unsupported = loop?.state === "unsupported";
  const changed = loop?.state === "script_changed";
  const svc = service.trim() || passes.find((p) => p.id === passIds[0])?.name || "the service";
  const everyOptions = [...new Set([...EVERY_CHOICES, every])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: everyLabel(m) }));

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setErr(null);
    setNote(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const input = (): LoopInput => ({
    name: name.trim(), enabled, service: service.trim(), passes: passIds, script, everyMinutes: every,
    column, autoStart: column !== "backlog" && autoStart, askClaude: { on: askOn, prompt: askPrompt }, instructions,
  });

  const save = (e?: React.FormEvent) => {
    e?.preventDefault();
    return act("save", async () => {
      const l = loop ? await api.updateLoop(slug, loop.id, input()) : await api.createLoop(slug, input());
      await onSaved(l);
    });
  };

  const pickColumn = (c: LoopColumn) => {
    setColumn(c);
    if (c === "backlog") setAutoStart(false);
  };

  const togglePass = (id: string) => setPassIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const usable = passes.filter((p) => p.kind !== "key" || p.envName || p.url);

  if (unsupported) {
    return (
      <div className="auto-form">
        <div className="auto-head"><b className="auto-name">{loop!.name}</b></div>
        <div className="mcp-msg">{loop!.problems.map((p) => <div key={p}>{p}</div>)}</div>
        {err && <div className="form-error">{err}</div>}
        <div className="form-actions">
          {loop!.enabled && <button className="btn" disabled={!!busy} onClick={() => act("off", async () => { await onSaved(await api.updateLoop(slug, loop!.id, { enabled: false })); })}>Switch off</button>}
          <button className="btn ghost danger" onClick={() => setConfirm(true)}>Delete</button>
        </div>
        {confirm && <DeleteLoop slug={slug} loop={loop!} onCancel={() => setConfirm(false)} onDeleted={onDeleted} />}
      </div>
    );
  }

  return (
    <form className="auto-form" onSubmit={save}>
      <div className="auto-head">
        <input className="auto-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Linear: assigned to me" aria-label="Automation name" />
        <label className="auto-check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> On</label>
      </div>
      {loop && (
        <div className="muted small">
          {loop.lastCheckedAt ? `Checked ${timeAgo(loop.lastCheckedAt)} · found ${loop.lastFound} item${loop.lastFound === 1 ? "" : "s"}` : "Not checked yet"}
          {" · costs nothing until something new shows up"}{askOn ? " (then Claude looks at it)" : ""}
        </div>
      )}
      {loop && loop.state !== "ok" && <div className="mcp-msg">{loop.problems.map((p) => <div key={p}>{p}</div>)}</div>}
      {loop?.state === "ok" && loop.lastError && <div className="mcp-msg">Last check failed: {loop.lastError}</div>}

      <div className="auto-sentence">
        Check <input className="auto-pill" value={service} onChange={(e) => setService(e.target.value)} placeholder={svc} aria-label="What it checks" size={Math.max(6, (service || svc).length)} />
        {" "}every <Select<string> value={String(every)} ariaLabel="How often" options={everyOptions} onChange={(v) => setEvery(Number(v))} />.
        <br />
        New items become tickets in <Select<LoopColumn> value={column} ariaLabel="Column for new tickets"
          options={(["backlog", "planning", "ready"] as const).map((c) => ({ value: c, label: COLUMN_LABEL[c] }))} onChange={pickColumn} />.
      </div>
      {column !== "backlog" && (
        <div className="mcp-help">
          <label className="auto-check">
            <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
            <span><b>Start Claude by itself.</b> Text from {svc} will start Claude, which can change your files. Anyone who can write in {svc} can put text there.</span>
          </label>
        </div>
      )}

      <div className="auto-box">
        <div className="auto-box-head">
          <button type="button" className="link-btn" aria-expanded={showScript} onClick={() => setShowScript((v) => !v)}>
            {showScript ? "▾" : "▸"} How it checks
          </button>
          <span className="muted small">
            {passIds.length ? `Uses: ${passIds.map((id) => passes.find((p) => p.id === id)?.name ?? "(removed)").join(", ")}` : "Uses no connection"}
          </span>
        </div>
        {(showScript || changed) && (
          <div className="auto-box-body">
            {changed && <div className="mcp-msg">The script file changed since it was saved. Read it below; Save runs this version from now on.</div>}
            <div className="field">
              <div className="field-label">Connections it may use</div>
              <div className="auto-row">
                {usable.map((p) => (
                  <label key={p.id} className="auto-check">
                    <input type="checkbox" checked={passIds.includes(p.id)} onChange={() => togglePass(p.id)} /> {p.name}
                    {p.status !== "connected" && <span className="badge blocked">needs connecting</span>}
                  </label>
                ))}
                {!usable.length && <span className="muted small">None yet.</span>}
                <button type="button" className="link-btn small" onClick={onOpenConnections}>Connections…</button>
              </div>
            </div>
            <label className="field">
              <span className="field-label">Check script</span>
              <textarea rows={9} className="mono" value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false} aria-label="Check script" />
            </label>
            <span className="muted small">
              It prints one JSON item per line: <code>{`{"id": "...", "title": "...", "text": "...", "link": "..."}`}</code>. Only id and title are required.
              It reaches a connection with <code>ckanban call &lt;name&gt; &lt;tool&gt; '&lt;json&gt;'</code>.
            </span>
            <div className="auto-row">
              <button type="button" className="btn small" disabled={!!busy || !script.trim()}
                onClick={() => act("test", async () => setTest(await api.testLoop(slug, script, passIds)))}>
                {busy === "test" ? "Testing…" : "Test"}
              </button>
              {test && <span className="muted small">{test.error ? test.error : `Found ${test.found} item${test.found === 1 ? "" : "s"}`}</span>}
            </div>
            {test && test.items.length > 0 && (
              <ul className="auto-found">{test.items.map((i) => <li key={i.id}>{i.title}</li>)}</ul>
            )}
            {test?.stderr.trim() && <details className="mcp-details"><summary>Error output</summary><pre>{test.stderr}</pre></details>}
          </div>
        )}
      </div>

      {loop && loop.lastItems.length > 0 && (
        <div className="auto-box">
          <div className="auto-box-head">
            <b className="small">Last check found</b>
            <button type="button" className="btn small" disabled={!!busy || loop.state !== "ok" || !loop.enabled}
              onClick={() => act("check", async () => { await onSaved(await api.checkLoop(slug, loop.id)); })}>
              {busy === "check" ? "Checking…" : "Check now"}
            </button>
          </div>
          <table className="auto-table">
            <tbody>
              {loop.lastItems.map((i) => (
                <tr key={i.id}>
                  <td className={`auto-state ${i.state}`}>{ITEM_STATE[i.state]}</td>
                  <td>{i.link ? <a href={i.link} target="_blank" rel="noreferrer">{i.title}</a> : i.title}</td>
                  <td className="muted small">
                    {i.state === "new" && i.ticketId ? <button type="button" className="link-btn small" onClick={() => onOpenTicket(i.ticketId!)}>open ticket</button>
                      : i.state === "skipped" ? `Claude: ${i.note ?? "no ticket"}`
                      : i.state === "first" ? "already there when it started" : "seen before"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loop.lastFound > loop.lastItems.length && <div className="muted small">and {loop.lastFound - loop.lastItems.length} more</div>}
        </div>
      )}
      {loop && !loop.lastItems.length && loop.enabled && loop.state === "ok" && (
        <div className="auto-row">
          <span className="muted small">{loop.lastCheckedAt ? "The last check found nothing." : "The first check notes what is already there; it makes no tickets."}</span>
          <button type="button" className="btn small" disabled={!!busy} onClick={() => act("check", async () => { await onSaved(await api.checkLoop(slug, loop.id)); })}>
            {busy === "check" ? "Checking…" : "Check now"}
          </button>
        </div>
      )}

      <div className="auto-box">
        <label className="auto-check">
          <input type="checkbox" checked={askOn} onChange={(e) => setAskOn(e.target.checked)} />
          <span><b>Ask Claude first</b> <span className="muted small">Claude looks at each new item and decides whether it needs a ticket. It costs a little per new item; quiet checks cost nothing.</span></span>
        </label>
        {askOn ? (
          <textarea rows={3} value={askPrompt} onChange={(e) => setAskPrompt(e.target.value)} aria-label="What Claude should make tickets for"
            placeholder="e.g. Skip questions and duplicates. Make a ticket for bugs, with the steps to reproduce." />
        ) : (
          <label className="field">
            <span className="field-label">Ticket text</span>
            <textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} aria-label="Ticket text" />
            <span className="muted small">
              {"{{title}}"}, {"{{link}}"} and {"{{service}}"} are filled in. The item's own text is added below it, marked as copied from {svc}.
            </span>
          </label>
        )}
      </div>

      {err && <div className="form-error">{err}</div>}
      {note && <div className="muted small">{note}</div>}
      <div className="form-actions auto-foot">
        <span className="muted small">Only items that show up after it is switched on. One ticket per item.</span>
        {loop && otherBoards.length > 0 && (
          <Select<string> value="" ariaLabel="Copy to another board" options={otherBoards.map((b) => ({ value: b.slug, label: b.name }))}
            renderValue={() => "Copy to board…"}
            onChange={(to) => act("copy", async () => {
              await api.copyLoop(slug, loop.id, to);
              setNote(`Copied to ${otherBoards.find((b) => b.slug === to)?.name ?? to}, switched off. Switch it on there.`);
            })} />
        )}
        {loop && <button type="button" className="btn ghost danger" onClick={() => setConfirm(true)}>Delete</button>}
        <button type="submit" className="btn primary" disabled={!!busy || !name.trim() || !script.trim() || (column !== "backlog" && !autoStart)}>
          {busy === "save" ? "Saving…" : changed ? "Save this version" : "Save"}
        </button>
      </div>
      {confirm && loop && <DeleteLoop slug={slug} loop={loop} onCancel={() => setConfirm(false)} onDeleted={onDeleted} />}
    </form>
  );
}

function DeleteLoop({ slug, loop, onCancel, onDeleted }: { slug: string; loop: Loop; onCancel: () => void; onDeleted: () => void | Promise<void> }) {
  return (
    <ConfirmDialog title={`Delete ${loop.name}?`} confirmLabel="Delete" busyLabel="Deleting…" onCancel={onCancel}
      onConfirm={async () => {
        await api.deleteLoop(slug, loop.id);
        await onDeleted();
      }}>
      <p>It stops checking. Tickets it already made stay on the board.</p>
    </ConfirmDialog>
  );
}
