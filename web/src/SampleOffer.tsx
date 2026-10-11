import { useRef, useState } from "react";
import { api, type Ticket } from "./api";
import { CloseIcon } from "./icons";
import { toast } from "./toast";

/** The one sample ticket offered on a brand-new first board: read-only, so it is safe to try. */
export const SAMPLE_TICKET = {
  title: "Explain this repo's structure in a short report",
  body: [
    "Read this project and write a short report on how it is put together. Do not change any files: no edits, commits, branches or pull requests.",
    "",
    "Save it as `report.md` in this ticket's outputs folder, covering:",
    "- What the project does, in two or three sentences",
    "- The main folders and files and what each is for",
    "- How to install, run and test it",
    "- Where a newcomer should start reading",
  ].join("\n"),
};

/** After the first board is created: offer the sample ticket with a Start button. Dismissable. */
export function SampleOffer({ slug, onStarted, onDismiss }: {
  slug: string;
  onStarted: (t: Ticket) => void;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const starting = useRef(false);
  const start = async () => {
    if (starting.current) return;
    starting.current = true;
    setBusy(true);
    try {
      const t = await api.createTicket(slug, { ...SAMPLE_TICKET, status: "in_progress", mode: "auto" });
      onStarted(t);
    } catch (e) {
      toast(`Couldn't start the sample ticket: ${(e as Error).message}`, { tone: "error" });
      starting.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="banner info sample-offer" role="status">
      <span>
        <b>Try a first ticket:</b> “{SAMPLE_TICKET.title}”. It runs on its own; Claude is asked only to read the code and change nothing.
      </span>
      <button className="btn primary small" disabled={busy} onClick={start}>{busy ? "Starting…" : "Start"}</button>
      <button className="icon-btn" aria-label="Dismiss" title="No thanks" onClick={onDismiss}><CloseIcon size={12} /></button>
    </div>
  );
}
