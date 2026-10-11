import { useState } from "react";
import { api, type Ticket } from "./api";

/** The run went silent: still running, but it needs the user's call. */
export const stallWait = (t: Pick<Ticket, "stalled" | "running">): boolean => !!t.stalled && !!t.running;

/** "Stop", "Keep waiting" and "Restart" for a stalled run (no output for the board's stall time). */
export function StallActions({ slug, ticket, onError, small }: { slug: string; ticket: Ticket; onError: (msg: string) => void; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = (action: "stop" | "wait" | "restart") => async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await api.stall(slug, ticket.id, action);
    } catch (err: any) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const size = small ? " small" : "";
  return (
    <div className="limit-actions" onKeyDown={(e) => e.stopPropagation()}>
      <button className={`btn primary${size}`} disabled={busy} onClick={run("restart")}
        title="Stop the stuck process and continue in the same session">Restart</button>
      <button className={`btn${size}`} disabled={busy} onClick={run("wait")}
        title="It may just be a long step: ask again after another stall period">Keep waiting</button>
      <button className={`btn${size}`} disabled={busy} onClick={run("stop")} title="Stop the run">Stop</button>
    </div>
  );
}
