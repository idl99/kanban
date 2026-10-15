import { useEffect, useRef, useState } from "react";
import { api, safeHref, type BugBlock, type BugBlockId, type BugReportResult } from "./api";
import { ExternalIcon } from "./icons";
import { useImagePaste } from "./imagePaste";
import { AttachmentChips } from "./AttachmentChips";
import { ImagePickButton } from "./ImagePickButton";
import { Modal } from "./Modal";

const TEMPLATE = `**What happened**


**Steps to reproduce**
1.

**Expected**
`;

/**
 * Report a ckanban bug: the user's text plus context they can untick, filed as a GitHub issue
 * with gh. With a ticket, its details and last run log come along. Screenshots can't be uploaded by gh,
 * so the done view shows them with a tip to drag them into the issue.
 */
export function BugReportDialog({ ticket, onClose }: {
  ticket?: { profile: string; id: string; title: string } | null;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState(TEMPLATE);
  const [blocks, setBlocks] = useState<BugBlock[] | null>(null);
  const [include, setInclude] = useState<Set<BugBlockId>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<BugReportResult | null>(null);
  const images = useImagePaste(setDescription);
  const descRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.bugDraft(ticket ? { profile: ticket.profile, ticketId: ticket.id } : null)
      .then((d) => { setBlocks(d.blocks); setInclude(new Set(d.blocks.map((b) => b.id))); })
      .catch((e) => { setBlocks([]); setErr(e.message); });
  }, [ticket?.profile, ticket?.id]);

  const toggle = (id: BugBlockId) => setInclude((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy || images.uploading) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.reportBug({
        title: title.trim(), description, include: [...include],
        ...(ticket ? { profile: ticket.profile, ticketId: ticket.id } : {}),
      });
      setResult(r);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (result?.url) {
    return (
      <Modal title="Bug reported" onClose={onClose}>
        <div className="form">
          <p>Thanks! The issue is on GitHub:</p>
          <a className="bug-link" href={safeHref(result.url)} target="_blank" rel="noreferrer">{result.url} <ExternalIcon size={12} /></a>
          {result.screenshots.length > 0 && <Screenshots urls={result.screenshots} />}
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={ticket ? "Report a bug from this ticket" : "Report a bug"} onClose={onClose} wide
      guard={!busy && (!!title.trim() || description.trim() !== TEMPLATE.trim())}>
      <form className="form bug-form" onSubmit={submit}>
        <p className="muted small">
          Something wrong with ckanban? This opens an issue on GitHub for the maintainer. Check the text below first: it is posted publicly.
        </p>
        <label>
          Title
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What went wrong, in one line" maxLength={200} />
        </label>
        <label>
          Description
          <textarea ref={descRef} rows={9} value={description} onChange={(e) => setDescription(e.target.value)}
            className={images.dragOver ? "drop-target" : undefined} {...images.handlers}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e); }} />
          <AttachmentChips text={description} images={images} />
          {images.error && <span className="form-error">{images.error}</span>}
        </label>
        <div className="bug-pick">
          <ImagePickButton images={images} target={descRef} disabled={busy} />
          <span className="muted small">{images.uploading ? "Uploading…" : "Screenshots help. You can also paste or drop them into the description."}</span>
        </div>
        <div className="field">
          <div className="field-label">Included context</div>
          {blocks === null ? (
            <span className="muted small"><span className="spinner" /> Collecting…</span>
          ) : (
            <div className="bug-blocks">
              {blocks.map((b) => (
                <div key={b.id} className={`bug-block${include.has(b.id) ? "" : " off"}`}>
                  <input type="checkbox" checked={include.has(b.id)} onChange={() => toggle(b.id)} aria-label={`Include ${b.label}`} />
                  <details>
                    <summary>{b.label}</summary>
                    <pre>{b.text}</pre>
                  </details>
                </div>
              ))}
              <span className="muted small">Home and data folder paths and secret-looking values are hidden. Expand a row to see exactly what is sent.</span>
            </div>
          )}
        </div>
        {result && !result.url && (
          <div className="banner warn bug-fallback" role="alert">
            <span>{result.error}</span>
            <a className="btn small" href={safeHref(result.fallbackUrl)} target="_blank" rel="noreferrer">Open on GitHub instead <ExternalIcon size={12} /></a>
          </div>
        )}
        {result && !result.url && result.screenshots.length > 0 && <Screenshots urls={result.screenshots} />}
        {err && <div className="form-error">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !title.trim() || blocks === null || images.uploading}>
            {images.uploading ? "Uploading…" : busy ? "Reporting…" : "Report bug"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Screenshots({ urls }: { urls: string[] }) {
  return (
    <div className="bug-shots">
      <span className="muted small">
        {urls.length} screenshot{urls.length === 1 ? " was" : "s were"} not uploaded (GitHub doesn't accept images from the CLI).
        Open {urls.length === 1 ? "it" : "them"}, save, and drag into a comment on the issue:
      </span>
      <div className="bug-shot-list">
        {urls.map((u) => (
          <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="Screenshot" /></a>
        ))}
      </div>
    </div>
  );
}
