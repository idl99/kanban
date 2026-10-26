import { useEffect, useState } from "react";
import { api, type SessionEntry } from "./api";
import { filesLine, laterLine, noFilesLine, rewindOff, type Change } from "./rewindText";

type Preview = { blocked: string | null; files: Change[] | null; filesReason: "no-history" | "no-snapshot" | null };

/**
 * Rewind on one of the user's messages: a pill on hover, and an inline confirmation under the message that says
 * what goes away. Going back cuts the chat before the message and, when asked, puts the project files back.
 */
export function Rewind({ slug, ticketId, entry, later, running, queued, onDone, onError }: {
  slug: string;
  ticketId: string;
  entry: SessionEntry;
  /** Messages after this one that would be removed. */
  later: number;
  running: boolean;
  queued: number;
  /** The rewind happened: the message's text goes back to the chat box. */
  onDone: (text: string) => void;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const off = rewindOff(running, queued);

  useEffect(() => {
    if (off) setOpen(false);
  }, [off]);
  useEffect(() => {
    if (!open) return;
    setPreview(null);
    let live = true;
    api.rewindPreview(slug, ticketId, entry.uuid).then((p) => live && setPreview(p), (e) => {
      if (!live) return;
      setOpen(false);
      onError(e.message);
    });
    return () => {
      live = false;
    };
  }, [open, slug, ticketId, entry.uuid]);

  const go = async (files: boolean) => {
    setBusy(true);
    try {
      const r = await api.rewind(slug, ticketId, entry.uuid, files);
      onDone(r.text);
    } catch (e: any) {
      onError(e.message);
      setBusy(false);
    }
  };

  const canFiles = !!preview?.files?.length;
  return (
    <>
      <button className={`rewind-pill${open ? " open" : ""}`} disabled={!!off} title={off ?? "Go back to before this message"}
        onClick={() => setOpen((o) => !o)}>
        ⟲ Rewind
      </button>
      {open && (
        <div className="rewind-confirm" role="group" aria-label="Rewind">
          <b>Go back to before this message?</b>
          {!preview ? <div className="muted small">Checking what would change…</div> : (
            <>
              <ul>
                <li>{laterLine(later)}</li>
                <li>{preview.files ? filesLine(preview.files) : noFilesLine(preview.filesReason)}</li>
              </ul>
              {canFiles && <div className="rewind-warn">Files you edited yourself since then are also reset.</div>}
              <div className="rewind-actions">
                <button className="btn small primary" disabled={busy} onClick={() => go(canFiles)}>
                  {canFiles ? "Rewind chat and files" : "Rewind chat"}
                </button>
                {canFiles && <button className="btn small" disabled={busy} onClick={() => go(false)}>Chat only</button>}
                <button className="btn small" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
