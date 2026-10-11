import { useCallback, useEffect, useRef, useState } from "react";
import { api, onReconnect, subscribe, type Huddle, type HuddleMessage } from "./api";
import { AVATAR_COLORS } from "./avatar";
import { mergeMessages, pickHuddle, ticketHuddles, upsertHuddle, withActivity } from "./huddleText";

export { BIG_CONTEXT_TOKENS, brakeLabel, cardHuddleBadge, contextText, dollars, guestTickets, huddleRound, huddleTitle, idleFor, quietLabel, roundTag, sortHuddles, type CardHuddleBadge } from "./huddleText";
export { handleInitials, isForYou, mentionCandidates, mentionQuery, participantActivity, sourceLabel, untaggedHint } from "./huddleText";

/** Participants that count toward the cap (everyone but the user). */
export const members = (h: Huddle) => h.participants.filter((p) => p.kind !== "human");

/** What the huddle's agents have spent so far. */
export const huddleCost = (h: Huddle) => h.participants.reduce((s, p) => s + (p.costUsd ?? 0), 0);

/** Stable avatar color per handle; the coordinator gets the accent. */
export function handleColor(handle: string): string {
  if (handle === "main") return "var(--accent)";
  if (handle === "you") return "var(--muted)";
  let h = 0x811c9dc5;
  // Numbered copies (qa-1, qa-2) share their role's color.
  for (const c of handle.replace(/-\d+$/, "")) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return AVATAR_COLORS[(h >>> 0) % AVATAR_COLORS.length];
}

export interface HuddleState {
  /** The huddle shown: the one picked, else the ticket's open one, else its newest. */
  huddle: Huddle | null;
  /** Every huddle the ticket hosted (its rounds), newest first. */
  list: Huddle[];
  /** The one shown when nothing is picked (the tab's counts and the chat's huddle cards follow this one). */
  latest: Huddle | null;
  messages: HuddleMessage[];
  hasMore: boolean;
  loaded: boolean;
  error: string | null;
  reload: () => Promise<void>;
  loadEarlier: () => Promise<void>;
}

/**
 * The ticket's huddles, and the picked one (`huddleId`, else the default) with its messages. Only the shown huddle's
 * huddle.message / huddle.activity events reach its feed; huddle.updated keeps the whole list current.
 */
export function useHuddle(slug: string, ticketId: string, huddleId: string | null = null): HuddleState {
  const [list, setList] = useState<Huddle[]>([]);
  const [huddle, setHuddle] = useState<Huddle | null>(null);
  const [messages, setMessages] = useState<HuddleMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  const listRef = useRef<Huddle[] | null>(null);
  const pickRef = useRef(huddleId);
  pickRef.current = huddleId;
  const seq = useRef(0);

  // fetchList: false when only the pick changed (the list is already here).
  const load = useCallback(async (fetchList: boolean) => {
    const mine = ++seq.current;
    try {
      let hs = listRef.current;
      if (fetchList || !hs) {
        hs = ticketHuddles(await api.huddles(slug, ticketId), ticketId);
        if (mine !== seq.current) return;
        listRef.current = hs;
        setList(hs);
      }
      const h = pickHuddle(hs, ticketId, pickRef.current);
      if (!h) {
        idRef.current = null;
        setHuddle(null);
        setMessages([]);
        setHasMore(false);
      } else {
        const r = await api.huddle(slug, h.id);
        if (mine !== seq.current) return;
        const switched = idRef.current !== h.id;
        idRef.current = h.id;
        setHuddle(r.huddle);
        setMessages((ms) => (switched ? r.messages : mergeMessages(ms, r.messages)));
        if (switched) setHasMore(r.hasMore);
      }
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    } finally {
      if (mine === seq.current) setLoaded(true);
    }
  }, [slug, ticketId]);
  const reload = useCallback(() => load(true), [load]);

  useEffect(() => {
    idRef.current = null;
    listRef.current = null;
    setList([]);
    setHuddle(null);
    setMessages([]);
    setLoaded(false);
    reload();
  }, [reload]);

  // Another round picked: its feed replaces this one, and this one's live events stop reaching it.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    idRef.current = null;
    load(false);
  }, [huddleId]);

  useEffect(() => subscribe((e) => {
    if (e.type === "huddle.updated" && e.profile === slug && e.huddle.hostTicket === ticketId) {
      const known = listRef.current?.some((h) => h.id === e.huddle.id);
      if (listRef.current) {
        listRef.current = ticketHuddles(upsertHuddle(listRef.current, e.huddle), ticketId);
        setList(listRef.current);
      }
      if (e.huddle.id === idRef.current) setHuddle(e.huddle);
      // A new huddle on this ticket (started here, from the chat card or another window).
      else if (!known && e.huddle.status !== "closed") reload();
    } else if (e.type === "huddle.message" && e.profile === slug && e.huddleId === idRef.current) {
      setMessages((ms) => mergeMessages(ms, [e.message]));
    } else if (e.type === "huddle.activity" && e.profile === slug) {
      if (e.huddleId === idRef.current) setHuddle((h) => h && withActivity(h, e.handle, e.lastActivity, e.liveCostUsd, e.contextTokens));
      if (listRef.current?.some((h) => h.id === e.huddleId)) {
        listRef.current = listRef.current.map((h) => (h.id === e.huddleId ? withActivity(h, e.handle, e.lastActivity, e.liveCostUsd, e.contextTokens) : h));
        setList(listRef.current);
      }
    }
  }), [slug, ticketId, reload]);

  useEffect(() => onReconnect(() => void reload()), [reload]);

  const loadEarlier = useCallback(async () => {
    const id = idRef.current;
    const first = messages[0]?.seq;
    if (!id || first === undefined) return;
    const r = await api.huddle(slug, id, { before: first });
    if (idRef.current !== id) return;
    setMessages((ms) => mergeMessages(r.messages, ms));
    setHasMore(r.hasMore);
  }, [slug, messages]);

  // The live copy of the shown huddle is fresher than the list's.
  const latest = pickHuddle(list, ticketId);
  return { huddle, list, latest: latest && huddle && latest.id === huddle.id ? huddle : latest, messages, hasMore, loaded, error, reload, loadEarlier };
}

/** Every huddle on the board, kept live from huddle.updated events (card badges and the dock's Huddles list). */
export function useBoardHuddles(slug: string | null): Huddle[] {
  const [list, setList] = useState<Huddle[]>([]);
  const reload = useCallback(() => {
    if (!slug) return;
    api.boardHuddles(slug).then((hs) => setList(hs)).catch(() => {});
  }, [slug]);
  useEffect(() => {
    setList([]);
    reload();
  }, [reload]);
  useEffect(() => subscribe((e) => {
    if (e.type === "huddle.updated" && e.profile === slug) setList((hs) => upsertHuddle(hs, e.huddle));
    else if (e.type === "huddle.activity" && e.profile === slug) setList((hs) => hs.map((h) => (h.id === e.huddleId ? withActivity(h, e.handle, e.lastActivity, e.liveCostUsd, e.contextTokens) : h)));
  }), [slug]);
  useEffect(() => onReconnect(reload), [reload]);
  return list;
}
