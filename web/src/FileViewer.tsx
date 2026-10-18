import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { api, copy, type FileRootName, type TicketFile } from "./api";
import { formatSize } from "./attachText";
import { fileFinder, FileLinkContext, type FileLinks } from "./fileLinkContext";
import { CheckIcon, CloseIcon, CopyIcon } from "./icons";
import { useLayer } from "./layers";
import { withFit } from "./Outputs";
import { PdfView } from "./PdfView";
import { baseName, HTML, IMAGE, MARKDOWN } from "./share";
import { Markdown } from "./Transcript";
import { usePhone } from "./usePhone";

const PDF = /\.pdf$/i;

const WHERE: Record<FileRootName, string> = {
  ticket: "this ticket's copy of the folder",
  project: "the project folder",
  outputs: "Outputs",
};

/**
 * Gives the ticket's Markdown (chat, description, comments) chips for the files it mentions, and shows a tapped one
 * full screen over the ticket panel. Read only.
 */
export function FileLinksProvider({ slug, ticketId, panel, children }: {
  slug: string;
  ticketId: string;
  panel: RefObject<HTMLElement>;
  children: React.ReactNode;
}) {
  const [viewing, setViewing] = useState<string | null>(null);
  const links = useMemo<FileLinks>(() => ({
    find: fileFinder(async (paths) => Object.keys((await api.findFiles(slug, ticketId, paths)).found)),
    open: setViewing,
  }), [slug, ticketId]);
  useEffect(() => setViewing(null), [slug, ticketId]);
  return (
    <FileLinkContext.Provider value={links}>
      {children}
      {viewing && createPortal(
        <FileViewer key={viewing} slug={slug} ticketId={ticketId} path={viewing} onClose={() => setViewing(null)} />,
        panel.current ?? document.body,
      )}
    </FileLinkContext.Provider>
  );
}

function FileViewer({ slug, ticketId, path, onClose }: { slug: string; ticketId: string; path: string; onClose: () => void }) {
  const [file, setFile] = useState<TicketFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const phone = usePhone();
  const pushed = useRef(false);

  useEffect(() => {
    api.ticketFile(slug, ticketId, path).then(setFile).catch((e) => setError(e.message));
  }, [slug, ticketId, path]);

  const close = () => (pushed.current ? history.back() : onClose());
  useLayer(close, { skipInInputs: true });
  // On a phone the Back gesture closes the file, not the ticket.
  useEffect(() => {
    if (!phone) return;
    history.pushState({ ckFileViewer: true }, "");
    pushed.current = true;
    const onPop = () => { pushed.current = false; onClose(); };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (pushed.current && history.state?.ckFileViewer) history.back();
      pushed.current = false;
    };
  }, [phone]);

  const name = baseName(path);
  const kind = IMAGE.test(name) ? "image" : PDF.test(name) ? "pdf" : HTML.test(name) ? "html" : MARKDOWN.test(name) ? "md" : "text";
  const raw = api.ticketFileUrl(slug, ticketId, path);
  const download = api.ticketFileUrl(slug, ticketId, path, true);
  const text = file?.content ?? null;
  const folder = file ? file.path.split("/").slice(0, -1).join("/") : "";

  const noPreview = file && (
    <div className="output-binary muted">
      {file.tooLarge ? `This file is too big to show here (${formatSize(file.size)}).` : "This file can't be shown here."}{" "}
      <a href={download} download={name}>Download it</a>
      {!phone && file.root === "project" && (
        <> or <button className="link-btn" onClick={() => void api.openFile(slug, file.path).catch((e) => setError(e.message))}>open it on this computer</button></>
      )}
      .
    </div>
  );

  return (
    <div className={`output-view reader file-viewer${kind === "html" || kind === "pdf" ? ` ${kind}` : ""}`} role="dialog" aria-label={name}>
      <div className="output-bar">
        <button className="output-back" onClick={close} aria-label="Close"><CloseIcon size={14} /></button>
        <span className="output-bar-name" title={path}>{name}</span>
        {text !== null && (
          <button className="btn small" onClick={() => void copy(text).then((ok) => { setCopied(ok); setTimeout(() => setCopied(false), 1500); })}>
            {copied ? <><CheckIcon size={12} /> Copied</> : <><CopyIcon size={12} /> Copy</>}
          </button>
        )}
      </div>
      <div className="output-body">
        {error ? <div className="banner error inline" role="alert">Couldn't open this file: {error}</div>
          : !file ? <div className="muted">Loading…</div>
          : kind === "image" ? <div className="output-image"><img src={raw} alt={name} /></div>
          : kind === "pdf" ? <PdfView url={raw} name={name} downloadUrl={download} />
          : text === null ? noPreview
          : kind === "html" ? <iframe className="output-html" sandbox="allow-scripts" srcDoc={withFit(text)} title={`Preview of ${name}`} />
          : kind === "md" ? <Markdown text={text} />
          : <pre>{text}</pre>}
      </div>
      {file && (
        <div className="file-viewer-where muted small" title={`${file.dir}/${file.path}`}>
          {folder ? `${folder} · ` : ""}in {WHERE[file.root]} · read only
        </div>
      )}
    </div>
  );
}
