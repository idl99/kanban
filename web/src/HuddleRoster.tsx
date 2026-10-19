import { useEffect, useState, type KeyboardEvent } from "react";
import { api, type Huddle, type HuddleMode, type HuddlePreset, type HuddleTemplate, type RosterEntry, type Ticket } from "./api";
import { CloseIcon } from "./icons";
import { Select } from "./Select";
import { applyProposedTemplate, applyTemplate, DEFAULT_MAX, draftError, draftSize, dollars, handleBase, rosterDraft, rowHandle, rowKey as key, type Draft } from "./huddleText";

const MODELS = ["opus", "sonnet", "haiku"];
const MAX_COUNT = 8;

export type RosterRow = RosterEntry & { key: string };
export type RosterDraft = Draft<RosterEntry, HuddleMode>;
export { applyProposedTemplate, applyTemplate, DEFAULT_MAX, draftError, draftSize, rosterDraft, rowHandle };

/** The board's teammates (null while loading); a new `reload` value fetches them again. */
export function usePresets(slug: string, reload: unknown = 0): HuddlePreset[] | null {
  const [presets, setPresets] = useState<HuddlePreset[] | null>(null);
  useEffect(() => {
    let live = true;
    api.huddlePresets(slug).then((p) => live && setPresets(p), () => live && setPresets([]));
    return () => {
      live = false;
    };
  }, [slug, reload]);
  return presets;
}

/** The board's whole-huddle templates (null while loading). */
export function useTemplates(slug: string): HuddleTemplate[] | null {
  const [templates, setTemplates] = useState<HuddleTemplate[] | null>(null);
  useEffect(() => {
    let live = true;
    api.huddleTemplates(slug).then((t) => live && setTemplates(t), () => live && setTemplates([]));
    return () => {
      live = false;
    };
  }, [slug]);
  return templates;
}

/** Start the huddle a draft describes: create it (with its template's rules), invite the tickets, set @main's mode. */
export async function startFromDraft(slug: string, ticketId: string, d: RosterDraft): Promise<Huddle> {
  const roster = d.rows.map(({ key: _k, ...e }) => ({ ...e, ...(e.focus?.trim() ? { focus: e.focus.trim() } : { focus: undefined }) }));
  let h = await api.startHuddle(slug, ticketId, roster, undefined, d.maxCostUsd, d.template ?? undefined);
  for (const t of d.invites) await api.inviteToHuddle(slug, h.id, t);
  const main = h.participants.find((p) => p.handle === "main");
  if (d.mainMode && main && main.mode !== d.mainMode) h = await api.setHuddleMode(slug, h.id, "main", d.mainMode);
  return h;
}

/** A template's rules in one line: "2 rounds · $20 budget · report format". */
export const templateRules = (t: HuddleTemplate) =>
  [t.rounds && `${t.rounds} round${t.rounds === 1 ? "" : "s"}`, t.maxCostUsd && `${dollars(t.maxCostUsd)} budget`, t.report && "report format"].filter(Boolean).join(" · ");

/** Start from a template: fills in its roster and budget; its rules become the huddle's pinned brief. */
export function TemplatePicker({ templates, draft, setDraft, disabled }: {
  templates: HuddleTemplate[] | null;
  draft: RosterDraft;
  setDraft: (d: RosterDraft) => void;
  disabled?: boolean;
}) {
  if (!templates?.length) return null;
  const cur = templates.find((t) => t.name === draft.template);
  return (
    <div className="roster-template">
      <Select ariaLabel="Template" className="roster-select" value={draft.template ?? ""}
        renderValue={() => (cur ? `Template: ${cur.label}` : "No template")}
        options={[{ value: "", label: "No template", hint: "your own roster" },
          ...templates.map((t) => ({ value: t.name, label: t.label, hint: `${t.roster.length} roles${templateRules(t) ? ` · ${templateRules(t)}` : ""}` }))]}
        onChange={(v) => !disabled && setDraft(applyTemplate(draft, templates.find((t) => t.name === v) ?? null))} />
      {cur && (
        <span className="muted small" title={cur.report ? `Report format: ${cur.report}` : undefined}>
          {cur.description}{templateRules(cur) ? ` (${templateRules(cur)}; the rules become the huddle's pinned brief)` : ""}
        </span>
      )}
    </div>
  );
}

const MODE_OPTIONS = [
  { value: "tagged" as const, label: "tagged", hint: "sleeps until @mentioned" },
  { value: "monitor" as const, label: "monitor", hint: "gets every message" },
];

/** Roster table: role, count, mode, model and focus per line; add and remove roles; invite tickets. */
export function RosterEditor({ presets, draft, setDraft, tickets, hostId, max = DEFAULT_MAX, onEnter, disabled, hideMain }: {
  presets: HuddlePreset[] | null;
  draft: RosterDraft;
  setDraft: (d: RosterDraft) => void;
  /** The board's tickets (to invite). */
  tickets: Ticket[];
  hostId: string;
  max?: number;
  /** Enter in a text field (starts the huddle). */
  onEnter?: () => void;
  disabled?: boolean;
  /** Adding to a running huddle: no @main line, no participant count. */
  hideMain?: boolean;
}) {
  const byName = new Map((presets ?? []).map((p) => [p.name, p]));
  const main = byName.get("main");
  const setRow = (k: string, patch: Partial<RosterEntry>) => setDraft({ ...draft, rows: draft.rows.map((r) => (r.key === k ? { ...r, ...patch } : r)) });
  const size = draftSize(draft);
  const enter = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing && onEnter) {
      e.preventDefault();
      onEnter();
    }
  };
  const addRole = (name: string) => {
    const row: RosterRow = name === "__custom" ? { key: key(), role: "", count: 1 } : { key: key(), preset: name, count: 1 };
    setDraft({ ...draft, rows: [...draft.rows, row] });
  };
  const invitable = tickets.filter((t) => t.id !== hostId && !draft.invites.includes(t.id));
  const hosted = draft.rows.some((r) => r.host);
  // One host per huddle: picking a row clears the others; picking it again clears it.
  const setHost = (k: string) => setDraft({ ...draft, rows: draft.rows.map((r) => ({ ...r, host: r.key === k ? !r.host || undefined : undefined })) });
  return (
    <div className="roster">
      <table className="roster-table">
        <thead>
          <tr><th>Role</th><th>#</th><th>Mode</th><th>Model</th><th>Focus</th><th aria-label="Remove" /></tr>
        </thead>
        <tbody>
          {!hideMain && <tr>
            <td>
              <b>@main</b> <span className="pill lead">{hosted ? "ticket's session" : "coordinator"}</span>
              <div className="roster-desc">this ticket's session · {hosted ? "woken for decisions and the host's final report" : "only one who edits code"}</div>
            </td>
            <td className="roster-num">1</td>
            <td>
              <Select ariaLabel="@main mode" className="roster-select" value={draft.mainMode ?? main?.mode ?? "tagged"} options={MODE_OPTIONS}
                onChange={(v) => setDraft({ ...draft, mainMode: v })} />
            </td>
            <td><span className="pill">current</span></td>
            <td className="roster-desc">Fixes what the team reports</td>
            <td />
          </tr>}
          {draft.rows.map((r) => {
            const p = r.preset ? byName.get(r.preset) : undefined;
            const lead = r.host || (r.lead ?? p?.lead);
            const edits = r.canEdit ?? p?.canEdit ?? (r.workspace ?? p?.workspace) === "own";
            const count = r.count ?? 1;
            const handle = rowHandle(r);
            return (
              <tr key={r.key}>
                <td>
                  {r.preset ? (
                    <b>@{handle}{count > 1 && <span className="muted">-1…{count}</span>}</b>
                  ) : (
                    <input className="roster-role" value={r.role ?? ""} placeholder="Role, e.g. Accessibility tester" disabled={disabled} autoFocus={!r.role}
                      onChange={(e) => setRow(r.key, { role: e.target.value })} onKeyDown={enter} aria-label="Role" />
                  )}
                  {lead && !r.host && <> <span className="pill lead">lead</span></>}
                  {!hideMain && count === 1 && (lead || r.host) && (
                    <> <button type="button" className={`pill ${r.host ? "host" : "host-off"}`} disabled={disabled} aria-pressed={!!r.host}
                      title={r.host ? "Runs the huddle instead of @main. Click to let @main run it." : "Make this lead the host: it runs the huddle, so @main is only woken for decisions and the final report"}
                      onClick={() => setHost(r.key)}>{r.host ? "host" : "make host"}</button></>
                  )}
                  <div className="roster-desc">
                    {r.preset ? `preset: ${p?.role ?? r.preset}` : "custom role"}
                    {lead ? " · can add agents" : ""}
                    {edits ? " · changes files (own copy)" : ""}
                  </div>
                </td>
                <td>
                  <input className="roster-count" type="number" min={1} max={MAX_COUNT} value={count} disabled={disabled} aria-label="How many"
                    onChange={(e) => setRow(r.key, { count: Math.max(1, Math.min(MAX_COUNT, Math.round(Number(e.target.value) || 1))) })} onKeyDown={enter} />
                </td>
                <td>
                  <Select ariaLabel="Mode" className="roster-select" value={r.mode ?? p?.mode ?? "tagged"} options={MODE_OPTIONS}
                    onChange={(v) => setRow(r.key, { mode: v })} />
                </td>
                <td>
                  <Select ariaLabel="Model" className="roster-select" value={r.model ?? ""}
                    onChange={(v) => setRow(r.key, { model: v || null })}
                    options={[{ value: "", label: p?.model ?? "default" }, ...MODELS.filter((m) => m !== p?.model).map((m) => ({ value: m, label: m })),
                      ...(r.model && !MODELS.includes(r.model) ? [{ value: r.model, label: r.model }] : [])]} />
                </td>
                <td>
                  <input className="roster-focus" value={r.focus ?? ""} placeholder="What to look at" disabled={disabled} aria-label="Focus"
                    onChange={(e) => setRow(r.key, { focus: e.target.value })} onKeyDown={enter} />
                </td>
                <td>
                  <button className="icon-btn tiny" aria-label={`Remove ${handle}`} title="Remove" disabled={disabled}
                    onClick={() => setDraft({ ...draft, rows: draft.rows.filter((x) => x.key !== r.key) })}><CloseIcon size={11} /></button>
                </td>
              </tr>
            );
          })}
          {draft.invites.map((id) => {
            const t = tickets.find((x) => x.id === id);
            return (
              <tr key={id}>
                <td colSpan={5}>
                  <b>Ticket</b> {t?.title ?? id}
                  <div className="roster-desc">invited: its own session joins as @{handleBase(`${t?.planKey || t?.title.split(/\s+/)[0] || "ticket"}-main`)}</div>
                </td>
                <td>
                  <button className="icon-btn tiny" aria-label="Remove invite" title="Remove" disabled={disabled}
                    onClick={() => setDraft({ ...draft, invites: draft.invites.filter((x) => x !== id) })}><CloseIcon size={11} /></button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="roster-foot">
        {!hideMain && <span className={size > max ? "roster-over" : undefined}>{size} participant{size === 1 ? "" : "s"} · max {max}</span>}
        {!hideMain && (
          <label className="roster-budget" title="The huddle stops when its runs have spent this much; the leads are warned at 80%">
            · budget $<input type="number" min={1} step={1} value={draft.maxCostUsd} disabled={disabled} aria-label="Budget in USD"
              onChange={(e) => setDraft({ ...draft, maxCostUsd: Number(e.target.value) })} onKeyDown={enter} />
          </label>
        )}
        <Select ariaLabel="Add a role" className="roster-add" value={"" as string} renderValue={() => "+ Role"}
          options={[...(presets ?? []).filter((p) => p.name !== "main").map((p) => ({ value: p.name, label: p.role, hint: p.name })),
            { value: "__custom", label: "Custom role…" }]}
          onChange={addRole} />
        {invitable.length > 0 && (
          <Select ariaLabel="Invite a ticket" className="roster-add" value={"" as string} renderValue={() => "+ Invite ticket"} menuMaxHeight={260}
            options={invitable.map((t) => ({ value: t.id, label: t.title, hint: t.id }))}
            onChange={(id) => setDraft({ ...draft, invites: [...draft.invites, id] })} />
        )}
      </div>
    </div>
  );
}
