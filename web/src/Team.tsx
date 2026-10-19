import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { api, type HuddleNote, type HuddleNotes, type HuddlePreset, type HuddleTemplate, type Level, type TeamUsage } from "./api";
import { avatarColor, avatarLetter } from "./avatar";
import { Select } from "./Select";
import { TeamTemplates } from "./HuddleTemplates";
import { fullTime, timeAgo } from "./time";
import { plural, resetTitle, scopeChip, usageText } from "./teamText";
import type { TeammateEditRequest } from "./teammateText";
import { costText } from "./usage";

const MODELS = ["opus", "sonnet", "haiku"];
const ALL_ROLES = "_all";
const MAIN = "main";
const VIEW_KEY = "ckanban.team.view";

type View = "teammates" | "templates" | "notes";
type Draft = Pick<HuddlePreset, "name" | "role" | "prompt" | "model" | "mode" | "lead" | "canEdit" | "workspace">;
const EMPTY: Draft = { name: "", role: "", prompt: "", model: null, mode: "tagged", lead: false, canEdit: false, workspace: "shared" };

/** What Start huddle opens: a roster with one teammate, or a template. */
export type HuddleSeed = { preset: string } | { template: string };

export type UsageMap = Record<string, TeamUsage>;

/** What the Team tab is asked to show: the new-teammate editor, the editor prefilled (a proposal's Edit first), or a teammate. */
export type TeamRequest = { action: "new" } | ({ action: "edit" } & TeammateEditRequest) | { action: "open"; name: string };

/** Enter in these inputs must not submit anything around them. */
const noSubmit = (e: KeyboardEvent) => {
  if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) e.preventDefault();
};

/** A teammate's settings in plain words: "Wakes when @mentioned · reads only · sonnet · built-in". */
function metaText(p: HuddlePreset): string {
  const where = p.builtin ? "built-in" : p.source === "board" && !p.base ? "this board only" : "all boards";
  const changed = p.source === "board" && p.base ? "changed on this board" : p.source === "global" && p.builtin ? "changed for all boards" : null;
  if (p.name === MAIN) return ["The ticket's own session (@main)", p.mode === "tagged" ? "wakes when @mentioned" : "reads every message", where, changed].filter(Boolean).join(" · ");
  return [
    p.mode === "tagged" ? "Wakes when @mentioned" : "Reads every message",
    p.canEdit ? "changes files (own copy, hands them in)" : "reads only",
    p.lead && "lead: can add teammates",
    p.model ?? "board's model",
    where, changed,
  ].filter(Boolean).join(" · ");
}

export function TeammateAvatar({ name, big }: { name: string; big?: boolean }) {
  return <span className={`tm-av${big ? " big" : ""}`} style={{ background: avatarColor(name) }} aria-hidden>{avatarLetter(name)}</span>;
}

/**
 * The dock's Team tab: teammates (huddle role presets), templates and the notes every teammate gets, in one place.
 * Teammates are saved for all boards by default, or for this board only; a board's own version overrides the other.
 */
export function TeamTab({ slug, boardName, active, openTicket, request, onStartHuddle, onOpenHuddle }: {
  slug: string;
  boardName: string;
  /** The tab is visible: usage and lists refresh each time it is shown again. */
  active: boolean;
  /** The ticket open in the drawer: Start huddle goes there (else to a new ticket in Planning). */
  openTicket: { id: string; title: string } | null;
  /** `n` changes for each request. */
  request?: (TeamRequest & { n: number }) | null;
  onStartHuddle: (seed: HuddleSeed) => void;
  /** Open a ticket's Huddle tab (a huddle on this board). */
  onOpenHuddle?: (ticketId: string, huddleId?: string) => void;
}) {
  const [view, setView] = useState<View>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return v === "templates" || v === "notes" ? v : "teammates";
    } catch {
      return "teammates";
    }
  });
  const [filter, setFilter] = useState("");
  const [presets, setPresets] = useState<HuddlePreset[] | null>(null);
  const [templates, setTemplates] = useState<HuddleTemplate[] | null>(null);
  const [notes, setNotes] = useState<{ notes: HuddleNotes; cap: number } | null>(null);
  const [usage, setUsage] = useState<{ teammates: UsageMap; templates: UsageMap } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ draft: Draft; isNew: boolean; scope: Level; card?: TeammateEditRequest["card"] } | null>(null);
  /** Templates view: open the new-template editor; n changes per request. */
  const [newTemplate, setNewTemplate] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => setErr((e as Error).message);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {}
  }, [view]);

  const loadPresets = () => api.huddlePresets(slug).then(setPresets).catch(fail);
  const loadTemplates = () => api.huddleTemplates(slug).then(setTemplates).catch(fail);
  useEffect(() => {
    if (!active) return;
    loadPresets();
    loadTemplates();
    api.huddleNotes(slug).then(setNotes).catch(fail);
    api.teamUsage().then(setUsage).catch(() => setUsage((u) => u ?? { teammates: {}, templates: {} }));
  }, [slug, active]);

  const newTeammate = () => {
    setErr(null);
    setView("teammates");
    setEditing({ draft: { ...EMPTY }, isNew: true, scope: "global" });
  };
  useEffect(() => {
    if (!request) return;
    setErr(null);
    if (request.action === "new") return newTeammate();
    setView("teammates");
    setFilter("");
    if (request.action === "edit") return setEditing({ draft: { ...request.draft }, isNew: request.isNew, scope: request.scope, card: request.card });
    setEditing(null);
    setSelected(request.name);
    loadPresets();
  }, [request?.n]);

  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => (presets ?? []).filter((p) => !q || [p.name, p.role, p.prompt].some((s) => s.toLowerCase().includes(q))), [presets, q]);
  const shownTemplates = useMemo(() => (templates ?? []).filter((t) => !q || [t.name, t.label, t.description].some((s) => s.toLowerCase().includes(q))), [templates, q]);
  const cur = presets?.find((p) => p.name === selected) ?? shown[0] ?? null;
  const noteCount = (role: string) => (notes?.notes[role]?.general.length ?? 0) + (notes?.notes[role]?.repo.length ?? 0);
  const setRoleNotes = (role: string, scope: "general" | "repo", list: HuddleNote[]) =>
    setNotes((n) => n && { ...n, notes: { ...n.notes, [role]: { ...(n.notes[role] ?? { general: [], repo: [] }), [scope]: list } } });
  const saveNotes = async (role: string, scope: "general" | "repo", list: HuddleNote[]) => {
    setErr(null);
    try {
      setRoleNotes(role, scope, await api.setHuddleNotes(slug, role, scope, list));
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const startHint = openTicket ? `Starts on the open ticket “${openTicket.title}”.` : "No ticket open: a new one is created in Planning.";

  return (
    <div className="team">
      <div className="team-bar">
        <div className="segmented" role="tablist" aria-label="Team">
          {([["teammates", "Teammates", presets?.length], ["templates", "Templates", templates?.length], ["notes", "Notes for all", noteCount(ALL_ROLES)]] as const).map(([id, label, n]) => (
            <button key={id} role="tab" aria-selected={view === id} className={view === id ? "on" : undefined} onClick={() => { setView(id); setErr(null); }}>
              {label}{n !== undefined ? ` · ${n}` : ""}
            </button>
          ))}
        </div>
        {view !== "notes" && (
          <input className="team-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={view === "templates" ? "Filter templates…" : "Filter teammates…"}
            aria-label="Filter" onKeyDown={(e) => { if (e.key === "Escape" && filter) { e.stopPropagation(); setFilter(""); } }} />
        )}
        <span className="spacer" />
        {err && <span className="team-err" role="alert" title={err}>{err}</span>}
        {view === "teammates" && <button className="btn small ghost" onClick={newTeammate}>+ New teammate</button>}
        {view === "templates" && <button className="btn small ghost" onClick={() => setNewTemplate(Date.now())}>+ New template</button>}
      </div>

      {view === "teammates" && (
        <div className="team-body">
          <div className="tm-list" role="listbox" aria-label="Teammates">
            {presets === null && <div className="muted small tm-empty">Loading…</div>}
            {presets && !shown.length && <div className="muted small tm-empty">{q ? `No teammate matches “${filter.trim()}”.` : "No teammates yet."}</div>}
            {([["Built-in", shown.filter((p) => p.builtin)], ["Yours", shown.filter((p) => !p.builtin)]] as const).map(([title, list]) => list.length > 0 && (
              <div key={title} role="group" aria-label={title}>
                <div className="tm-grp">{title}</div>
                {list.map((p) => {
                  const chip = scopeChip(p);
                  const u = usage?.teammates[p.name];
                  const n = p.name === MAIN ? 0 : noteCount(p.name);
                  const on = cur?.name === p.name && !editing?.isNew;
                  return (
                    <div key={p.name} role="option" aria-selected={on} tabIndex={0} className={`tm-row${on ? " sel" : ""}`}
                      onClick={() => { setSelected(p.name); setEditing(null); setErr(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(p.name); setEditing(null); } }}>
                      <TeammateAvatar name={p.name} />
                      <span className="tm-names">
                        <span className="tm-name mono">{p.name}</span>
                        <span className="tm-role">{p.role}</span>
                        {chip && <span className={`tm-chip ${chip.tone}`}>{chip.text}</span>}
                      </span>
                      <span className="tm-stats" title={u?.lastUsed ? `Last used ${fullTime(u.lastUsed)} · counted on every board` : "Counted on every board"}>
                        {usage ? usageText(u) : ""}{n ? ` · ${plural(n, "note")}` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="tm-detail">
            {editing ? (
              <TeammateEditor key={editing.isNew ? "new" : editing.draft.name} slug={slug} boardName={boardName} {...editing}
                current={presets?.find((p) => p.name === editing.draft.name) ?? null}
                onCancel={() => setEditing(null)}
                onSaved={(p, scope) => {
                  // Saved from a proposal's Edit first: the chat card says so.
                  if (editing.card) api.answerTeammateCard(slug, editing.card.ticketId, editing.card.uuid, { state: "saved", name: p.name, scope }).catch(fail);
                  setEditing(null);
                  setSelected(p.name);
                  loadPresets();
                }} />
            ) : cur ? (
              <TeammateDetail key={cur.name} slug={slug} p={cur} usage={usage?.teammates[cur.name]} notes={notes} startHint={startHint}
                onEdit={() => { setErr(null); setEditing({ draft: draftOf(cur), isNew: false, scope: cur.source === "board" ? "board" : "global" }); }}
                onDelete={async () => {
                  setErr(null);
                  try {
                    setPresets((await api.deleteHuddlePreset(slug, cur.name, cur.source === "global" ? "global" : "board")).presets);
                  } catch (e) {
                    fail(e);
                  }
                }}
                onStart={() => onStartHuddle({ preset: cur.name })}
                onSaveNotes={(scope, list) => saveNotes(cur.name, scope, list)}
                onOpenHuddle={onOpenHuddle} />
            ) : (
              presets && <div className="muted small tm-empty">Pick a teammate.</div>
            )}
          </div>
        </div>
      )}

      {view === "templates" && (
        <div className="team-body single">
          <TeamTemplates slug={slug} templates={shownTemplates} loading={templates === null} filtered={!!q} presets={presets} usage={usage?.templates ?? null}
            startHint={startHint} newRequest={newTemplate} onChanged={loadTemplates} onError={setErr}
            onStart={(name) => onStartHuddle({ template: name })} />
        </div>
      )}

      {view === "notes" && (
        <div className="team-body single">
          <div className="team-notes">
            <p className="muted small">Added to every new teammate's instructions in a huddle, on top of its own notes. Lessons agents propose land here when you save them to “All roles”.</p>
            {!notes ? <span className="muted small">Loading…</span> : (
              <div className="hn-cols">
                {(["general", "repo"] as const).map((scope) => (
                  <NotesColumn key={scope} title={scope === "general" ? "All repos" : `This repo · ${boardName}`} notes={notes.notes[ALL_ROLES]?.[scope] ?? []} cap={notes.cap}
                    onSave={(list) => saveNotes(ALL_ROLES, scope, list)} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const draftOf = (p: HuddlePreset): Draft => ({ name: p.name, role: p.role, prompt: p.prompt, model: p.model, mode: p.mode, lead: p.lead, canEdit: p.canEdit, workspace: p.workspace });

function TeammateDetail({ slug, p, usage, notes, startHint, onEdit, onDelete, onStart, onSaveNotes, onOpenHuddle }: {
  slug: string;
  p: HuddlePreset;
  usage: TeamUsage | undefined;
  notes: { notes: HuddleNotes; cap: number } | null;
  startHint: string;
  onEdit: () => void;
  onDelete: () => void;
  onStart: () => void;
  onSaveNotes: (scope: "general" | "repo", list: HuddleNote[]) => Promise<boolean>;
  onOpenHuddle?: (ticketId: string, huddleId?: string) => void;
}) {
  const main = p.name === MAIN;
  const own = notes?.notes[p.name] ?? { general: [], repo: [] };
  const changed = p.source !== "builtin" || !!p.base;
  return (
    <div className="tm-pane">
      <div className="tm-head">
        <TeammateAvatar name={p.name} big />
        <h3>{p.role} <span className="tm-handle mono">@{p.name}</span></h3>
        <span className="spacer" />
        {p.source === "builtin" ? (
          <button className="btn small" onClick={onEdit} title="Make your own version of this built-in, for all boards or this board">Copy to customise</button>
        ) : (
          <button className="btn small" onClick={onEdit}>Edit</button>
        )}
        {changed && p.base && <button className="btn small ghost" onClick={onDelete} title={resetTitle(p)}>Reset</button>}
        {changed && !p.base && <button className="btn small ghost danger" onClick={onDelete}>Delete</button>}
        {!main && <button className="btn small primary" onClick={onStart} title={startHint}>Start huddle with @{p.name}</button>}
      </div>
      {!main && <div className="tm-hint">{startHint}</div>}
      <div className="tm-meta">{metaText(p)}</div>
      <div>
        <div className="tm-fld">Prompt</div>
        <div className="tm-prompt">{p.prompt}</div>
      </div>
      {!main && (
        <div>
          <div className="tm-fld">Notes <span className="tm-hint">(added to every new @{p.name}, past the first {notes?.cap ?? 30} per column they stop)</span></div>
          {!notes ? <span className="muted small">Loading…</span> : (
            <div className="hn-cols">
              {(["general", "repo"] as const).map((scope) => (
                <NotesColumn key={scope} title={scope === "general" ? "All repos" : `This repo · ${slug}`} notes={own[scope]} cap={notes.cap} onSave={(list) => onSaveNotes(scope, list)} />
              ))}
            </div>
          )}
        </div>
      )}
      <div>
        <div className="tm-fld">Recent huddles {usage?.huddles ? <span className="tm-hint">({plural(usage.huddles, "huddle")}, {costText(usage.costUsd)} in all)</span> : null}</div>
        {!usage?.recent.length ? <span className="muted small">Not in a huddle yet.</span> : (
          <ul className="tm-recent">
            {usage.recent.map((r) => {
              const here = r.board === slug;
              const label = r.title ?? r.ticket;
              return (
                <li key={`${r.board}/${r.huddle}`}>
                  {here && onOpenHuddle ? <button className="link-btn" onClick={() => onOpenHuddle(r.ticket, r.huddle)} title="Open this huddle">{label}</button> : <span>{label}</span>}
                  {!here && <span className="tm-hint"> · {r.board}</span>}
                  <span className="tm-hint"> · <time dateTime={r.at} title={fullTime(r.at)}>{timeAgo(r.at)}</time> · {costText(r.costUsd)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Add a teammate or change one; saved for all boards (default) or this board only. */
function TeammateEditor({ slug, boardName, draft: initial, isNew, scope: initialScope, current, onCancel, onSaved }: {
  slug: string;
  boardName: string;
  draft: Draft;
  isNew: boolean;
  scope: Level;
  /** The teammate as it is now (null: a new one). */
  current: HuddlePreset | null;
  onCancel: () => void;
  onSaved: (p: HuddlePreset, scope: Level) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [scope, setScope] = useState<Level>(initialScope);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const main = draft.name === MAIN;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      onSaved(await api.saveHuddlePreset(slug, draft, scope), scope);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const scopeNote = scope === "global" && current?.source === "board"
    ? `Replaces this board's own version; other boards keep theirs.`
    : scope === "board" ? `Only ${boardName} uses this version.` : "Every board uses it unless a board has its own version.";
  return (
    <div className="tm-pane tm-edit form" onKeyDown={noSubmit}>
      <div className="tm-head">
        {draft.name ? <TeammateAvatar name={draft.name} big /> : <span className="tm-av big" aria-hidden>+</span>}
        <h3>{isNew ? "New teammate" : current?.source === "builtin" ? `Customise @${draft.name}` : `Edit @${draft.name}`}</h3>
      </div>
      <div className="row two">
        <label>
          Handle
          <input className="mono" value={draft.name} onChange={(e) => set({ name: e.target.value })} disabled={!isNew} placeholder="a11y" spellCheck={false} autoFocus={isNew} />
        </label>
        <label>
          Label
          <input value={draft.role} onChange={(e) => set({ role: e.target.value })} placeholder="Accessibility tester" />
        </label>
      </div>
      <label>
        Prompt
        <textarea rows={4} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder="What this teammate does in a huddle: what to look at, how to report." />
      </label>
      {main ? (
        <span className="muted small">The coordinator is the ticket's own session (@main): only its label, mode and prompt apply.</span>
      ) : (
        <div className="row two">
          <label>
            Model
            <Select ariaLabel="Model" value={draft.model ?? ""} onChange={(v) => set({ model: v || null })}
              options={[{ value: "", label: "Board default" }, ...MODELS.map((m) => ({ value: m, label: m })),
                ...(draft.model && !MODELS.includes(draft.model) ? [{ value: draft.model, label: draft.model }] : [])]} />
          </label>
          <label>
            Files
            <Select ariaLabel="Files" value={draft.canEdit ? "change" : "read"}
              onChange={(v) => set(v === "change" ? { canEdit: true, workspace: "own" } : { canEdit: false, workspace: "shared" })}
              options={[
                { value: "read", label: "Reads only", hint: "for reviews: looks, doesn't change" },
                { value: "change", label: "Changes files", hint: "in its own copy of the folder; hands the changes in" },
              ]} />
          </label>
        </div>
      )}
      <div className="row two">
        <label>
          Wakes
          <Select ariaLabel="Mode" value={draft.mode} onChange={(v) => set({ mode: v })}
            options={[{ value: "tagged", label: "When @mentioned", hint: "sleeps until tagged" }, { value: "monitor", label: "On every message", hint: "reads everything" }]} />
        </label>
        {!main && (
          <div className="hp-checks">
            <label className="check-row"><input type="checkbox" checked={draft.lead} onChange={(e) => set({ lead: e.target.checked })} /> Lead (can add teammates)</label>
          </div>
        )}
      </div>
      <div className="tm-scope">
        <span className="small">Use on</span>
        <div className="segmented" role="radiogroup" aria-label="Use on">
          {([["global", "All boards"], ["board", "This board"]] as const).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={scope === v} className={scope === v ? "on" : undefined} onClick={() => setScope(v)}>{label}</button>
          ))}
        </div>
        <span className="muted small">{scopeNote}</span>
      </div>
      {err && <div className="form-error">{err}</div>}
      <div className="form-actions">
        <div className="spacer" />
        <button type="button" className="btn ghost small" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn primary small" onClick={save} disabled={busy || !draft.name.trim() || !draft.prompt.trim()}>
          {busy ? "Saving…" : isNew ? "Add teammate" : "Save teammate"}
        </button>
      </div>
    </div>
  );
}

const today = () => new Date().toISOString().slice(0, 10);
const shortDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const noteSource = (n: HuddleNote) => [n.by === "you" ? "by you" : `from @${n.by}`, n.date && shortDate(n.date)].filter(Boolean).join(", ");

/** One notes file (all repos, or this repo): newest first; past the cap the oldest stop going into instructions. */
export function NotesColumn({ title, notes, cap, onSave }: { title: string; notes: HuddleNote[]; cap: number; onSave: (list: HuddleNote[]) => Promise<boolean> }) {
  /** The line being edited (index; -1: a new one at the top) and its text. */
  const [edit, setEdit] = useState<{ at: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (list: HuddleNote[]) => {
    setBusy(true);
    const ok = await onSave(list);
    setBusy(false);
    if (ok) setEdit(null);
  };
  const commit = () => {
    if (!edit) return;
    const text = edit.text.trim();
    if (!text) return setEdit(null);
    if (edit.at < 0) return save([{ text, by: "you", date: today(), huddle: null }, ...notes]);
    if (text === notes[edit.at].text) return setEdit(null);
    save(notes.map((n, i) => (i === edit.at ? { ...n, text } : n)));
  };
  const input = (
    <input value={edit?.text ?? ""} autoFocus disabled={busy} maxLength={400} aria-label="Note" placeholder="A rule, e.g. Give every bug a repro command."
      onChange={(e) => setEdit((x) => x && { ...x, text: e.target.value })} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.stopPropagation(); setEdit(null); }
      }} />
  );
  return (
    <div className="hn-col">
      <div className="hn-col-head">
        <h4>{title}</h4>
        <span className={`hn-cap${notes.length > cap ? " over" : ""}`}>{notes.length} / {cap} lines</span>
        <span className="spacer" />
        {!edit && <button type="button" className="btn small ghost link" onClick={() => setEdit({ at: -1, text: "" })} disabled={busy}>+ Add note</button>}
      </div>
      {edit?.at === -1 && <div className="hn-edit">{input}</div>}
      {!notes.length && edit?.at !== -1 && <span className="muted small">No notes yet.</span>}
      <ul>
        {notes.map((n, i) => (
          <li key={i} className={i >= cap ? "past-cap" : undefined} title={i >= cap ? "Past the cap: not added to instructions" : undefined}>
            {edit?.at === i ? input : (
              <>
                <span className="hn-text">{n.text}</span> <span className="hn-src">{noteSource(n)}</span>
                <span className="hn-acts">
                  <button type="button" className="link-btn" onClick={() => setEdit({ at: i, text: n.text })} disabled={busy || !!edit}>edit</button>
                  <button type="button" className="link-btn danger" onClick={() => save(notes.filter((_, j) => j !== i))} disabled={busy || !!edit}
                    aria-label={`Delete note: ${n.text}`}>delete</button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
