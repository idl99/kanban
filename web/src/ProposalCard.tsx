import { useState } from "react";
import { KeyHint } from "./KeyHint";
import { MOD } from "./Shortcuts";
import { Markdown } from "./Transcript";

/**
 * A proposal on a ticket that already ran (Done, In review, or ran before): it becomes a new linked ticket, so the
 * original keeps its title and description. state: how the note names the original ("Done", "In review", null: it ran).
 * created: the follow-up made from this proposal.
 */
export interface FollowUp {
  state: string | null;
  created?: { id: string; title: string };
  onCreate: (start: boolean) => Promise<void>;
  onOpen: (id: string) => void;
}

/** Claude's proposed title/description; Apply replaces the ticket's fields, Apply & start work also moves it to Ready. */
export function ProposalCard({ proposal, applied, started, onApply, onApplyStart, keyHint, followUp }: {
  proposal: { title: string; description: string };
  applied: boolean;
  /** Applied with "Apply & start work" in this session. */
  started?: boolean;
  onApply: () => Promise<void>;
  /** Set when the ticket can start from here (Backlog/Planning, Claude idle). */
  onApplyStart?: () => Promise<void>;
  /** The newest unapplied proposal: ⌘⇧Enter in the panel applies this one (and starts work when it can). */
  keyHint?: boolean;
  /** Set on a ticket that already ran: the card offers a follow-up first (see FollowUp). */
  followUp?: FollowUp;
}) {
  const [busy, setBusy] = useState<"apply" | "start" | null>(null);
  const [open, setOpen] = useState(true);
  const run = (kind: "apply" | "start", fn: () => Promise<void>) => async () => {
    setBusy(kind);
    try { await fn(); } finally { setBusy(null); }
  };
  const hint = keyHint ? `${MOD}⇧Enter` : null;
  if (followUp && !applied) return <FollowUpCard {...{ proposal, followUp, open, setOpen, busy, run, onApply, keyHint, hint }} />;
  return (
    <div className={`proposal ${applied ? "applied" : ""}`}>
      <div className="proposal-head">
        <span className="proposal-tag">Proposed ticket</span>
        <button className="link-btn" onClick={() => setOpen((o) => !o)}>{open ? "Collapse" : "Expand"}</button>
      </div>
      {proposal.title && <div className="proposal-title">{proposal.title}</div>}
      {open && proposal.description && <div className="proposal-body"><Markdown text={proposal.description} /></div>}
      <div className="proposal-actions">
        {applied ? (
          <span className="badge ok">{started ? "Applied · moved to Ready" : "Applied to ticket"}</span>
        ) : onApplyStart ? (
          <>
            <button className="btn primary small" disabled={!!busy} title={hint ? `Apply & start work (${hint})` : undefined}
              onClick={run("start", onApplyStart)}>
              {busy === "start" ? "Starting…" : "Apply & start work"}{keyHint && <KeyHint keys="⌘⇧↵" />}
            </button>
            <button className="btn small" disabled={!!busy} onClick={run("apply", onApply)}>
              {busy === "apply" ? "Applying…" : "Apply only"}
            </button>
          </>
        ) : (
          <button className="btn primary small" disabled={!!busy} title={hint ? `Apply to ticket (${hint})` : undefined}
            onClick={run("apply", onApply)}>
            {busy === "apply" ? "Applying…" : "Apply to ticket"}{keyHint && <KeyHint keys="⌘⇧↵" />}
          </button>
        )}
        <span className="muted small">
          {applied
            ? started ? "Claude starts when a slot is free." : "You can still edit them in the details."
            : onApplyStart
              ? "Replaces the title and description. Start work moves it to Ready; Claude works on its own."
              : "Replaces the title and description. You can undo right after."}
        </span>
      </div>
    </div>
  );
}

function FollowUpCard({ proposal, followUp, open, setOpen, busy, run, onApply, keyHint, hint }: {
  proposal: { title: string; description: string }; followUp: FollowUp; open: boolean; setOpen: (f: (o: boolean) => boolean) => void;
  busy: "apply" | "start" | null; run: (kind: "apply" | "start", fn: () => Promise<void>) => () => Promise<void>;
  onApply: () => Promise<void>; keyHint?: boolean; hint: string | null;
}) {
  const { created } = followUp;
  return (
    <div className={`proposal ${created ? "applied" : ""}`}>
      <div className="proposal-head">
        <span className="proposal-tag">Proposed follow-up ticket</span>
        <button className="link-btn" onClick={() => setOpen((o) => !o)}>{open ? "Collapse" : "Expand"}</button>
      </div>
      {proposal.title && <div className="proposal-title">{proposal.title}</div>}
      {open && proposal.description && <div className="proposal-body"><Markdown text={proposal.description} /></div>}
      {created ? (
        <div className="proposal-actions">
          <span className="badge ok">Follow-up created</span>
          <button className="link-btn ticket-link" onClick={() => followUp.onOpen(created.id)}>Open “{created.title}” →</button>
        </div>
      ) : (
        <>
          <div className="proposal-note">
            {followUp.state ? `This ticket is ${followUp.state}.` : "This ticket already ran."} A follow-up keeps its title and description as they are.
          </div>
          <div className="proposal-actions">
            <button className="btn primary small" disabled={!!busy} title={hint ? `Create follow-up & start work (${hint})` : undefined}
              onClick={run("start", () => followUp.onCreate(true))}>
              {busy === "start" ? "Creating…" : "Create follow-up & start work"}{keyHint && <KeyHint keys="⌘⇧↵" />}
            </button>
            <button className="btn small" disabled={!!busy} onClick={run("apply", () => followUp.onCreate(false))}>
              {busy === "apply" ? "Creating…" : "Create follow-up"}
            </button>
            <button className="btn ghost small" disabled={!!busy} title="Replaces this ticket's title and description; you can undo right after"
              onClick={run("apply", onApply)}>
              Replace this ticket instead
            </button>
          </div>
          <span className="muted small">Creates a new ticket linked to this one. Start work moves it to Ready; Claude works on its own.</span>
        </>
      )}
    </div>
  );
}
