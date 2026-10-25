import { useEffect, useState } from "react";
import { api, copy, type ToolDetail } from "./api";
import { editDiff, mainInput } from "./toolView";

/** One tool call as a row: its short label, plus the id its full input and output load by. */
/** out: a short look at the output, shown under the label (the session viewer). */
export type ToolItem = { key: string; label: string; toolUseId?: string; error?: boolean; current?: boolean; out?: string };

/** Loaded details by ticket + tool_use id; only finished calls (with a result) are kept. */
const loaded = new Map<string, ToolDetail>();
/** Rows the user opened; module-level so they stay open across live refreshes. */
const opened = new Set<string>();

/** While a call still has no result and Claude is working, re-check this often. */
const PENDING_POLL_MS = 2000;

/** Tool calls as compact rows; clicking one opens a card with its full input and output. */
export function ToolRows({ slug, ticketId, items, live, className, load }: {
  slug: string; ticketId: string; items: ToolItem[]; live: boolean; className?: string;
  /** Where the full calls come from (default: the ticket's session; see ToolRow). */
  load?: (toolUseId: string) => Promise<ToolDetail>;
}) {
  return (
    <div className={`tool-rows${className ? ` ${className}` : ""}`}>
      {items.map((t) => <ToolRow key={t.key} slug={slug} ticketId={ticketId} item={t} live={live} load={load} />)}
    </div>
  );
}

/** load: where the full call comes from (default: the ticket's session); ticketId then only keys the cache. */
export function ToolRow({ slug, ticketId, item, live, load: loadDetail }: {
  slug: string; ticketId: string; item: ToolItem; live: boolean; load?: (toolUseId: string) => Promise<ToolDetail>;
}) {
  const key = `${ticketId}:${item.toolUseId ?? item.key}`;
  const [open, setOpen] = useState(() => opened.has(key));
  const [detail, setDetail] = useState<ToolDetail | null>(() => loaded.get(key) ?? null);
  const [failed, setFailed] = useState(false);

  const pending = !detail || detail.output === null;
  useEffect(() => {
    if (!open || !item.toolUseId || !pending) return;
    let stop = false;
    const load = () =>
      (loadDetail ? loadDetail(item.toolUseId!) : api.tool(slug, ticketId, item.toolUseId!))
        .then((d) => {
          if (stop) return;
          if (d.output !== null) loaded.set(key, d);
          setDetail(d);
          setFailed(false);
        })
        .catch(() => !stop && setFailed(true));
    load();
    const timer = live ? setInterval(load, PENDING_POLL_MS) : undefined;
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [open, pending, live, item.toolUseId]);

  const error = item.error || detail?.isError;
  return (
    <details className={`tool-row${error ? " error" : ""}${item.current ? " cur" : ""}`} open={open}
      onToggle={(e) => {
        const isOpen = e.currentTarget.open;
        if (isOpen) opened.add(key);
        else opened.delete(key);
        setOpen(isOpen);
      }}>
      <summary title={item.label}>
        {error && <span className="tool-x">✗ </span>}{item.current && <><span className="spinner" /> </>}{item.label}
        {item.out && <span className="tool-out">{item.out}</span>}
      </summary>
      {open && (
        <div className="tool-card">
          {!item.toolUseId || (failed && !detail) ? (
            <pre className="tool-note">Details not available.</pre>
          ) : !detail ? (
            <pre className="tool-note">Loading…</pre>
          ) : (
            <ToolCard d={detail} live={live} />
          )}
        </div>
      )}
    </details>
  );
}

function ToolCard({ d, live }: { d: ToolDetail; live: boolean }) {
  const input = mainInput(d);
  const [copied, setCopied] = useState(false);
  // A failed edit shows its error, not the change it tried to make.
  const diff = d.isError ? null : editDiff(d);
  return (
    <>
      <div className="tool-lbl">
        Input
        <button type="button" onClick={() => copy(input).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        })}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre>{input}</pre>
      <div className="tool-lbl">{diff ? "Diff" : "Output"}</div>
      {diff ? (
        <pre className="tool-diff">
          {diff.lines.map((l, i) => (
            <span key={i} className={l.kind}>{l.kind === "gap" ? l.text : `${l.kind === "rm" ? "-" : "+"} ${l.text}`}</span>
          ))}
          {diff.truncated && <span className="gap">…(truncated)</span>}
        </pre>
      ) : d.output === null ? (
        <pre className="tool-note">{live ? "Running…" : "Output not available."}</pre>
      ) : (
        <pre className={d.isError ? "err" : undefined}>{(d.output || "(no output)") + (d.truncated ? "\n…(truncated)" : "")}</pre>
      )}
    </>
  );
}
