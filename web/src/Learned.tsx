import { useState } from "react";
import { api, type LearnCandidate, type LearnChange, type LearnedView, type LearnSource } from "./api";
import { fullTime, timeAgo } from "./time";

/**
 * The Team tab's Learned view: lessons the board saved on its own (from corrections that came back, or huddle lessons
 * that came up again), what its weekly tidy changed, and lessons seen once. Everything has Undo; nothing asks first.
 */
export function LearnedPane({ slug, view, onChanged, onError, onOpenTicket, onOpenHuddle }: {
  slug: string;
  view: LearnedView | null;
  onChanged: () => void;
  onError: (message: string) => void;
  onOpenTicket?: (id: string) => void;
  onOpenHuddle?: (ticketId: string, huddleId?: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (id: string, p: Promise<unknown>) => {
    setBusy(id);
    try {
      await p;
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!view) return <div className="team-notes"><span className="muted small">Loading…</span></div>;
  const links = { onOpenTicket, onOpenHuddle };
  const undo = (c: LearnChange) => (
    <button className="btn small" disabled={busy === c.id} onClick={() => act(c.id, api.undoLearned(slug, c.id, !!c.undoneAt))}>
      {c.undoneAt ? "Redo" : "Undo"}
    </button>
  );
  return (
    <div className="team-notes learned">
      <p className="muted small">
        The board saves a lesson on its own once the same thing comes up on two different tickets or huddles, or right away when you say
        “always” or “never”. Undo takes it back everywhere.
      </p>

      <h4 className="ln-head">Saved this week</h4>
      {view.saved.length === 0 && <div className="muted small ln-empty">Nothing learned this week. When you correct the same thing twice, it shows up here.</div>}
      {view.saved.map((c) => (
        <div key={c.id} className={`ln-row${c.undoneAt ? " undone" : ""}`}>
          <div className="ln-main">
            <div className="ln-text">{c.text}</div>
            <div className="ln-src">{c.where} · <Sources sources={c.sources ?? []} {...links} /> · saved <When at={c.at} /></div>
          </div>
          {undo(c)}
        </div>
      ))}

      {view.cleaned.length > 0 && (
        <>
          <h4 className="ln-head">Cleaned up</h4>
          {view.cleaned.map((c) => (
            <div key={c.id} className={`ln-row${c.undoneAt ? " undone" : ""}`}>
              <div className="ln-main">
                <div className="ln-text">{c.kind === "removed" ? <>Removed: {c.text}</> : c.text}</div>
                <div className="ln-src">
                  {c.kind === "merged" ? `Merged ${c.old.length} notes into one` : c.kind === "rewrote" ? "Rewritten in general words" : "Removed"}
                  {c.why ? `: ${c.why}` : ""} · {c.where} · <When at={c.at} />
                </div>
                {c.kind !== "removed" && c.old.length > 0 && (
                  <details className="ln-old">
                    <summary>{c.old.length === 1 ? "Before" : `The ${c.old.length} notes before`}</summary>
                    <ul>{c.old.map((o, i) => <li key={i}>{o}</li>)}</ul>
                  </details>
                )}
              </div>
              {undo(c)}
            </div>
          ))}
        </>
      )}

      <details className="ln-watching">
        <summary>Watching (seen once, {view.watching.length}) · not used yet</summary>
        {view.watching.length === 0 && <div className="muted small ln-empty">Nothing waiting for a second time.</div>}
        {view.watching.map((c) => <Watching key={c.id} slug={slug} c={c} busy={busy === c.id} act={act} onError={onError} {...links} />)}
      </details>
    </div>
  );
}

function Watching({ slug, c, busy: saving, act, onError, onOpenTicket, onOpenHuddle }: {
  slug: string;
  c: LearnCandidate;
  busy: boolean;
  act: (id: string, p: Promise<unknown>) => void;
  onError: (message: string) => void;
  onOpenTicket?: (id: string) => void;
  onOpenHuddle?: (ticketId: string, huddleId?: string) => void;
}) {
  const [dropped, setDropped] = useState(false);
  const [working, setWorking] = useState(false);
  const busy = saving || working;
  // Dropped rows stay (dimmed, with Undo) until the view loads again, so a slip is never lost.
  const drop = async (keep: boolean) => {
    setWorking(true);
    try {
      await api.learnedLesson(slug, c.id, keep ? "keep" : "drop");
      setDropped(!keep);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className={`ln-row${dropped ? " undone" : ""}`}>
      <div className="ln-main">
        <div className="ln-text">{c.text}</div>
        <div className="ln-src"><Sources sources={c.sources} onOpenTicket={onOpenTicket} onOpenHuddle={onOpenHuddle} /> · <When at={c.lastAt} /></div>
      </div>
      <span className="ln-pill">1 of 2</span>
      {dropped ? (
        <button className="btn small" disabled={busy} onClick={() => void drop(true)}>Undo</button>
      ) : (
        <>
          {c.general && <button className="btn small primary" disabled={busy} onClick={() => act(c.id, api.learnedLesson(slug, c.id, "save"))}>Save now</button>}
          <button className="btn small ghost" disabled={busy} onClick={() => void drop(false)}>Drop</button>
        </>
      )}
    </div>
  );
}

function When({ at }: { at: string }) {
  return <time dateTime={at} title={fullTime(at)}>{timeAgo(at)}</time>;
}

/** Where a lesson came from: "you corrected this on “A” and “B”", "from 2 huddles: “A”, “B”". */
function Sources({ sources, onOpenTicket, onOpenHuddle }: {
  sources: LearnSource[];
  onOpenTicket?: (id: string) => void;
  onOpenHuddle?: (ticketId: string, huddleId?: string) => void;
}) {
  // One per ticket or huddle, newest last.
  const seen = new Map<string, LearnSource>();
  for (const s of sources) seen.set(s.key, s);
  const list = [...seen.values()];
  if (!list.length) return <>from the board</>;
  const huddle = list[0].kind === "huddle";
  const open = (s: LearnSource) => (s.kind === "huddle" ? s.ticket && onOpenHuddle && (() => onOpenHuddle(s.ticket!, s.id)) : onOpenTicket && (() => onOpenTicket(s.id)));
  const titles = list.map((s, i) => {
    const go = open(s);
    return (
      <span key={s.key}>
        {i > 0 && (i === list.length - 1 ? " and " : ", ")}
        {go ? <button className="link-btn" onClick={go}>“{s.title}”</button> : <>“{s.title}”</>}
      </span>
    );
  });
  const quote = !huddle && list.length === 1 && list[0].quote ? <> (“{clip(list[0].quote)}”)</> : null;
  return huddle
    ? <>{list.length === 1 ? "from a huddle on " : `came up in ${list.length} huddles: `}{titles}</>
    : <>you corrected this on {titles}{quote}</>;
}

const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
