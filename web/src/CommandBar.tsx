import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, COLUMNS, type Profile, type Ticket, type TicketRow } from "./api";
import { avatarColor, avatarLetter } from "./avatar";
import { fuzzyMatch, highlightRuns, rankTickets } from "./fuzzy";
import { CheckIcon, SearchIcon } from "./icons";
import { useFocusTrap, useLayer } from "./layers";

export interface CommandAction {
  id: string;
  label: string;
  /** Muted words after the label, e.g. what the action opens. */
  hint?: string;
  /** Keys shown on the right, e.g. ["N"] or ["Ctrl", "`"]. */
  keys?: string[];
  icon?: ReactNode;
  run: () => void;
}

type Item =
  | { kind: "ticket"; key: string; row: TicketRow; at: number[] }
  | { kind: "action"; key: string; action: CommandAction; at: number[] }
  | { kind: "board"; key: string; profile: Profile; num: number | null; at: number[] };

const GROUP_TITLE = { ticket: "Tickets", action: "Actions", board: "Boards" } as const;
const SWITCH = "Switch to ";

function Marked({ text, at, offset = 0 }: { text: string; at: number[]; offset?: number }) {
  if (!at.length) return <>{text}</>;
  return <>{highlightRuns(text, at.map((i) => i + offset)).map((r, i) => (r.hit ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>))}</>;
}

const rowOf = (p: Profile, t: Ticket): TicketRow => ({
  profile: p.slug, profileName: p.name, id: t.id, title: t.title, status: t.status, running: !!t.running, updatedAt: t.updatedAt,
});

/**
 * ⌘K: one box for tickets on every board, board actions and board switching.
 * Tickets on the shown board come from the live list; other boards load once when the bar opens.
 */
export function CommandBar({ profiles, current, tickets, needYou, actions, onOpenTicket, onSwitchBoard, onClose }: {
  profiles: Profile[];
  current: string | null;
  tickets: Ticket[];
  needYou: Map<string, number>;
  actions: CommandAction[];
  onOpenTicket: (board: string, id: string) => void;
  onSwitchBoard: (slug: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [others, setOthers] = useState<TicketRow[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useLayer(onClose);
  useFocusTrap(box);

  useEffect(() => {
    api.allTickets().then(setOthers).catch(() => setOthers([]));
  }, []);

  const here = profiles.find((p) => p.slug === current) ?? null;
  const rows = useMemo(() => [
    ...(here ? tickets.map((t) => rowOf(here, t)) : []),
    ...(others ?? []).filter((r) => r.profile !== current),
  ], [here, tickets, others, current]);

  const items = useMemo<Item[]>(() => {
    const query = q.trim();
    const ticketItems: Item[] = rankTickets(rows, query, current, query ? 15 : 8)
      .map(({ row, at }) => ({ kind: "ticket", key: `t:${row.profile}/${row.id}`, row, at }));
    // Keep the list order when nothing is typed; otherwise best match first.
    const matched = <T,>(list: T[], text: (x: T) => string) => {
      const out = list.flatMap((x, i) => {
        const m = fuzzyMatch(text(x), query);
        return m ? [{ x, i, at: m.at, score: m.score }] : [];
      });
      return query ? out.sort((a, b) => a.score - b.score) : out;
    };
    const actionItems: Item[] = matched(actions, (a) => a.label)
      .map(({ x, at }) => ({ kind: "action", key: `a:${x.id}`, action: x, at }));
    const boardItems: Item[] = matched(profiles, (p) => p.name)
      .map(({ x, i, at }) => ({ kind: "board", key: `b:${x.slug}`, profile: x, num: i < 9 ? i + 1 : null, at }));
    return [...ticketItems, ...actionItems, ...boardItems];
  }, [q, rows, current, actions, profiles]);

  const at = Math.min(active, Math.max(0, items.length - 1));
  const run = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === "ticket") onOpenTicket(item.row.profile, item.row.id);
    else if (item.kind === "action") item.action.run();
    else onSwitchBoard(item.profile.slug);
  };

  const onKey = (e: React.KeyboardEvent) => {
    // Functional updates: fast repeats land before the next render.
    const last = items.length - 1;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(last, Math.min(i, last) + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, Math.min(i, last) - 1)); }
    else if (e.key === "Home" && e.metaKey) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && e.metaKey) { e.preventDefault(); setActive(last); }
    else if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); run(items[at]); }
  };

  const status = (r: TicketRow) => (r.running && r.status !== "in_progress" ? "Running" : COLUMNS.find((c) => c.id === r.status)?.label ?? r.status);
  const optionId = (item: Item) => `cmd-${item.key.replace(/[^\w-]/g, "_")}`;

  return (
    <div className="overlay cmdbar-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="cmdbar" role="dialog" aria-modal="true" aria-label="Command bar">
        <div className="cmdbar-input">
          <SearchIcon className="icon" />
          <input autoFocus value={q} placeholder="Search tickets on every board, actions and boards…" aria-label="Search tickets, actions and boards"
            role="combobox" aria-expanded aria-controls="cmdbar-list" aria-autocomplete="list"
            aria-activedescendant={items[at] ? optionId(items[at]) : undefined}
            onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onKey} />
          <kbd aria-hidden>esc</kbd>
        </div>
        <div className="cmdbar-list" id="cmdbar-list" role="listbox" aria-label="Results">
          {items.length === 0 && <div className="picker-empty">Nothing matches “{q.trim()}”.</div>}
          {items.map((item, i) => {
            const head = i === 0 || items[i - 1].kind !== item.kind;
            const on = i === at;
            return (
              <Fragment key={item.key}>
                {head && (
                  <div className="cmdbar-group" role="presentation">
                    {GROUP_TITLE[item.kind]}
                    {item.kind === "ticket" && !q.trim() && <span className="cmdbar-group-note">active, most recent first</span>}
                    {item.kind === "ticket" && others === null && <span className="spinner" />}
                  </div>
                )}
                <div id={optionId(item)} role="option" aria-selected={on} className={`cmdbar-item${on ? " active" : ""}`}
                  onMouseMove={() => { if (!on) setActive(i); }} onMouseDown={(e) => e.preventDefault()} onClick={() => run(item)}
                  ref={(el) => { if (el && on) el.scrollIntoView({ block: "nearest" }); }}>
                  {item.kind === "ticket" && (
                    <>
                      <span className="cmdbar-title"><Marked text={item.row.title} at={item.at} /></span>
                      <span className={`cmdbar-board${item.row.profile === current ? " here" : ""}`}>{item.row.profileName}</span>
                      <span className={`cmdbar-status st-${item.row.running ? "running" : item.row.status}`}>{status(item.row)}</span>
                    </>
                  )}
                  {item.kind === "action" && (
                    <>
                      <span className="cmdbar-icon" aria-hidden>{item.action.icon}</span>
                      <span className="cmdbar-title"><Marked text={item.action.label} at={item.at} />{item.action.hint && <span className="cmdbar-hint"> · {item.action.hint}</span>}</span>
                      {item.action.keys && <span className="cmdbar-keys">{item.action.keys.map((k, n) => <kbd key={n}>{k}</kbd>)}</span>}
                    </>
                  )}
                  {item.kind === "board" && (
                    <>
                      <span className="profile-avatar" style={{ background: avatarColor(item.profile.slug) }} aria-hidden>{avatarLetter(item.profile.name)}</span>
                      <span className="cmdbar-title"><Marked text={SWITCH + item.profile.name} at={item.at} offset={SWITCH.length} /></span>
                      {!!needYou.get(item.profile.slug) && <span className="need-chip">{needYou.get(item.profile.slug)} need you</span>}
                      {item.profile.slug === current && <span className="profile-check" aria-label="Current board"><CheckIcon size={13} /></span>}
                      {item.num && <span className="cmdbar-keys"><kbd aria-label={`Key ${item.num}`}>{item.num}</kbd></span>}
                    </>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
        <div className="cmdbar-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
          <span className="cmdbar-foot-note">Searches ticket titles on every board, actions and boards</span>
        </div>
      </div>
    </div>
  );
}
