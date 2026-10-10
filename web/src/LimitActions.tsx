import { useState } from "react";
import { api, type Ticket } from "./api";

/** "Continue now" and "Don't auto-continue" / "Auto-continue" for a ticket waiting on the usage limit. */
export function LimitActions({ slug, ticket, onError, small }: { slug: string; ticket: Ticket; onError: (msg: string) => void; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<unknown>) => async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await fn();
    } catch (err: any) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const auto = !!ticket.limit?.auto;
  const size = small ? " small" : "";
  return (
    <div className="limit-actions" onKeyDown={(e) => e.stopPropagation()}>
      <button className={`btn primary${size}`} disabled={busy} onClick={run(() => api.limitContinue(slug, ticket.id))}
        title="Send “continue” to Claude now">Continue now</button>
      {ticket.limit && (
        <button className={`btn${size}`} disabled={busy} onClick={run(() => api.limitAuto(slug, ticket.id, !auto))}
          title={auto ? "Wait for you instead of continuing at the reset" : "Send “continue” once the limit resets"}>
          {auto ? "Don't auto-continue" : "Auto-continue"}
        </button>
      )}
    </div>
  );
}
