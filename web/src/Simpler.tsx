import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/**
 * "Say it simpler" under Claude's replies: a plain-words version from a side call, shown in place of the reply.
 * Saved versions load with the chat, so a reload or another device shows them at once without a new call.
 */
export function useSimpler(slug: string, ticketId: string) {
  const [saved, setSaved] = useState<Record<string, string>>({});
  // Replies showing their plain-words version, rewrites in progress, and ones whose last try failed.
  const [shown, setShown] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setSaved({});
    setShown(new Set());
    setBusy(new Set());
    setFailed(new Set());
    let live = true;
    api.simplified(slug, ticketId).then((s) => live && setSaved(s), () => {});
    return () => {
      live = false;
    };
  }, [slug, ticketId]);

  const toggle = (set: Set<string>, uuid: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(uuid);
    else next.delete(uuid);
    return next;
  };

  const simplify = useCallback(async (uuid: string) => {
    if (saved[uuid]) return setShown((s) => toggle(s, uuid, true));
    setBusy((s) => toggle(s, uuid, true));
    setFailed((s) => toggle(s, uuid, false));
    try {
      const r = await api.simplify(slug, ticketId, uuid);
      setSaved((s) => ({ ...s, [uuid]: r.text }));
      setShown((s) => toggle(s, uuid, true));
    } catch {
      setFailed((s) => toggle(s, uuid, true));
    } finally {
      setBusy((s) => toggle(s, uuid, false));
    }
  }, [slug, ticketId, saved]);

  return {
    /** The plain-words version when it is the one showing, else null. */
    textFor: (uuid: string) => (shown.has(uuid) ? saved[uuid] ?? null : null),
    link: (uuid: string) => (
      <SimplerLink busy={busy.has(uuid)} failed={failed.has(uuid)} simple={shown.has(uuid) && !!saved[uuid]}
        onSimplify={() => void simplify(uuid)} onOriginal={() => setShown((s) => toggle(s, uuid, false))} />
    ),
  };
}

function SimplerLink({ busy, failed, simple, onSimplify, onOriginal }: {
  busy: boolean; failed: boolean; simple: boolean; onSimplify: () => void; onOriginal: () => void;
}) {
  if (busy) return <div className="simpler" role="status"><span className="spinner" /> Saying it simpler…</div>;
  if (simple) return <div className="simpler"><button className="link-btn" onClick={onOriginal}>Show original</button></div>;
  if (failed) {
    return (
      <div className="simpler error" role="alert">
        Couldn't simplify. <button className="link-btn" onClick={onSimplify}>Try again</button>
      </div>
    );
  }
  return (
    <div className="simpler">
      <button className="link-btn" onClick={onSimplify} title="Rewrite this reply in plain words. It doesn't change the chat or what Claude remembers.">
        Say it simpler
      </button>
    </div>
  );
}
