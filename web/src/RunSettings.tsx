import { api, type Profile, type Ticket } from "./api";
import { EFFORTS, MODELS } from "./models";
import { Select } from "./Select";

const NEXT_RUN = "applies from the next run";

/**
 * Model and effort for this ticket's next runs: small chips showing just the value, muted for the board's default
 * and highlighted when the ticket overrides it. The dropdowns still list "Board default (x)" and every option.
 */
export function RunSettings({ profile, ticket, onError }: { profile: Profile; ticket: Ticket; onError: (msg: string) => void }) {
  const slug = profile.slug;
  const save = (patch: { model?: string | null; effort?: string | null }) =>
    api.updateTicket(slug, ticket.id, patch).catch((e) => onError(`Not saved: ${e.message}`));
  const model = ticket.model ?? "";
  const effort = ticket.effort ?? "";
  const customModel = model && !MODELS.includes(model) ? model : null;
  return (
    <span className="run-settings">
      <RunChip label="Model" value={model} board={profile.model ?? null} onChange={(v) => save({ model: v || null })}
        options={[...MODELS, ...(customModel ? [customModel] : [])]} />
      <RunChip label="Effort" value={effort} board={profile.effort ?? null} onChange={(v) => save({ effort: v || null })}
        options={EFFORTS} />
    </span>
  );
}

function RunChip({ label, value, board, options, onChange }: {
  label: string;
  /** Set for this ticket, or "" for the board's default. */
  value: string;
  board: string | null;
  options: string[];
  onChange: (v: string) => void;
}) {
  const shown = value || board;
  const why = value ? `${label} set for this ticket` : `${label}: board default`;
  return (
    <span className="run-chip" title={`${why}, ${NEXT_RUN}`}>
      <Select className={value ? "chip-set" : ""} ariaLabel={`${label} for this ticket, ${NEXT_RUN}`} value={value} onChange={onChange}
        renderValue={() => shown ? <><span className="run-key">{label}</span>{shown}</> : `Default ${label.toLowerCase()}`}
        options={[
          { value: "", label: `Board default${board ? ` (${board})` : ""}` },
          ...options.map((o) => ({ value: o, label: o })),
        ]} />
    </span>
  );
}
