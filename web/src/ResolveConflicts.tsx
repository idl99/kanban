import { useState } from "react";
import { api, type Ticket } from "./api";
import { toast } from "./toast";

/** "Resolve conflicts" next to a PR's conflict chip: asks the ticket's Claude to rebase onto the base branch and push. */
export function ResolveConflicts({ slug, ticket, onError, small }: { slug: string; ticket: Ticket; onError: (msg: string) => void; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const running = !!ticket.running || ticket.status === "in_progress";
  const click = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await api.prResolveConflicts(slug, ticket.id);
      toast("Asked Claude to resolve the conflicts.");
    } catch (err: any) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className={`btn primary${small ? " small pr-resolve" : " small"}`} disabled={busy || running} onClick={click}
      onKeyDown={(e) => e.stopPropagation()}
      title={running ? "Claude is already working on this ticket" : "Ask Claude to rebase onto the base branch, resolve the conflicts, run the checks and push"}>
      {busy ? "Sending…" : "Resolve conflicts"}
    </button>
  );
}
