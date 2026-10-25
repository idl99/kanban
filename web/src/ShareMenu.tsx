import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { safeHref, type Ticket } from "./api";
import { ChevronDownIcon, ClipIcon, CopyIcon, DownloadIcon, FolderOpenIcon, HashIcon, LinkIcon, MoreIcon, RefreshIcon } from "./icons";
import { useLayer } from "./layers";
import { MenuSheet } from "./MenuSheet";
import {
  baseName, canPublish, copyFile, copyFormatted, copySource, copyText, downloadFile, isText, MARKDOWN, publishFile, revealFile,
} from "./share";
import { timeAgo } from "./time";

const MENU_WIDTH = 340;

/**
 * Share menu for one output file: send it as a file, paste it as text, publish a claude.ai link, or copy where it is.
 * Opens from the "Share" button above the preview or the "⋯" on a file row. The popover is fixed-positioned so the
 * file list's scroll box doesn't clip it,
 * and portalled to the body so a transformed drawer doesn't offset it.
 */
export function ShareMenu({ slug, ticket, name, text, variant }: {
  slug: string;
  ticket: Ticket;
  /** Path relative to the outputs folder. */
  name: string;
  /** The file's text when the preview already loaded it. */
  text?: string | null;
  variant: "button" | "dots";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  useLayer(() => close(), { active: open });

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const left = Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    // Open upwards only when there is clearly more room above.
    setPos(below >= 320 || below >= above
      ? { top: r.bottom + 6, left, maxHeight: below }
      : { top: Math.max(8, r.top - 6 - Math.min(above, 560)), left, maxHeight: Math.min(above, 560) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus());
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onScroll);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const list = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") { e.preventDefault(); go(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(at - 1); }
  };
  const pick = (fn: () => unknown) => () => { close(false); fn(); };

  const id = ticket.id;
  const job = ticket.shareJobs?.find((j) => j.file === name);
  const link = ticket.shareLinks?.find((l) => l.file === name);
  const publishing = job?.state === "publishing";
  const path = ticket.outputDir ? `${ticket.outputDir}/${name}` : name;
  const textFile = isText(name);

  return (
    <div className={`share-wrap ${variant}`} ref={root} onClick={(e) => e.stopPropagation()}>
      {variant === "button" ? (
        <button ref={button} className="btn primary small share-btn" aria-haspopup="menu" aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}>
          Share <ChevronDownIcon size={11} />
        </button>
      ) : (
        <button ref={button} className={`icon-btn share-dots${open ? " on" : ""}`} aria-haspopup="menu" aria-expanded={open}
          aria-label={`Share ${baseName(name)}`} title="Share" onClick={() => (open ? close() : setOpen(true))}>
          <MoreIcon size={14} />
        </button>
      )}
      {open && createPortal(
        <MenuSheet onClose={() => close(false)}>
          <div className="share-menu" role="menu" aria-label={`Share ${baseName(name)}`} ref={menu} onKeyDown={onKey}
            style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { visibility: "hidden" }}>
            <div className="menu-heading">Send as file</div>
            {ticket.canCopyFile && (
              <button role="menuitem" className="menu-item" onClick={pick(() => copyFile(slug, id, name))}>
                <span className="menu-icon" aria-hidden><ClipIcon size={14} /></span>
                <span className="menu-label">Copy file<small>Paste into Slack, email or Finder with ⌘V</small></span>
              </button>
            )}
            <button role="menuitem" className="menu-item" onClick={pick(() => downloadFile(slug, id, name))}>
              <span className="menu-icon" aria-hidden><DownloadIcon size={14} /></span>
              <span className="menu-label">Download</span>
            </button>
            <button role="menuitem" className="menu-item" onClick={pick(() => revealFile(slug, id, name))}>
              <span className="menu-icon" aria-hidden><FolderOpenIcon size={14} /></span>
              <span className="menu-label">Show in Finder</span>
            </button>

            {textFile && (
              <>
                <div className="menu-heading">Paste as text</div>
                {canPublish(name) && (
                  <button role="menuitem" className="menu-item" onClick={pick(() => copyFormatted(slug, id, name, text))}>
                    <span className="menu-icon" aria-hidden><CopyIcon size={14} /></span>
                    <span className="menu-label">Copy formatted<small>Slack, Notion, Docs keep headings and lists</small></span>
                  </button>
                )}
                <button role="menuitem" className="menu-item" onClick={pick(() => copySource(slug, id, name, text))}>
                  <span className="menu-icon" aria-hidden><HashIcon size={14} /></span>
                  <span className="menu-label">{MARKDOWN.test(name) ? "Copy markdown" : "Copy source"}</span>
                </button>
              </>
            )}

            {canPublish(name) && (
              <>
                <div className="menu-heading">Link</div>
                {publishing ? (
                  <button role="menuitem" className="menu-item" disabled>
                    <span className="menu-icon" aria-hidden><span className="spinner" /></span>
                    <span className="menu-label">Publishing…<small>About 1-2 min. You can close this menu.</small></span>
                  </button>
                ) : !link && (
                  <button role="menuitem" className="menu-item" onClick={pick(() => publishFile(slug, id, name))}>
                    <span className="menu-icon" aria-hidden><LinkIcon size={14} /></span>
                    <span className="menu-label">{job?.state === "failed" ? "Try publishing again" : "Publish share link"}<small>claude.ai page anyone with the link can open</small></span>
                  </button>
                )}
                {job?.state === "failed" && <div className="share-error" role="alert">{job.error ?? "Publishing failed"}</div>}
                {link && (
                  <div className="share-link">
                    <span className="share-link-url">
                      <span className="muted small">Published {timeAgo(link.at)}:</span>
                      <a href={safeHref(link.url)} target="_blank" rel="noreferrer" title={link.url}>{link.url.replace(/^https:\/\//, "")}</a>
                    </span>
                    <button role="menuitem" className="btn small" onClick={pick(() => copyText(link.url, "Link copied"))}><CopyIcon size={12} /> Copy</button>
                    <button role="menuitem" className="btn small" disabled={publishing} title="Republish the current file to the same link"
                      onClick={pick(() => publishFile(slug, id, name))}><RefreshIcon size={12} /> Update</button>
                  </div>
                )}
              </>
            )}

            <div className="menu-heading">Location</div>
            <div className="share-path">
              <input readOnly value={path} aria-label="File location" onFocus={(e) => e.currentTarget.select()} />
              <button role="menuitem" className="btn small" onClick={pick(() => copyText(path, "Path copied"))}>Copy</button>
            </div>
          </div>
        </MenuSheet>,
        document.body,
      )}
    </div>
  );
}
