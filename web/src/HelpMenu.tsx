import { useCallback, useEffect, useRef, useState } from "react";
import { api, type HelpCard, type HelpKind, type Ticket } from "./api";
import { useLayer } from "./layers";
import { Markdown } from "./Transcript";
import { costText } from "./usage";
import { fullTime, timeAgo } from "./time";

/** The menu's questions: a bold question and a grey line saying what the answer gives. */
export const HELP_ITEMS: { kind: HelpKind; question: string; hint: string; heading: string }[] = [
  { kind: "recap", question: "What happened while I was away?", hint: "Short summary since your last message, and what Claude needs from you", heading: "While you were away" },
  { kind: "changes", question: "Explain the changes", hint: "What changed and why, in plain words with a small picture", heading: "The change, explained" },
];

const heading = (k: HelpKind) => HELP_ITEMS.find((i) => i.kind === k)!.heading;

/**
 * "Help me understand": answers from a side call that reads the ticket (not its session), shown as cards in the chat.
 * hasChanges: the ticket has changed files (from the Changes tab's diff).
 */
export function useHelp(slug: string, ticket: Ticket, hasChanges: boolean) {
  const [cards, setCards] = useState<HelpCard[]>([]);
  const [recap, setRecap] = useState(false);
  // Answers being worked out (asked here, or by another device / before a reload), and ones whose last try failed.
  const [busy, setBusy] = useState<HelpKind[]>([]);
  const [failed, setFailed] = useState<Partial<Record<HelpKind, string>>>({});
  const [tick, setTick] = useState(0);
  // Asked from this page: still busy until its own request ends, whatever a refresh says.
  const asked = useRef(new Set<HelpKind>());

  useEffect(() => {
    setCards([]);
    setRecap(false);
    setBusy([]);
    setFailed({});
  }, [slug, ticket.id]);

  useEffect(() => {
    let live = true;
    api.help(slug, ticket.id).then((h) => {
      if (!live) return;
      setCards(h.cards);
      setRecap(h.recap);
      setBusy((b) => [...new Set([...b.filter((k) => h.busy.includes(k) || asked.current.has(k)), ...h.busy])]);
    }, () => {});
    return () => {
      live = false;
    };
  }, [slug, ticket.id, ticket.running, ticket.lastRunAt, ticket.status, ticket.lastActivity, tick]);

  // Busy elsewhere (another device, or before a reload): look again until it is done.
  useEffect(() => {
    if (!busy.some((k) => !asked.current.has(k))) return;
    const t = setTimeout(() => setTick((n) => n + 1), 4000);
    return () => clearTimeout(t);
  }, [busy, tick]);

  const ask = useCallback(async (kind: HelpKind) => {
    asked.current.add(kind);
    setBusy((b) => (b.includes(kind) ? b : [...b, kind]));
    setFailed(({ [kind]: _, ...rest }) => rest);
    try {
      const card = await api.askHelp(slug, ticket.id, kind);
      setCards((cs) => (cs.some((c) => c.id === card.id) ? cs : [...cs, card]));
    } catch (e) {
      setFailed((f) => ({ ...f, [kind]: (e as Error).message }));
    } finally {
      asked.current.delete(kind);
      setBusy((b) => b.filter((k) => k !== kind));
    }
  }, [slug, ticket.id]);

  const available: Record<HelpKind, boolean> = { recap, changes: hasChanges };
  return { cards, busy, failed, available, ask, dismiss: (kind: HelpKind) => setFailed(({ [kind]: _, ...rest }) => rest) };
}

export type HelpState = ReturnType<typeof useHelp>;

/** "💡 Help me understand ▾" in the ticket header: a dropdown, or a bottom sheet on a phone. */
export function HelpMenu({ help, phone, onAsk }: { help: HelpState; phone: boolean; onAsk: (kind: HelpKind) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = HELP_ITEMS.filter((i) => help.available[i.kind]);
  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  useLayer(() => close(), { active: open });
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus());
    if (phone) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, phone]);
  if (!items.length) return null;

  const onKey = (e: React.KeyboardEvent) => {
    const list = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") { e.preventDefault(); go(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(at - 1); }
  };
  const list = (
    <div ref={menu} role="menu" aria-label="Help me understand" onKeyDown={onKey}
      className={phone ? "sheet help-sheet" : "inbox-menu help-menu"}>
      {phone && <div className="sheet-grip" aria-hidden />}
      {items.map((i) => (
        <button key={i.kind} role="menuitem" className="help-item" disabled={help.busy.includes(i.kind)}
          onClick={() => { close(false); onAsk(i.kind); }}>
          <b>{i.question}</b>
          <span>{help.busy.includes(i.kind) ? "Working on it…" : i.hint}</span>
        </button>
      ))}
      <p className="help-foot">The answer shows in the chat. Claude's conversation on this ticket doesn't see it.</p>
    </div>
  );
  return (
    <div className="help-menu-wrap" ref={root}>
      <button ref={button} className={`btn small help-btn ${open ? "on" : ""}`} aria-haspopup="menu" aria-expanded={open}
        aria-label="Help me understand" title="Plain-words answers about this ticket" onClick={() => (open ? close() : setOpen(true))}>
        <span aria-hidden>💡</span><span className="help-btn-label"> Help me understand</span> <span aria-hidden>▾</span>
      </button>
      {open && (phone
        ? <div className="sheet-wrap" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>{list}</div>
        : list)}
    </div>
  );
}

/** One answer in the chat: blue left border, heading, the answer, and its cost in small grey text. */
export function HelpCardView({ card }: { card: HelpCard }) {
  return (
    <div className="help-card">
      <h5>{heading(card.kind)}</h5>
      <Markdown text={card.text} />
      <div className="help-meta muted small">
        <time dateTime={card.at} title={fullTime(card.at)}>{timeAgo(card.at)}</time> · {costText(card.costUsd)} · not part of Claude's conversation
      </div>
    </div>
  );
}

/** Answers being worked out, and failed ones with a retry, at the end of the chat. */
export function HelpPending({ help }: { help: HelpState }) {
  return (
    <>
      {help.busy.map((k) => (
        <div key={k} className="help-card" role="status">
          <h5>{heading(k)}</h5>
          <div className="muted"><span className="spinner" /> {k === "recap" ? "Reading what happened…" : "Reading the changes…"}</div>
        </div>
      ))}
      {(Object.keys(help.failed) as HelpKind[]).filter((k) => !help.busy.includes(k)).map((k) => (
        <div key={k} className="help-card error" role="alert">
          <h5>{heading(k)}</h5>
          <div>Couldn't get an answer: {help.failed[k]}</div>
          <div className="help-actions">
            <button className="btn small" onClick={() => void help.ask(k)}>Try again</button>
            <button className="btn ghost small" onClick={() => help.dismiss(k)}>Dismiss</button>
          </div>
        </div>
      ))}
    </>
  );
}
