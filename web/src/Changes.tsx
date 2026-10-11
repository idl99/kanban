import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, type DiffFile, type DiffLine, type Ticket, type TicketDiff } from "./api";
import { baseName, buildTree, isReviewComments, reviewKey, reviewMessage, treeOrder, type ReviewComment, type TreeDir } from "./review";
import { browserStore, forget } from "./drafts";
import { usePersistentState } from "./usePersistentState";

const VIEW_KEY = "ckanban.changesView";

/**
 * The ticket worktree's diff for the Changes tab. Lives in the drawer so the tab can show the file
 * count before it is opened; reloads when a run ends or the ticket moves.
 */
export function useTicketDiff(slug: string, ticket: Ticket) {
  const [diff, setDiff] = useState<TicketDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const running = !!ticket.running;
  const has = hasChanges(ticket);
  useEffect(() => {
    if (!has) {
      setDiff(null);
      return;
    }
    const n = ++seq.current;
    setLoading(true);
    api.diff(slug, ticket.id, ignoreWs)
      .then((d) => { if (n === seq.current) { setDiff(d); setError(null); } })
      .catch((e) => { if (n === seq.current) setError(e.message); })
      .finally(() => { if (n === seq.current) setLoading(false); });
  }, [slug, ticket.id, has, ignoreWs, running, ticket.status, tick]);
  return { diff, error, loading, ignoreWs, setIgnoreWs, reload: () => setTick((t) => t + 1) };
}

export type DiffState = ReturnType<typeof useTicketDiff>;

/** The ticket's changes can be shown: it has a worktree, or works in the board's folder since a known commit. */
const hasChanges = (t: Ticket) => !!t.worktree || (!!t.baseSha && !t.workdir);

const newId = () => Math.random().toString(36).slice(2, 10);

/** Changes tab: changed files on the left, the selected file's diff with line comments on the right. */
export function Changes({ slug, ticket, state, onSent, onError }: {
  slug: string;
  ticket: Ticket;
  state: DiffState;
  /** The comments went to Claude as one chat message. */
  onSent: () => void;
  onError: (msg: string) => void;
}) {
  const { diff, error, loading, ignoreWs, setIgnoreWs, reload } = state;
  const [comments, setComments] = usePersistentState<ReviewComment[]>(reviewKey(slug, ticket.id), () => [], (v) => !v.length, isReviewComments);
  const [view, setView] = usePersistentState<"tree" | "list">(VIEW_KEY, () => "tree", (v) => v === "tree", (v) => v === "list");
  const [picked, setPicked] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [sending, setSending] = useState(false);
  const files = diff?.files ?? [];
  const tree = useMemo(() => buildTree(files), [files]);
  const ordered = useMemo(() => (view === "tree" ? treeOrder(tree) : files.slice().sort((a, b) => a.path.localeCompare(b.path))), [tree, files, view]);
  const file = files.find((f) => f.path === picked) ?? ordered[0] ?? null;
  const countFor = (path: string) => comments.filter((c) => c.path === path).length;
  const inFolder = !ticket.worktree;

  const send = async () => {
    if (!comments.length || sending) return;
    setSending(true);
    try {
      await api.chat(slug, ticket.id, reviewMessage(comments));
      setComments([]);
      // onSent switches tabs and unmounts this before the persisted state would save the empty list.
      forget(browserStore(), reviewKey(slug, ticket.id));
      onSent();
    } catch (e: any) {
      onError(`Comments not sent: ${e.message}`);
    } finally {
      setSending(false);
    }
  };

  const fileRow = (f: DiffFile, label: string, depth: number) => {
    const n = countFor(f.path);
    return (
      <button key={f.path} className={`changes-file ${file?.path === f.path ? "on" : ""}`} style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => setPicked(f.path)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
        <span className={`diff-st st-${f.status}`}>{f.status}</span>
        <span className="changes-file-name">{label}</span>
        {n > 0 && <span className="changes-cmt-count" title={`${n} comment${n > 1 ? "s" : ""}`}>{n}</span>}
      </button>
    );
  };
  const dirRows = (d: TreeDir<DiffFile>, depth: number): React.ReactNode[] => [
    ...d.dirs.flatMap((sub) => {
      const shut = collapsed.has(sub.path);
      const toggle = () => setCollapsed((s) => {
        const next = new Set(s);
        if (shut) next.delete(sub.path);
        else next.add(sub.path);
        return next;
      });
      return [
        <button key={`d:${sub.path}`} className="changes-dir" style={{ paddingLeft: 12 + depth * 14 }} onClick={toggle} aria-expanded={!shut}>
          <span className="changes-caret">{shut ? "▸" : "▾"}</span><span className="changes-file-name">{sub.name}</span>
        </button>,
        ...(shut ? [] : dirRows(sub, depth + 1)),
      ];
    }),
    ...d.files.map((f) => fileRow(f, baseName(f.path), depth)),
  ];

  if (!hasChanges(ticket)) {
    return <div className="panel-scroll muted small changes-none">No version history for this folder, so changes can't be shown. Claude's summary lists the files it changed.</div>;
  }
  if (!diff) {
    return <div className="panel-scroll muted small">{error ? <div className="banner error inline">{error}</div> : "Loading changes…"}</div>;
  }

  return (
    <div className="changes">
      <div className="changes-bar">
        <span>{files.length} file{files.length === 1 ? "" : "s"}</span>
        <span className="diff-add">+{diff.additions}</span>
        <span className="diff-del">−{diff.deletions}</span>
        <span className="changes-ref" title={inFolder ? "Everything changed in the project folder since this ticket's first run, including edits made there by others" : undefined}>
          vs <code>{diff.base}</code>{inFolder && " (this ticket's start)"}{diff.branch && <> · <code>{diff.branch}</code></>}
        </span>
        <span className="spacer" />
        {error && <span className="changes-err" title={error}>Refresh failed</span>}
        <label className="changes-ws"><input type="checkbox" checked={ignoreWs} onChange={(e) => setIgnoreWs(e.target.checked)} /> Hide whitespace</label>
        <button className="btn small" onClick={reload} disabled={loading}>{loading ? "Loading…" : "↻ Refresh"}</button>
      </div>
      {diff.note ? (
        <div className="panel-scroll muted small changes-none">{diff.note}</div>
      ) : files.length === 0 ? (
        <div className="panel-scroll muted small">No changes against <code>{diff.base}</code> yet.</div>
      ) : (
        <div className="changes-body">
          <div className="changes-side">
            <div className="segmented changes-view" role="group" aria-label="File list layout">
              <button className={view === "list" ? "on" : ""} aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
              <button className={view === "tree" ? "on" : ""} aria-pressed={view === "tree"} onClick={() => setView("tree")}>Tree</button>
            </div>
            <div className="changes-files">
              {view === "tree" ? dirRows(tree, 0) : ordered.map((f) => fileRow(f, f.path, 0))}
            </div>
          </div>
          <div className="changes-diff">
            {file && <FileDiff key={file.path} file={file} comments={comments.filter((c) => c.path === file.path)} setComments={setComments} />}
          </div>
        </div>
      )}
      {comments.length > 0 && (
        <div className="changes-tray">
          <span><b>{comments.length} comment{comments.length === 1 ? "" : "s"}</b> waiting</span>
          <span className="spacer" />
          <button className="btn" disabled={sending} onClick={() => setComments([])}>Discard all</button>
          <button className="btn primary" disabled={sending} onClick={send}>
            {sending ? "Sending…" : `Send ${comments.length} comment${comments.length === 1 ? "" : "s"} to Claude`}
          </button>
        </div>
      )}
    </div>
  );
}

type Editing = { line: number; code: string; id: string | null; text: string };

function FileDiff({ file, comments, setComments }: {
  file: DiffFile;
  comments: ReviewComment[];
  setComments: (fn: (prev: ReviewComment[]) => ReviewComment[]) => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const lines = new Set(file.hunks.flatMap((h) => h.lines.map((l) => l.new)));
  const orphans = comments.filter((c) => !lines.has(c.line));

  const save = () => {
    if (!editing || !editing.text.trim()) return;
    const { id, line, code, text } = editing;
    setComments((all) => id
      ? all.map((c) => (c.id === id ? { ...c, text } : c))
      : [...all, { id: newId(), path: file.path, line, code, text }]);
    setEditing(null);
  };
  const remove = (id: string) => setComments((all) => all.filter((c) => c.id !== id));

  const editor = (
    <div className="cbox">
      <div className="cbox-who">{editing?.id ? "Edit comment" : "New comment"} · line {editing?.line}</div>
      <textarea autoFocus value={editing?.text ?? ""} placeholder="What should Claude change here?"
        onChange={(e) => setEditing((ed) => ed && { ...ed, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
          if (e.key === "Escape") { e.stopPropagation(); setEditing(null); }
        }} />
      <div className="cbox-acts">
        <button className="btn small" onClick={() => setEditing(null)}>Cancel</button>
        <button className="btn small primary" disabled={!editing?.text.trim()} onClick={save}>{editing?.id ? "Save" : "Add comment"}</button>
      </div>
    </div>
  );
  const shown = (c: ReviewComment) => editing?.id === c.id ? <Fragment key={c.id}>{editor}</Fragment> : (
    <div key={c.id} className="cbox">
      <div className="cbox-who">Your comment · line {c.line}</div>
      <div className="cbox-text">{c.text}</div>
      <div className="cbox-acts">
        <button className="btn small ghost" onClick={() => setEditing({ line: c.line, code: c.code, id: c.id, text: c.text })}>Edit</button>
        <button className="btn small ghost danger" onClick={() => remove(c.id)}>Delete</button>
      </div>
    </div>
  );

  const row = (l: DiffLine, key: string) => {
    const here = l.new === null ? [] : comments.filter((c) => c.line === l.new);
    const adding = editing && !editing.id && l.new !== null && editing.line === l.new;
    return (
      <Fragment key={key}>
        <tr className={`dl dl-${l.type}`}>
          <td className="ln">{l.old ?? ""}</td>
          <td className="ln ln-new">
            {l.new ?? ""}
            {l.new !== null && (
              <button className="add-cmt" aria-label={`Comment on line ${l.new}`} title="Add a comment"
                onClick={() => setEditing({ line: l.new!, code: l.text, id: null, text: "" })}>+</button>
            )}
          </td>
          <td className="code"><span className="sign">{l.type === "add" ? "+" : l.type === "del" ? "-" : " "}</span>{l.text}</td>
        </tr>
        {(here.length > 0 || adding) && (
          <tr className="dl-cmt"><td colSpan={3}>{here.map(shown)}{adding && editor}</td></tr>
        )}
      </Fragment>
    );
  };

  return (
    <>
      <div className="diff-file-head">
        <span className="diff-file-path">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
        <span className="diff-add">+{file.additions}</span>
        <span className="diff-del">−{file.deletions}</span>
      </div>
      {orphans.length > 0 && (
        <div className="diff-orphans">
          <div className="muted small">Comments on lines no longer in this diff:</div>
          {orphans.map(shown)}
        </div>
      )}
      {file.binary || file.tooLarge ? (
        <div className="diff-note muted small">{file.binary ? "Binary file, not shown." : `Too large to show (${file.additions + file.deletions} changed lines).`}</div>
      ) : file.hunks.length === 0 ? (
        <div className="diff-note muted small">{file.status === "R" ? "Renamed without content changes." : "No content changes to show."}</div>
      ) : (
        <table className="diff-table">
          <tbody>
            {file.hunks.map((h, hi) => (
              <Fragment key={hi}>
                <tr className="dl dl-hunk"><td className="ln" /><td className="ln" /><td className="code">{h.header}</td></tr>
                {h.lines.map((l, li) => row(l, `${hi}:${li}`))}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
