import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/**
 * "Say it simpler" under Claude's replies: a plain-words version from a side call, shown in place of the reply.
 * Saved versions load with the chat, so a reload or another device shows them at once without a new call.
 */
export function useSimpler(slug: string, ticketId: string) {
  return useSimplerFor(`${slug}/${ticketId}`, () => api.simplified(slug, ticketId), (uuid) => api.simplify(slug, ticketId, uuid));
}

/** The same for a quick chat (Claude panel, phone Ask tab); no chat yet: nothing to load. */
export function useChatSimpler(slug: string, chatId: string | null) {
  return useSimplerFor(`${slug}/chat:${chatId}`, () => (chatId ? api.chatSimplified(slug, chatId) : Promise.resolve({})), (uuid) => api.chatSimplify(slug, chatId!, uuid));
}

/** key: whose replies (reloads when it changes); load: the saved versions; rewrite: one reply's plain-words version. */
function useSimplerFor(key: string, load: () => Promise<Record<string, string>>, rewrite: (uuid: string) => Promise<{ text: string }>) {
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
    load().then((s) => live && setSaved(s), () => {});
    return () => {
      live = false;
    };
  }, [key]);

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
      const r = await rewrite(uuid);
      setSaved((s) => ({ ...s, [uuid]: r.text }));
      setShown((s) => toggle(s, uuid, true));
    } catch {
      setFailed((s) => toggle(s, uuid, true));
    } finally {
      setBusy((s) => toggle(s, uuid, false));
    }
  }, [key, saved]);

  return {
    /** The plain-words version when it is the one showing, else null. */
    textFor: (uuid: string) => (shown.has(uuid) ? saved[uuid] ?? null : null),
    /** Rewriting, failed, or showing the plain-words version: its actions row stays visible. */
    active: (uuid: string) => busy.has(uuid) || failed.has(uuid) || shown.has(uuid),
    link: (uuid: string) => (
      <SimplerLink busy={busy.has(uuid)} failed={failed.has(uuid)} simple={shown.has(uuid) && !!saved[uuid]}
        onSimplify={() => void simplify(uuid)} onOriginal={() => setShown((s) => toggle(s, uuid, false))} />
    ),
  };
}

/** Its part of the reply's actions row (see ReplyActions). */
function SimplerLink({ busy, failed, simple, onSimplify, onOriginal }: {
  busy: boolean; failed: boolean; simple: boolean; onSimplify: () => void; onOriginal: () => void;
}) {
  if (busy) return <span className="act-note" role="status"><span className="spinner" /> Saying it simpler…</span>;
  if (simple) return <button type="button" className="act-btn" onClick={onOriginal}>Show original</button>;
  if (failed) {
    return (
      <span className="act-note error" role="alert">
        Couldn't simplify. <button type="button" className="act-btn" onClick={onSimplify}>Try again</button>
      </span>
    );
  }
  return (
    <button type="button" className="act-btn" onClick={onSimplify} title="Rewrite this reply in plain words. It doesn't change the chat or what Claude remembers.">
      <span aria-hidden>✦</span> Say it simpler
    </button>
  );
}
