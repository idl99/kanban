import { useState } from "react";
import { api, type Ticket } from "./api";
import { capStep } from "./capText";
import { costText } from "./usage";

/** "Continue with +$Y" for a ticket whose run stopped at its spending cap: "continue" with a cap of $Y for that run. */
export function CapActions({ slug, ticket, onError, small }: { slug: string; ticket: Ticket; onError: (msg: string) => void; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const step = capStep(ticket);
  const go = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await api.capContinue(slug, ticket.id, step);
    } catch (err: any) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="limit-actions" onKeyDown={(e) => e.stopPropagation()}>
      <button className={`btn primary${small ? " small" : ""}`} disabled={busy} onClick={go}
        title={`Send “continue” to Claude; this run may spend up to ${costText(step)} more`}>Continue with +{costText(step)}</button>
    </div>
  );
}
