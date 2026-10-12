import { useEffect, useState } from "react";
import { setServerConfirm, type ServerConfirm } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Answers the daemon's "Start anyway?" questions: a run and a huddle about to work the same ticket at once (e.g. a
 * huddle started from Planning, then the ticket moved to Ready). Mounted once; api.ts resends on Start anyway.
 */
export function ParallelConfirm() {
  const [ask, setAsk] = useState<(ServerConfirm & { answer: (yes: boolean) => void }) | null>(null);
  useEffect(() => {
    // A second question while one is open: the earlier one counts as Cancel, so its caller doesn't wait forever.
    setServerConfirm((q) => new Promise<boolean>((resolve) => setAsk((prev) => (prev?.answer(false), { ...q, answer: resolve }))));
    return () => setServerConfirm(null);
  }, []);
  if (!ask) return null;
  const done = (yes: boolean) => { ask.answer(yes); setAsk(null); };
  const huddle = ask.kind === "huddle-open";
  return (
    <ConfirmDialog
      title={huddle ? "Start the run anyway?" : "Start the huddle anyway?"}
      confirmLabel="Start anyway" tone="primary" onConfirm={() => done(true)} onCancel={() => done(false)}>
      <p>{ask.message}</p>
      <p className="muted small">
        {huddle
          ? "The run and the huddle would work on the same thing at the same time. Usually it's better to let the huddle finish (or stop it) first."
          : "The huddle and the run would work on the same thing at the same time. Usually it's better to let the run finish first."}
      </p>
    </ConfirmDialog>
  );
}
