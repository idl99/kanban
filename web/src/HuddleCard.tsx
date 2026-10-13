import { useEffect, useState } from "react";
import type { Huddle, RosterEntry, Ticket } from "./api";
import { formKey } from "./drafts";
import { dollars } from "./huddleText";
import { applyProposedTemplate, draftError, RosterEditor, rosterDraft, startFromDraft, TemplatePicker, usePresets, useTemplates, type RosterDraft } from "./HuddleRoster";
import { usePersistentState } from "./usePersistentState";

/**
 * Claude proposed a huddle (propose_huddle). The roster is editable until Start; nothing runs before that.
 * `huddle`: the ticket's current huddle, to tell whether this proposal was started.
 */
export function HuddleCard({ slug, ticket, tickets, uuid, at, roster, reason, template, maxCostUsd, huddle, old, onOpen, onError }: {
  slug: string;
  ticket: Ticket;
  tickets: Ticket[];
  uuid: string;
  at: string;
  roster: RosterEntry[];
  reason: string;
  /** Template Claude proposed (its roster when `roster` is empty, its budget and rules). */
  template?: string;
  /** Budget Claude proposed (already capped); wins over the template's. */
  maxCostUsd?: number;
  huddle: Huddle | null;
  /** Copied history of a branched ticket: read-only. */
  old?: boolean;
  onOpen: () => void;
  onError: (m: string) => void;
}) {
  const presets = usePresets(slug);
  const templates = useTemplates(slug);
  const [draft, setDraft] = useState<RosterDraft>(() => rosterDraft(roster, maxCostUsd));
  // The proposed template, once the board's templates are in: its roster and budget, unless Claude gave them.
  useEffect(() => {
    const t = template && templates?.find((x) => x.name === template);
    if (t) setDraft((d) => (d.template ? d : applyProposedTemplate(d, t, roster, maxCostUsd)));
  }, [templates, template]);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = usePersistentState(formKey(slug, ticket.id, `huddle-${uuid}`), () => false, (v) => !v, (v) => typeof v === "boolean");
  const started = !!huddle && huddle.createdAt >= at;
  const otherOpen = !!huddle && !started && huddle.status !== "closed";
  const err = draftError(draft);
  // Started: what the huddle actually got; otherwise what Claude proposed.
  const budget = started ? huddle!.maxCostUsd : maxCostUsd;

  const start = async () => {
    if (busy || err || started || otherOpen) return;
    setBusy(true);
    try {
      await startFromDraft(slug, ticket.id, draft);
      onOpen();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (dismissed && !started) {
    return (
      <div className="huddle-card-dismissed muted small">
        Huddle proposal dismissed · <button className="link-btn" onClick={() => setDismissed(false)}>Show</button>
      </div>
    );
  }
  return (
    <div className={`huddle-card${started ? " started" : ""}`}>
      <div className="huddle-card-head">
        <span>🗣 {started ? "Huddle started" : "Proposed huddle"}</span>
        <small>{started ? `${huddle!.participants.length - 1} participants` : "you can edit before starting"}</small>
      </div>
      {reason && <div className="huddle-card-reason">{reason}</div>}
      {started || old ? (
        <div className="huddle-card-summary muted small">
          {roster.length ? roster.map((r) => `${r.count && r.count > 1 ? `${r.count}× ` : ""}${r.handle ?? r.preset ?? r.role}`).join(" · ") : `template ${template}`}
          {budget != null && ` · budget ${dollars(budget)}`}
        </div>
      ) : (
        <>
          <TemplatePicker templates={templates} draft={draft} setDraft={setDraft} disabled={busy} />
          <RosterEditor presets={presets} draft={draft} setDraft={setDraft} tickets={tickets} hostId={ticket.id} onEnter={start} disabled={busy} />
        </>
      )}
      <div className="huddle-card-actions">
        {started ? (
          <>
            <span className={`badge ${{ live: "ok", stopped: "blocked", closed: "stopped" }[huddle!.status]}`}>{{ live: "Live", stopped: "Stopped", closed: "Closed" }[huddle!.status]}</span>
            <span className="spacer" />
            <button className="btn small" onClick={onOpen}>Open huddle</button>
          </>
        ) : old ? (
          <span className="muted small">From the conversation this ticket was branched from.</span>
        ) : (
          <>
            <span className="muted small">{otherOpen ? "This ticket already has an open huddle." : err ?? "Nothing runs until you start."}</span>
            <span className="spacer" />
            {otherOpen && <button className="btn small" onClick={onOpen}>Open huddle</button>}
            <button className="btn small" onClick={() => setDismissed(true)} disabled={busy}>Dismiss</button>
            <button className="btn primary small" onClick={start} disabled={busy || !!err || otherOpen || presets === null}>
              {busy ? "Starting…" : "Start huddle"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
