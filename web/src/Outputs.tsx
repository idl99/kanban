import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, copy, isArtifactLink, safeHref, subscribe, type OutputFile, type Ticket, type TicketLink } from "./api";
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, CopyIcon, ExternalIcon, FileCodeIcon, FileIcon, FileImageIcon, FileTextIcon, FolderIcon, FolderOpenIcon, LinkIcon } from "./icons";
import { fullTime, timeAgo } from "./time";
import { useNow } from "./useNow";
import { Markdown } from "./Transcript";
import { baseName, BINARY, dragFile, HTML, IMAGE, MARKDOWN } from "./share";
import { ShareMenu } from "./ShareMenu";
import { useLayer } from "./layers";
import { usePhone } from "./usePhone";

function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** Show the filter once the list gets long. */
const FILTER_MIN = 10;

/** Folder paths containing a file: "a/b/c.png" -> ["a", "a/b"]. */
const ancestors = (path: string) => path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"));

interface Folder { path: string; name: string; folders: Folder[]; files: OutputFile[]; count: number }

function buildTree(files: OutputFile[]): Folder {
  const root: Folder = { path: "", name: "", folders: [], files: [], count: 0 };
  const byPath = new Map([["", root]]);
  for (const f of files) {
    let dir = root;
    for (const p of ancestors(f.name)) {
      let next = byPath.get(p);
      if (!next) {
        next = { path: p, name: baseName(p), folders: [], files: [], count: 0 };
        byPath.set(p, next);
        dir.folders.push(next);
      }
      dir = next;
    }
    dir.files.push(f);
  }
  const sort = (d: Folder): number => {
    d.folders.sort((a, b) => a.name.localeCompare(b.name));
    d.files.sort((a, b) => baseName(a.name).localeCompare(baseName(b.name)));
    d.count = d.files.length + d.folders.reduce((n, s) => n + sort(s), 0);
    return d.count;
  };
  sort(root);
  return root;
}

/** Files in the order the tree shows them: each folder's subfolders first, then its files. */
function flatten(d: Folder): string[] {
  return [...d.folders.flatMap(flatten), ...d.files.map((f) => f.name)];
}

/** Keep in step with the `@container (max-width: 640px)` rules for .outputs in styles.css. */
const NARROW = 640;

function fileIcon(name: string) {
  if (IMAGE.test(name) || /\.svg$/i.test(name)) return <FileImageIcon />;
  if (HTML.test(name)) return <FileCodeIcon />;
  if (BINARY.test(name)) return <FileIcon />;
  return <FileTextIcon />;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Claude-written HTML only ever runs in an opaque-origin frame (sandbox without allow-same-origin), so it can't
 * reach the board's API. A new tab gets a script-free page on a blob URL that wraps the same sandboxed frame.
 */
function openInTab(name: string, html: string) {
  const page = `<!doctype html><meta charset="utf-8"><title>${escapeAttr(name)}</title>`
    + `<style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style>`
    + `<iframe sandbox="allow-scripts" srcdoc="${escapeAttr(html)}"></iframe>`;
  const url = URL.createObjectURL(new Blob([page], { type: "text/html" }));
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Where a link came from, as the row's tag; the ticket's own publishes need none. */
function sourceTag(l: TicketLink): string | null {
  if (l.source.startsWith("huddle:")) return "huddle";
  if (l.source === "share") return "share link";
  if (l.source === "result") return "result";
  return null;
}

function linkMeta(l: TicketLink): string {
  if (l.source === "share") return "share link";
  if (l.source.startsWith("huddle:")) return `claude.ai artifact · by ${l.source.slice("huddle:".length)} in huddle`;
  if (l.source === "result") return "claude.ai artifact · from the result summary";
  return "claude.ai artifact";
}

/** The ticket's artifacts and share links (newest first), the newest artifact highlighted. Hidden when there are none. */
function Links({ links }: { links: TicketLink[] }) {
  const [copied, setCopied] = useState(false);
  const shown = links.filter((l) => safeHref(l.url));
  if (!shown.length) return null;
  const top = shown.find(isArtifactLink);
  const rest = shown.filter((l) => l !== top);
  return (
    <section className="output-links" aria-label="Links">
      <h4 className="output-section">Links</h4>
      {top && (
        <div className="link-row latest">
          <span className="link-icon" aria-hidden>★</span>
          <span className="link-text">
            <span className="link-label" title={top.url}>{top.label}</span>
            <span className="muted small" title={fullTime(top.at)}>{linkMeta(top)} · latest · updated {timeAgo(top.at)}</span>
          </span>
          {sourceTag(top) && <span className="link-src">{sourceTag(top)}</span>}
          <a className="btn primary small" href={safeHref(top.url)} target="_blank" rel="noreferrer">Open <ExternalIcon size={12} /></a>
          <button className="btn small" onClick={() => copy(top.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
            {copied ? <><CheckIcon size={12} /> Copied</> : <><CopyIcon size={12} /> Copy link</>}
          </button>
        </div>
      )}
      {rest.map((l) => (
        <div key={l.url} className="link-row">
          <span className="link-icon" aria-hidden>{isArtifactLink(l) ? "◆" : <LinkIcon size={13} />}</span>
          <span className="link-text">
            <span className="link-label" title={l.url}>{l.label}</span>
            <span className="muted small" title={fullTime(l.at)}>{linkMeta(l)} · {timeAgo(l.at)}</span>
          </span>
          {sourceTag(l) && <span className="link-src">{sourceTag(l)}</span>}
          <a className="btn small" href={safeHref(l.url)} target="_blank" rel="noreferrer">Open <ExternalIcon size={12} /></a>
        </div>
      ))}
    </section>
  );
}

/**
 * Deliverables Claude saved in the ticket's outputs folder; markdown is rendered, images and HTML previewed, other text shown raw.
 * The ticket's artifacts and share links sit above them.
 */
export function Outputs({ slug, ticket, onCount, focus }: {
  slug: string;
  ticket: Ticket;
  onCount?: (n: number) => void;
  /** File to show first (path relative to outputs), e.g. a mockup clicked in the chat. */
  focus?: string | null;
}) {
  const ticketId = ticket.id;
  const [files, setFiles] = useState<OutputFile[] | null>(null);
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  // Narrow (phone or a narrow panel): the list fills the tab and a tapped file opens in a full-height reader.
  const [box, setBox] = useState<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [reading, setReading] = useState(!!focus);
  const phone = usePhone();
  const pushed = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useNow();

  useEffect(() => {
    const el = box?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width <= NARROW));
    ro.observe(el);
    return () => ro.disconnect();
  }, [box]);

  const load = () => api.outputs(slug, ticketId).then((fs) => {
    setError(null);
    setFiles(fs);
    onCount?.(fs.length);
    setOpen((cur) => (cur && fs.some((f) => f.name === cur) ? cur : null) ?? fs.find((f) => MARKDOWN.test(f.name))?.name ?? fs[0]?.name ?? null);
  }).catch((e) => {
    setError(e.message);
    setFiles((f) => f ?? []);
  });

  useEffect(() => { load(); }, [slug, ticketId]);
  useEffect(() => subscribe((e) => {
    if ((e.type === "ticket.updated" && e.profile === slug && e.ticket.id === ticketId)
      || (e.type === "session.updated" && e.profile === slug && e.id === ticketId)) load();
  }), [slug, ticketId]);

  const current = files?.find((f) => f.name === open);
  const kind = !open ? null : IMAGE.test(open) ? "image" : BINARY.test(open) ? "binary" : HTML.test(open) ? "html" : "text";
  useEffect(() => {
    setText(null);
    if (!open || (kind !== "text" && kind !== "html")) return;
    api.outputText(slug, ticketId, open).then(setText).catch((e) => setText(`Could not load: ${e.message}`));
  }, [slug, ticketId, open, kind, current?.updatedAt]);

  const needle = filter.trim().toLowerCase();
  const shown = useMemo(() => (files && needle ? files.filter((f) => f.name.toLowerCase().includes(needle)) : files ?? []), [files, needle]);
  const tree = useMemo(() => buildTree(shown), [shown]);
  // The selected file's folders always stay open; while filtering every match is visible.
  const forcedOpen = useMemo(() => new Set(open ? ancestors(open) : []), [open]);
  const isOpen = (path: string) => !!needle || forcedOpen.has(path) || !collapsed.has(path);
  const toggle = (path: string) => setCollapsed((c) => {
    const next = new Set(c);
    if (isOpen(path)) next.add(path); else next.delete(path);
    return next;
  });

  const readerOn = narrow && reading && !!open && !!files?.some((f) => f.name === open);
  const order = useMemo(() => flatten(tree), [tree]);
  const at = open ? order.indexOf(open) : -1;
  const closeReader = () => (pushed.current ? history.back() : setReading(false));
  useLayer(closeReader, { active: readerOn, skipInInputs: true });
  // On a phone the Back gesture closes the reader, not the ticket: the reader gets its own history entry.
  useEffect(() => {
    if (!readerOn || !phone) return;
    history.pushState({ ckOutputsReader: true }, "");
    pushed.current = true;
    const onPop = () => { pushed.current = false; setReading(false); };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (pushed.current && history.state?.ckOutputsReader) history.back();
      pushed.current = false;
    };
  }, [readerOn, phone]);
  useEffect(() => { bodyRef.current?.scrollTo(0, 0); }, [open]);
  const pick = (name: string) => { setOpen(name); setReading(true); };
  const stepFile = (by: number) => { if (at >= 0) setOpen(order[(at + by + order.length) % order.length]); };

  const links = ticket.links ?? [];
  const shared = new Set(ticket.shareLinks?.map((l) => l.file));
  const withLinks = (body: React.ReactNode) => !links.some((l) => safeHref(l.url)) ? body : (
    <>
      <Links links={links} />
      <h4 className="output-section">Files</h4>
      {body}
    </>
  );
  if (files === null) return withLinks(<div className="muted"><span className="spinner" /> Loading…</div>);
  if (error && !files.length) {
    return withLinks(
      <div className="banner error inline load-error" role="alert">
        Couldn't load the outputs: {error} <button className="link-btn" onClick={load}>Retry</button>
      </div>,
    );
  }
  if (!files.length) return withLinks(<div className="muted">No output files yet. Research and writing tasks save their report here.</div>);

  const pad = (depth: number) => ({ paddingLeft: 8 + depth * 14 });
  const renderFolder = (d: Folder, depth: number): React.ReactNode => (
    <>
      {d.folders.map((s) => (
        <div key={s.path} role="none">
          <button className="tree-row" style={pad(depth)} title={s.path} role="treeitem" aria-expanded={isOpen(s.path)}
            disabled={!!needle || forcedOpen.has(s.path)} onClick={() => toggle(s.path)}>
            <span className="tree-caret" aria-hidden>{isOpen(s.path) ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} />}</span>
            <span className="tree-icon" aria-hidden>{isOpen(s.path) ? <FolderOpenIcon /> : <FolderIcon />}</span>
            <span className="tree-dir output-name">{s.name}</span>
            <span className="output-count muted small">{s.count}</span>
          </button>
          {isOpen(s.path) && <div role="group">{renderFolder(s, depth + 1)}</div>}
        </div>
      ))}
      {d.files.map((f) => (
        <div key={f.name} className={`output-row${f.name === open ? " selected" : ""}`} role="none">
          <button className={`tree-row output-file${f.name === open ? " selected" : ""}`} style={pad(depth)} title={f.name}
            role="treeitem" aria-selected={f.name === open} onClick={() => pick(f.name)}
            draggable onDragStart={(e) => dragFile(e, slug, ticketId, f.name)}>
            <span className="tree-caret" aria-hidden />
            <span className="tree-icon" aria-hidden>{fileIcon(f.name)}</span>
            <span className="output-label">
              <span className="output-name">{baseName(f.name)}</span>
              <span className="output-meta muted" title={fullTime(f.updatedAt)}>
                {kb(f.size)} · {timeAgo(f.updatedAt)}
                {shared.has(f.name) && <span className="link-src" title="Published as a claude.ai page from the Share menu">shared</span>}
              </span>
            </span>
            {narrow && <span className="output-chev muted" aria-hidden><ChevronRightIcon size={12} /></span>}
          </button>
          <ShareMenu slug={slug} ticket={ticket} name={f.name} variant="dots" text={f.name === open ? text : undefined} />
        </div>
      ))}
    </>
  );

  const rawUrl = open ? api.outputUrl(slug, ticketId, open) : "";
  const binaryNote = (
    <div className="output-binary muted">
      Binary file, {kb(current?.size ?? 0)}, no preview. <a href={rawUrl} target="_blank" rel="noreferrer">Open raw</a>
    </div>
  );

  const view = (
    <div className={`output-view${kind === "html" ? " html" : ""}${readerOn ? " reader" : ""}`} role={readerOn ? "dialog" : undefined} aria-label={readerOn ? baseName(open ?? "") : undefined}>
      {open && (
        <div className="output-bar">
          {readerOn && <button className="output-back" onClick={closeReader}><ChevronLeftIcon size={14} /> Files</button>}
          <span className="output-bar-name" title={ticket.outputDir ? `${ticket.outputDir}/${open}` : open}>{baseName(open)}</span>
          {kind === "html" && (
            <button className="link-btn small" disabled={text === null} onClick={() => text !== null && openInTab(open, text)}>Open in new tab</button>
          )}
          <ShareMenu slug={slug} ticket={ticket} name={open} variant="button" text={kind === "text" || kind === "html" ? text : undefined} />
        </div>
      )}
      <div className="output-body" ref={bodyRef}>
      {kind === "html" ? (
        text === null ? <div className="muted output-html-note">Loading…</div>
          : <iframe className="output-html" sandbox="allow-scripts" srcDoc={text} title={`Preview of ${open}`} />
      ) : kind === "image" ? (
        <div className="output-image"><img src={`${rawUrl}?v=${encodeURIComponent(current?.updatedAt ?? "")}`} alt={open ?? ""} /></div>
      ) : kind === "binary" ? binaryNote
        : text === null ? <div className="muted">Loading…</div>
        : text.slice(0, 8000).includes("\0") ? binaryNote
        : open && MARKDOWN.test(open) ? <Markdown text={text} />
        : <pre>{text.length > 200_000 ? text.slice(0, 200_000) + "\n…(truncated)" : text}</pre>}
      </div>
      {readerOn && at >= 0 && order.length > 1 && (
        <div className="output-pager">
          <button className="link-btn" onClick={() => stepFile(-1)}><ChevronLeftIcon size={12} /> Previous</button>
          <span className="muted small">{at + 1} of {order.length}</span>
          <button className="link-btn" onClick={() => stepFile(1)}>Next <ChevronRightIcon size={12} /></button>
        </div>
      )}
    </div>
  );
  // Over the whole ticket panel, so the header, banner and tabs make room for the file.
  const panel = box?.closest<HTMLElement>(".panel") ?? document.body;

  return withLinks(
    <div className={`outputs${narrow ? " narrow" : ""}`} ref={setBox}>
      <div className="output-side">
        {files.length > FILTER_MIN && (
          <div className="file-filter">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter outputs…" aria-label="Filter outputs"
              onKeyDown={(e) => { if (e.key === "Escape" && filter) { e.preventDefault(); e.stopPropagation(); setFilter(""); } }} />
            {filter && <button className="search-clear" aria-label="Clear filter" onClick={() => setFilter("")}><CloseIcon size={12} /></button>}
          </div>
        )}
        <nav className="file-tree output-files" aria-label="Outputs" role="tree">
          {shown.length ? renderFolder(tree, 0) : <div className="tree-note muted small">No matches</div>}
        </nav>
        {"chrome" in window && <div className="output-hint muted">Tip: drag a file into Slack or Finder</div>}
      </div>
      {!narrow && view}
      {readerOn && createPortal(view, panel)}
    </div>,
  );
}
