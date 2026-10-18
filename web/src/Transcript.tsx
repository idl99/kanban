import DOMPurify from "dompurify";
import { marked } from "marked";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, copy, type ActivityEntry } from "./api";
import { ATTACHMENT_SRC, fileHref, fileKind, formatSize, opensInline } from "./attachText";
import { FileLinkContext } from "./fileLinkContext";
import { codePath, textPaths } from "./filePaths";
import { opensNewTab } from "./links";
import { sourceLabel, splitCommandMentions, type SlashCommand } from "./slashText";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
  return JSON.stringify(content, null, 2);
}

function toolLabel(block: any): string {
  const i = block.input ?? {};
  const arg = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.description ?? i.path ?? i.query ?? "";
  return `${block.name}${arg ? `: ${String(arg).split("\n")[0]}` : ""}`;
}

// Transcript/comment text is untrusted (Claude output, repo content). No forms/inputs/styles: a
// disguised same-origin form could otherwise drive the local API, which runs Claude unattended.
const PURIFY = {
  FORBID_TAGS: ["form", "input", "button", "textarea", "select", "option", "style", "iframe", "object", "embed"],
  FORBID_ATTR: ["style", "action", "formaction"],
};

const IMAGE_NAME = /\.(?:png|jpg|gif|webp)$/;

function thumbnails(html: string, commands?: SlashCommand[] | null, handles?: string[], files?: Set<string>): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (commands?.length) mentionChips(doc, commands);
  if (handles?.length) handleChips(doc, handles);
  // Pasted images: the UI URL, or the absolute file path Claude was given in its prompt (seen in the chat history).
  doc.querySelectorAll("img").forEach((img) => {
    const m = (img.getAttribute("src") ?? "").match(ATTACHMENT_SRC);
    if (!m || !IMAGE_NAME.test(m[1])) return;
    img.setAttribute("src", `/api/attachments/${m[1]}`);
    img.classList.add("attachment");
  });
  // Clicking a link must not replace the board: open it in a new tab.
  doc.querySelectorAll("a").forEach((a) => {
    if (!opensNewTab(a.getAttribute("href"))) return;
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
  fileCards(doc);
  if (files?.size) fileChips(doc, files);
  copyBars(doc);
  return doc.body.innerHTML;
}

/** Inline code (not code blocks) and prose outside links, where file paths are looked for. */
function pathSpots(doc: Document) {
  const codes = [...doc.querySelectorAll("code")].filter((c) => !c.closest("pre, a"));
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    if (n.nodeValue?.includes("/") && !n.parentElement?.closest("code, pre, a")) texts.push(n);
  }
  return { codes, texts };
}

/** File paths a rendered message mentions, as written. */
function pathsIn(html: string): string[] {
  const { codes, texts } = pathSpots(new DOMParser().parseFromString(html, "text/html"));
  const out = new Set<string>();
  for (const c of codes) {
    const p = codePath(c.textContent ?? "");
    if (p) out.add(p);
  }
  for (const n of texts) for (const m of textPaths(n.nodeValue ?? "")) out.add(m.path);
  return [...out];
}

/** Paths of files that exist become chips that open the file (FileViewer.tsx). */
function fileChips(doc: Document, files: Set<string>) {
  const chip = (path: string, content: Node) => {
    const a = doc.createElement("a");
    a.className = "path-chip";
    a.href = "#";
    a.dataset.path = path;
    a.title = `Open ${path}`;
    const icon = doc.createElement("span");
    icon.className = "path-chip-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "📄";
    a.append(icon, content);
    return a;
  };
  const { codes, texts } = pathSpots(doc);
  for (const c of codes) {
    const p = codePath(c.textContent ?? "");
    if (!p || !files.has(p)) continue;
    const a = chip(p, doc.createTextNode(""));
    c.replaceWith(a);
    a.append(c);
  }
  for (const node of texts) {
    const text = node.nodeValue ?? "";
    const hits = textPaths(text).filter((m) => files.has(m.path));
    if (!hits.length) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of hits) {
      frag.append(text.slice(last, m.at), chip(m.path, doc.createTextNode(m.path)));
      last = m.at + m.path.length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/** Code blocks get a "Copy text" bar underneath. Added after sanitizing, so PURIFY's button ban doesn't strip it. */
function copyBars(doc: Document) {
  doc.querySelectorAll("pre").forEach((pre) => {
    const box = doc.createElement("div");
    box.className = "code-block";
    const bar = doc.createElement("button");
    bar.type = "button";
    bar.className = "code-copy";
    bar.textContent = "Copy text";
    pre.replaceWith(box);
    box.append(pre, bar);
  });
}

/** Text of a code block as written: marked ends every block with a newline that isn't part of it. */
export function codeText(raw: string): string {
  return raw.replace(/\n$/, "");
}

async function copyCode(bar: HTMLButtonElement) {
  const pre = bar.parentElement?.querySelector("pre");
  if (!pre) return;
  const ok = await copy(codeText(pre.textContent ?? ""));
  bar.textContent = ok ? "Copied ✓" : "Couldn't copy";
  bar.classList.toggle("done", ok);
  bar.classList.toggle("failed", !ok);
  clearTimeout(Number(bar.dataset.timer));
  bar.dataset.timer = String(setTimeout(() => {
    bar.textContent = "Copy text";
    bar.classList.remove("done", "failed");
  }, ok ? 1500 : 2500));
}

/**
 * Links to attached files become cards: type tile, name, "PDF · 2.4 MB" (the size is filled in after render)
 * and a Download button. Clicking opens PDFs, images and text in a new tab and downloads Office files.
 */
function fileCards(doc: Document) {
  doc.querySelectorAll("a").forEach((a) => {
    const m = (a.getAttribute("href") ?? "").match(ATTACHMENT_SRC);
    if (!m) return;
    const stored = m[1];
    const name = (a.textContent ?? "").trim() || stored;
    const kind = fileKind(name.includes(".") ? name : stored);
    const el = (tag: string, cls: string, text?: string) => {
      const e = doc.createElement(tag);
      e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const card = el("span", "file-card");
    card.dataset.stored = stored;
    card.dataset.type = kind.type;
    const open = el("a", "file-open") as HTMLAnchorElement;
    open.href = fileHref(stored, name);
    if (opensInline(stored)) {
      open.target = "_blank";
      open.rel = "noopener noreferrer";
    } else open.setAttribute("download", name);
    open.title = name;
    const meta = el("span", "file-meta");
    meta.append(el("span", "file-name", name), el("span", "file-size", kind.type));
    open.append(el("span", `file-tile ${kind.cls}`, kind.tile), meta);
    const dl = el("a", "file-btn", "⤓") as HTMLAnchorElement;
    dl.href = fileHref(stored, name, true);
    dl.setAttribute("download", name);
    dl.title = "Download";
    dl.setAttribute("aria-label", `Download ${name}`);
    card.append(open, dl);
    a.replaceWith(card);
  });
  // Cards on consecutive lines sit in one wrapping row instead of one per line.
  doc.querySelectorAll(".file-card + br").forEach((br) => {
    let next = br.nextSibling;
    while (next && next.nodeType === 3 && !next.textContent?.trim()) next = next.nextSibling;
    if (next instanceof Element && next.classList.contains("file-card")) br.remove();
  });
}

/** Fill in the file cards' sizes ("PDF · 2.4 MB") once they are in the page. */
function fillSizes(root: HTMLElement | null) {
  root?.querySelectorAll<HTMLElement>(".file-card[data-stored]").forEach((card) => {
    void api.attachmentSize(card.dataset.stored!).then((n) => {
      const line = card.querySelector(".file-size");
      if (n !== null && line) line.textContent = `${card.dataset.type} · ${formatSize(n)}`;
    });
  });
}

/** `/name` of a known skill or command in prose (not code or links) becomes a chip; hover tells what it is. */
function mentionChips(doc: Document, commands: SlashCommand[]) {
  const byName = new Map(commands.map((c) => [c.name, c]));
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    if (!text.includes("/") || node.parentElement?.closest("code, pre, a")) continue;
    const parts = splitCommandMentions(text, (n) => byName.has(n));
    if (parts.every((p) => typeof p === "string")) continue;
    const frag = doc.createDocumentFragment();
    for (const p of parts) {
      if (typeof p === "string") { frag.append(p); continue; }
      const c = byName.get(p.name)!;
      const chip = doc.createElement("span");
      chip.className = "cmd-chip mention";
      chip.textContent = `/${p.name}`;
      chip.title = `${c.kind === "skill" ? "Skill" : "Command"} · ${sourceLabel(c)}${c.description ? `\n${c.description}` : ""}`;
      frag.append(chip);
    }
    node.replaceWith(frag);
  }
}

/** `@handle` of a huddle participant (or @all) in prose (not code or links) becomes a chip. */
function handleChips(doc: Document, handles: string[]) {
  const known = new Set(handles.map((h) => h.toLowerCase()));
  const re = /(^|[^\w@./-])@([a-z0-9][a-z0-9_-]*)/gi;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    if (!text.includes("@") || node.parentElement?.closest("code, pre, a")) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(re)) {
      const name = m[2].replace(/[-_]+$/, "");
      if (!known.has(name.toLowerCase())) continue;
      const at = m.index! + m[1].length;
      frag.append(text.slice(last, at));
      const chip = doc.createElement("span");
      chip.className = name.toLowerCase() === "you" ? "at-chip me" : "at-chip";
      chip.textContent = `@${name}`;
      frag.append(chip);
      last = at + 1 + name.length;
    }
    if (!last) continue;
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/** `commands`: `/name` mentions of these render as chips (ticket descriptions). `handles`: `@handle` mentions (huddles). */
export function Markdown({ text, commands, handles }: { text: string; commands?: SlashCommand[] | null; handles?: string[] }) {
  const links = useContext(FileLinkContext);
  const clean = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }) as string, PURIFY), [text]);
  // Inside a ticket, paths of files that exist become chips; they show once the board says which exist.
  const wanted = useMemo(() => (links ? pathsIn(clean) : []), [clean, links]);
  const [files, setFiles] = useState<Set<string> | undefined>();
  useEffect(() => {
    if (!links || !wanted.length) return setFiles(undefined);
    let live = true;
    void links.find(wanted).then((s) => { if (live) setFiles(s.size ? s : undefined); });
    return () => { live = false; };
  }, [links, wanted.join("\n")]);
  const html = useMemo(() => thumbnails(clean, commands, handles, files), [clean, commands, handles?.join(" "), files]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => fillSizes(ref.current), [html]);
  return (
    <div ref={ref} className="md" dangerouslySetInnerHTML={{ __html: html }}
      onDoubleClick={(e) => { if ((e.target as HTMLElement).closest(".code-copy, .path-chip")) e.stopPropagation(); }}
      onClick={(e) => {
        const bar = (e.target as HTMLElement).closest<HTMLButtonElement>(".code-copy");
        if (bar) {
          e.stopPropagation(); // e.g. a click on the ticket description opens its editor
          void copyCode(bar);
          return;
        }
        const chip = (e.target as HTMLElement).closest<HTMLElement>(".path-chip");
        if (chip && links) {
          e.preventDefault();
          e.stopPropagation();
          links.open(chip.dataset.path!);
          return;
        }
        const img = e.target as HTMLElement;
        if (img.tagName === "IMG" && img.classList.contains("attachment")) window.open(img.getAttribute("src")!, "_blank", "noopener");
      }} />
  );
}

function Event({ ev }: { ev: any }) {
  if (ev.type === "system" && ev.subtype === "init") {
    return <div className="ev ev-system">Session started · {ev.model ?? "claude"} · <code>{ev.cwd}</code></div>;
  }
  if (ev.type === "assistant") {
    const blocks: any[] = ev.message?.content ?? [];
    return (
      <>
        {blocks.map((b, i) => {
          if (b.type === "text" && b.text?.trim()) {
            return <div key={i} className="ev ev-text"><Markdown text={b.text.replace(/^.*CKANBAN_RESULT:.*$/m, "").trim()} /></div>;
          }
          if (b.type === "tool_use") {
            return (
              <details key={i} className="ev ev-tool">
                <summary>{toolLabel(b)}</summary>
                <pre>{JSON.stringify(b.input, null, 2)}</pre>
              </details>
            );
          }
          if (b.type === "thinking" && b.thinking) {
            return (
              <details key={i} className="ev ev-thinking">
                <summary>Thinking</summary>
                <pre>{b.thinking}</pre>
              </details>
            );
          }
          return null;
        })}
      </>
    );
  }
  if (ev.type === "user") {
    const blocks: any[] = Array.isArray(ev.message?.content) ? ev.message.content : [];
    return (
      <>
        {blocks.filter((b) => b.type === "tool_result").map((b, i) => {
          const out = textOf(b.content);
          return (
            <details key={i} className={`ev ev-result ${b.is_error ? "is-error" : ""}`}>
              <summary>{b.is_error ? "Tool error" : "Result"} · {out.split("\n").length} lines</summary>
              <pre>{out.length > 8000 ? out.slice(0, 8000) + "\n…(truncated)" : out}</pre>
            </details>
          );
        })}
      </>
    );
  }
  if (ev.type === "result") {
    const cost = typeof ev.total_cost_usd === "number" ? `$${ev.total_cost_usd.toFixed(3)}` : null;
    const secs = typeof ev.duration_ms === "number" ? `${Math.round(ev.duration_ms / 1000)}s` : null;
    return (
      <div className={`ev ev-footer ${ev.is_error ? "is-error" : ""}`}>
        {ev.is_error ? "Run ended with error" : "Run finished"}
        {secs && ` · ${secs}`}
        {cost && ` · ${cost}`}
        {typeof ev.num_turns === "number" && ` · ${ev.num_turns} turns`}
      </div>
    );
  }
  return null;
}

export function Transcript({ entries, live }: { entries: ActivityEntry[]; live: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  const runs = useMemo(() => {
    const m = new Map<number, ActivityEntry[]>();
    for (const e of entries) {
      if (!m.has(e.run)) m.set(e.run, []);
      m.get(e.run)!.push(e);
    }
    return [...m.entries()];
  }, [entries]);

  useEffect(() => {
    if (live) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length, live]);

  if (!entries.length) return <div className="muted">No runs yet.</div>;
  return (
    <div className="transcript">
      {runs.map(([run, evs]) => (
        <div key={run} className="run">
          <div className="run-head">
            Run {run} <span className="muted">· {new Date(evs[0].at).toLocaleString()}</span>
          </div>
          {evs.map((e, i) => <Event key={i} ev={e.event} />)}
        </div>
      ))}
      {live && <div className="ev ev-live"><span className="spinner" /> Working…</div>}
      <div ref={endRef} />
    </div>
  );
}
