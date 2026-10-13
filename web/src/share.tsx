import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef } from "react";
import { api, copy, type Ticket } from "./api";
import { dismissToast, toast } from "./toast";

/** Raster images the server serves with their real type (SVG stays text there, so it is not previewed). */
export const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
export const BINARY = /\.(ico|bmp|tiff?|psd|pdf|zip|gz|tgz|tar|7z|rar|mp3|wav|m4a|ogg|mp4|mov|webm|avi|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin|dat|db|sqlite|wasm|pyc|class|jar|heic|avif)$/i;
export const MARKDOWN = /\.(md|markdown)$/i;
export const HTML = /\.html?$/i;

export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** The folder part of an outputs path, with its trailing "/" ("" at the top). */
export const dirName = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

/** Text files can be pasted as text; only Markdown and HTML can be published as a page. */
export const isText = (name: string) => !IMAGE.test(name) && !BINARY.test(name);
export const canPublish = (name: string) => MARKDOWN.test(name) || HTML.test(name);

const MIME: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", html: "text/html", htm: "text/html", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf", json: "application/json",
  csv: "text/csv", txt: "text/plain",
};
const mimeOf = (name: string) => MIME[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

const fail = (what: string) => (e: Error) => toast(`${what} failed: ${e.message}`, { tone: "error" });

export async function copyFile(slug: string, ticketId: string, name: string) {
  try {
    await api.outputAction(slug, ticketId, name, "copy");
    toast(`File copied. Paste in Slack with ${navigator.platform.startsWith("Mac") ? "⌘V" : "Ctrl+V"}`, { tone: "ok" });
  } catch (e: any) {
    // Fallback: the file in Finder can be dragged into Slack instead.
    toast(`Couldn't copy the file: ${e.message}`, {
      tone: "error",
      action: { label: "Show in Finder", run: () => { revealFile(slug, ticketId, name); } },
    });
  }
}

export function downloadFile(slug: string, ticketId: string, name: string) {
  const a = document.createElement("a");
  a.href = api.outputDownloadUrl(slug, ticketId, name);
  a.download = baseName(name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`Downloading ${baseName(name)}`, { tone: "ok" });
}

export function revealFile(slug: string, ticketId: string, name: string) {
  return api.outputAction(slug, ticketId, name, "reveal").then(() => toast("Shown in Finder", { tone: "ok" }), fail("Show in Finder"));
}

// Same sanitising as the chat's Markdown, so pasted HTML carries no scripts or forms.
const PURIFY = { FORBID_TAGS: ["form", "input", "button", "textarea", "select", "option", "style", "iframe", "object", "embed", "script"], FORBID_ATTR: ["style"] };

/** HTML for "Copy formatted": rendered Markdown, or an HTML file's own source. */
export function formattedHtml(name: string, text: string): string {
  if (HTML.test(name)) return text;
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, PURIFY);
}

/**
 * Rich paste (Slack, Notion, Docs keep headings, lists and tables) with the source as plain text.
 * The clipboard item takes promises, so the click still counts as the user's gesture while the file loads.
 */
export async function copyFormatted(slug: string, ticketId: string, name: string, loaded?: string | null) {
  const text = loaded != null ? Promise.resolve(loaded) : api.outputText(slug, ticketId, name);
  try {
    if (typeof ClipboardItem === "undefined") throw new Error("no rich clipboard");
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": text.then((t) => new Blob([formattedHtml(name, t)], { type: "text/html" })),
      "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })),
    })]);
    toast("Copied formatted text", { tone: "ok" });
  } catch {
    try {
      await copy(await text);
      toast("Copied as plain text (this browser can't copy formatting)", { tone: "ok" });
    } catch (e: any) {
      toast(`Copy failed: ${e.message}`, { tone: "error" });
    }
  }
}

export async function copySource(slug: string, ticketId: string, name: string, loaded?: string | null) {
  try {
    await copy(loaded ?? await api.outputText(slug, ticketId, name));
    toast(MARKDOWN.test(name) ? "Copied markdown" : "Copied", { tone: "ok" });
  } catch (e: any) {
    toast(`Copy failed: ${e.message}`, { tone: "error" });
  }
}

/** "Publishing…" toasts by "<ticket>/<file>", replaced by the result toast when the publish finishes. */
const publishing = new Map<string, number>();

export function publishFile(slug: string, ticketId: string, name: string) {
  return api.outputAction(slug, ticketId, name, "publish").then(() => {
    publishing.set(`${ticketId}/${name}`, toast("Publishing… this takes a minute or two", { tone: "info", ms: 180_000 }));
  }, fail("Publishing"));
}

export async function copyText(text: string, done: string) {
  await copy(text);
  toast(done, { tone: "ok" });
}

/**
 * Dragging a file row out of the browser drops the real file (Chromium only: DownloadURL).
 * Nothing else is set, so Slack gets a file rather than a link.
 */
export function dragFile(e: React.DragEvent, slug: string, ticketId: string, name: string) {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData("DownloadURL", `${mimeOf(name)}:${baseName(name)}:${location.origin}${api.outputDownloadUrl(slug, ticketId, name)}`);
}

function publishingToast(ticketId: string, file: string): number | undefined {
  const id = publishing.get(`${ticketId}/${file}`);
  publishing.delete(`${ticketId}/${file}`);
  return id;
}

/** Toast when a background publish finishes or fails (the drawer stays open while it runs). */
export function useShareNotices(ticket: Ticket) {
  const prev = useRef<{ id: string; active: Set<string> }>({ id: ticket.id, active: new Set() });
  useEffect(() => {
    const active = new Set((ticket.shareJobs ?? []).filter((j) => j.state === "publishing").map((j) => j.file));
    const before = prev.current.id === ticket.id ? prev.current.active : new Set<string>();
    prev.current = { id: ticket.id, active };
    for (const file of before) {
      if (active.has(file)) continue;
      const pending = publishingToast(ticket.id, file);
      if (pending) dismissToast(pending);
      const failed = ticket.shareJobs?.find((j) => j.file === file && j.state === "failed");
      const link = ticket.shareLinks?.find((l) => l.file === file);
      if (failed) toast(`Couldn't publish ${baseName(file)}: ${failed.error ?? "unknown error"}`, { tone: "error" });
      else if (link) toast(`Share link ready for ${baseName(file)}`, { tone: "ok", action: { label: "Copy link", run: () => { copyText(link.url, "Link copied"); } } });
    }
  }, [ticket.id, ticket.shareJobs, ticket.shareLinks]);
}
