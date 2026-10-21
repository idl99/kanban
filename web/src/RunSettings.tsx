import { api, type Profile, type Ticket } from "./api";
import { EFFORTS, MODELS } from "./models";
import { Select } from "./Select";

/** Model and effort for this ticket's next runs: header chips, highlighted when the ticket overrides the board. */
export function RunSettings({ profile, ticket, onError }: { profile: Profile; ticket: Ticket; onError: (msg: string) => void }) {
  const slug = profile.slug;
  const save = (patch: { model?: string | null; effort?: string | null }) =>
    api.updateTicket(slug, ticket.id, patch).catch((e) => onError(`Not saved: ${e.message}`));
  const model = ticket.model ?? "";
  const effort = ticket.effort ?? "";
  const customModel = model && !MODELS.includes(model) ? model : null;
  return (
    <div className="panel-run-settings">
      <span className="run-chip">
        <span className="muted small">Model</span>
        <Select className={model ? "chip-set" : ""} ariaLabel="Model for this ticket" value={model} onChange={(v) => save({ model: v || null })}
          options={[
            { value: "", label: `Board default${profile.model ? ` (${profile.model})` : ""}` },
            ...MODELS.map((m) => ({ value: m, label: m })),
            ...(customModel ? [{ value: customModel, label: customModel }] : []),
          ]} />
      </span>
      <span className="run-chip">
        <span className="muted small">Effort</span>
        <Select className={effort ? "chip-set" : ""} ariaLabel="Reasoning effort for this ticket" value={effort} onChange={(v) => save({ effort: v || null })}
          options={[
            { value: "", label: `Board default${profile.effort ? ` (${profile.effort})` : ""}` },
            ...EFFORTS.map((e) => ({ value: e, label: e })),
          ]} />
      </span>
      <span className="muted small">Applies from the next run</span>
    </div>
  );
}
