import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api, copy, onReconnect, subscribe, type Huddle, type HuddleParticipant, type ParticipantSession, type SessionStep } from "./api";
import { handleColor, handleInitials } from "./huddle";
import { ChevronLeftIcon, CloseIcon } from "./icons";
import { isTyping, panelStep } from "./keynav";
import { KeyHint } from "./KeyHint";
import { useLayer } from "./layers";
import { mergeSteps, sessionMeta, sessionState, toolIcon } from "./sessionText";
import { fullTime } from "./time";
import { ToolRow, type ToolItem } from "./ToolRows";
import { usePhone } from "./usePhone";

/**
 * A huddle participant's own Claude session, read-only, beside the feed: its reasoning, tool calls (expand for the
 * full input and output) and posts. Live while it works (huddle.session events); closed huddles stay viewable.
 * The only way to talk to it is the huddle: Message @handle pre-fills the composer.
 */
export function SessionPanel({ slug, huddle: h, participant: p, onClose, onStep, onMessage, onOpenChat, onOpenTicket }: {
  slug: string;
  huddle: Huddle;
  participant: HuddleParticipant;
  onClose: () => void;
  /** J/K or ↑/↓: the next (1) or previous (-1) participant. */
  onStep: (delta: 1 | -1) => void;
  onMessage: (handle: string) => void;
  onOpenChat: () => void;
  onOpenTicket: (id: string) => void;
}) {
  // Phone: full screen over the huddle, a back arrow instead of the close button.
  const phone = usePhone();
  const [s, setS] = useState<ParticipantSession | null>(null);
  const [steps, setSteps] = useState<SessionStep[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const keep = useRef<number | null>(null);
  // What is shown starts at this step index; a refresh reloads from there (null: nothing loaded yet).
  const from = useRef<number | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const handle = p.handle;
  const closed = h.status === "closed";

  const refresh = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      do {
        again.current = false;
        const since = from.current;
        const r = await api.huddleSession(slug, h.id, handle, since === null ? {} : { since });
        setS(r);
        setError(null);
        if (since === null) {
          from.current = r.steps[0]?.i ?? r.total;
          setSteps(r.steps);
          setHasMore(r.hasMore);
        } else setSteps((shown) => mergeSteps(shown, r.steps));
      } while (again.current);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [slug, h.id, handle]);

  // Another participant: start over at its newest steps.
  useEffect(() => {
    from.current = null;
    stick.current = true;
    setS(null);
    setSteps([]);
    setHasMore(false);
    setError(null);
    refresh();
  }, [refresh]);

  // Its session file changed, or its status did (a turn ended, it was stopped): reload what is shown.
  useEffect(() => subscribe((e) => {
    if (e.type === "huddle.session" && e.profile === slug && e.huddleId === h.id && e.handle === handle) refresh();
  }), [slug, h.id, handle, refresh]);
  useEffect(() => {
    if (from.current !== null) refresh();
  }, [p.status, p.running, p.costUsd]);
  useEffect(() => onReconnect(() => void refresh()), [refresh]);

  const earlier = async () => {
    const first = steps[0]?.i;
    if (first === undefined || loadingEarlier) return;
    setLoadingEarlier(true);
    const el = scroller.current;
    try {
      const r = await api.huddleSession(slug, h.id, handle, { before: first });
      keep.current = el ? el.scrollHeight - el.scrollTop : null;
      from.current = r.steps[0]?.i ?? first;
      setSteps((shown) => [...r.steps, ...shown.filter((x) => x.i >= first)]);
      setHasMore(r.hasMore);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingEarlier(false);
    }
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keep.current !== null) {
      el.scrollTop = el.scrollHeight - keep.current;
      keep.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [steps, s?.live]);

  // Esc closes (not while typing in the composer); J/K and ↑/↓ move between participants while this is the top layer.
  const isTop = useLayer(onClose, { skipInInputs: true });
  const stepRef = useRef(onStep);
  stepRef.current = onStep;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented || isTyping(e) || !isTop() || document.querySelector(".overlay")) return;
      const dir = panelStep(e);
      if (!dir) return;
      e.preventDefault();
      stepRef.current(dir === "next" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const view = s ?? {
    kind: p.kind, role: p.role, model: p.model, mode: p.mode, costUsd: p.costUsd ?? 0, sessionId: p.sessionId ?? null, snapshot: p.snapshot ?? null,
    live: false, status: p.status, current: null, file: null, ticketId: p.ticketId ?? null,
  };
  const live = !!s?.live;
  const loadTool = (id: string) => api.huddleSessionTool(slug, h.id, handle, id);
  const toolKey = `huddle:${h.id}:${handle}`;
  const reveal = () => api.revealHuddleSession(slug, h.id, handle).catch((e) => setError((e as Error).message));
  const copyPath = () => view.file && copy(view.file).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  });

  return (
    <section className="hd-session" aria-label={`@${handle}'s session (read-only)`}>
      <header className="hd-session-head">
        {phone && <button className="icon-btn phone-back" onClick={onClose} aria-label="Back to the huddle"><ChevronLeftIcon size={22} /></button>}
        <span className="hd-av" style={{ background: handleColor(handle) }} aria-hidden>{handleInitials(handle)}</span>
        <div className="hd-session-title">
          <div><b>@{handle}</b> <span className="hd-ro">read-only</span></div>
          <div className="hd-session-meta" title={view.sessionId ? `Session ${view.sessionId}` : undefined}>{sessionMeta(view)}</div>
        </div>
        <span className="spacer" />
        {!closed && (
          <button className="btn small primary" onClick={() => onMessage(handle)} title={`Write to @${handle} in the huddle`}>Message @{handle}</button>
        )}
        {!phone && <button className="icon-btn" onClick={onClose} aria-label="Close the session" title="Close (Esc)"><CloseIcon size={12} /><KeyHint keys="Esc" /></button>}
      </header>
      {view.kind !== "agent" ? (
        <div className="hd-session-steps">
          <div className="hd-session-note">
            {view.ticketId === h.hostTicket ? (
              <>@{handle} is this ticket's own session: its steps are in the Chat tab. <button className="link-btn" onClick={onOpenChat}>Open Chat</button></>
            ) : view.ticketId ? (
              <>@{handle} is ticket {view.ticketId}'s own session: its steps are in that ticket's chat. <button className="link-btn" onClick={() => onOpenTicket(view.ticketId!)}>Open the ticket</button></>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="hd-session-steps" ref={scroller} onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}>
          {hasMore && <button className="btn ghost small load-earlier" onClick={earlier} disabled={loadingEarlier}>{loadingEarlier ? "Loading…" : "Load earlier steps"}</button>}
          {!s && !error && <div className="hd-session-note"><span className="spinner" /> Loading the session…</div>}
          {s && !steps.length && <div className="hd-session-note">{view.sessionId ? "No steps recorded yet." : "No session yet: it starts when the agent first runs."}</div>}
          {steps.map((x) => <Step key={x.i} step={x} current={live && x.i === view.current}
            tool={(item) => <ToolRow slug={slug} ticketId={toolKey} live={live} load={loadTool} item={item} />} />)}
          {live && view.current === null && (
            <div className="hd-st"><span className="hd-st-i"><span className="spinner" /></span><span className="hd-think live">Thinking…</span></div>
          )}
          {p.status === "failed" && p.error && <div className="hd-session-err" role="alert">Failed: {p.error}</div>}
          {error && <div className="hd-session-err" role="alert">Couldn't load the session: {error} <button className="link-btn" onClick={() => refresh()}>Retry</button></div>}
        </div>
      )}
      <footer className="hd-session-foot">
        <span className={live ? "hd-live" : undefined}>{live && <span className="spinner" />} {sessionState(view, closed)}</span>
        <span className="spacer" />
        <span className="hd-session-keys" aria-hidden><kbd>J</kbd><kbd>K</kbd> participant · <kbd>Esc</kbd> close</span>
        {view.file && (
          <>
            <button className="link-btn" onClick={reveal} title={view.file}>Open transcript file</button>
            <button className="link-btn" onClick={copyPath} title={view.file}>{copied ? "Copied" : "Copy path"}</button>
          </>
        )}
      </footer>
    </section>
  );
}

function Step({ step: x, current, tool }: {
  step: SessionStep; current: boolean; tool: (item: ToolItem) => ReactNode;
}) {
  const time = x.at ? fullTime(x.at) : undefined;
  if (x.kind === "wake") return <div className="hd-st-wake" title={time}>{x.text}</div>;
  if (x.kind === "text") {
    return <div className="hd-st" title={time}><span className="hd-st-i" aria-hidden>💭</span><span className="hd-think">{x.text}</span></div>;
  }
  if (x.kind === "post") {
    const label = x.seq ? `posted #${x.seq} to the huddle` : x.error ? `post failed${x.out ? `: ${x.out}` : ""}` : x.pending ? "posting…" : "posted to the huddle";
    return (
      <div className="hd-st" title={time}>
        <span className="hd-st-i" aria-hidden>💬</span>
        <div className={`hd-st-post${x.error ? " error" : ""}`}><small>{label}</small><div>{x.text}</div></div>
      </div>
    );
  }
  const out = x.pending ? (current ? "running…" : "no result") : x.out;
  return (
    <div className={`hd-st tool${current ? " cur" : ""}`} title={time}>
      <span className="hd-st-i" aria-hidden>{current ? <span className="spinner" /> : toolIcon(x.text)}</span>
      {tool({ key: x.id ?? `s${x.i}`, label: x.text, toolUseId: x.id, error: x.error, current: false, out })}
    </div>
  );
}
