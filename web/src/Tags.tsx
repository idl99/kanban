import { useEffect, useRef, useState } from "react";
import { CheckIcon, CloseIcon } from "./icons";
import { useLayer } from "./layers";
import { MenuSheet } from "./MenuSheet";
import { usePhone } from "./usePhone";
import { boardTags, normalizeTag, tagStyle } from "./tagText";

/** One tag as a colored `#name` chip; with onClick it filters the board (cards) instead of opening the ticket. */
export function TagChip({ name, onClick }: { name: string; onClick?: () => void }) {
  if (!onClick) return <span className="tag-chip" style={tagStyle(name)}>#{name}</span>;
  return (
    <button type="button" className="tag-chip" style={tagStyle(name)} title={`Show only tickets tagged ${name}`}
      // Not a drag, not a click on the card: just the filter.
      onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClick(); }}>
      #{name}
    </button>
  );
}

/**
 * Tag editor (ticket panel, new-ticket dialog): chips with ✕, Claude's suggestions dashed with ✓ / ✕, and "+ tag",
 * an input that offers the board's tags (most used first) and "Create …" for a new name.
 */
export function TagEditor({ tags, suggested = [], known, onChange, onSuggested, disabled }: {
  tags: string[];
  suggested?: string[];
  /** This board's tags with how many tickets have each. */
  known: { name: string; count: number }[];
  onChange: (tags: string[]) => void;
  /** Keep or drop Claude's suggestions: the new suggestion list (kept ones also go through onChange). */
  onSuggested?: (suggested: string[]) => void;
  disabled?: boolean;
}) {
  // Edits build on this local copy, not on the props: a second quick add must not overwrite the first while the
  // board's live update for it is still on its way. A new value from the board (another tab, Claude) replaces it.
  const [list, setList] = useState(tags);
  const [sugg, setSugg] = useState(suggested);
  useEffect(() => setList(tags), [tags.join()]);
  useEffect(() => setSugg(suggested), [suggested.join()]);
  const change = (next: string[]) => { setList(next); onChange(next); };
  const changeSuggested = (next: string[]) => { setSugg(next); onSuggested?.(next); };

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const typed = normalizeTag(draft);
  // An exact match comes first, else "Create …", then the board's tags containing the text (most used first).
  const exact = known.find((k) => k.name === typed);
  const options = [
    ...(typed && !list.includes(typed) ? [exact ?? { name: typed, count: 0, create: true }] : []),
    ...known.filter((k) => !list.includes(k.name) && k.name !== typed && (!typed || k.name.includes(typed))).slice(0, 8),
  ] as { name: string; count: number; create?: boolean }[];
  const pick = Math.min(sel, Math.max(options.length - 1, 0));

  const add = (name: string) => {
    const tag = normalizeTag(name);
    setDraft("");
    setSel(0);
    if (!tag || list.includes(tag)) return;
    change([...list, tag]);
    if (sugg.includes(tag)) changeSuggested(sugg.filter((s) => s !== tag));
  };
  // What is typed right now; Esc empties it first, so the blur that follows doesn't add it.
  const live = useRef("");
  live.current = draft;
  const close = () => { live.current = ""; setOpen(false); setDraft(""); setSel(0); };
  // Clicking away (or Create / Save in a dialog) keeps what was typed.
  const blur = () => {
    const tag = normalizeTag(live.current);
    if (tag) add(tag);
    close();
  };
  // Esc closes the open tag input first, not the panel or dialog around it.
  useLayer(close, { active: open });
  const start = () => setOpen(true);

  return (
    <div className="tag-editor" aria-label="Tags">
      {list.map((g) => (
        <span key={g} className="tag-chip" style={tagStyle(g)}>
          #{g}
          <button type="button" className="tag-x" aria-label={`Remove tag ${g}`} title="Remove" disabled={disabled}
            onClick={() => change(list.filter((x) => x !== g))}><CloseIcon size={10} /></button>
        </span>
      ))}
      {sugg.filter((g) => !list.includes(g)).map((g) => (
        <span key={g} className="tag-chip suggested" style={tagStyle(g)} title="Claude suggested this tag">
          #{g}
          <button type="button" className="tag-x" aria-label={`Keep tag ${g}`} title="Keep" disabled={disabled} onClick={() => add(g)}><CheckIcon size={11} /></button>
          <button type="button" className="tag-x" aria-label={`Drop suggested tag ${g}`} title="Drop" disabled={disabled}
            onClick={() => changeSuggested(sugg.filter((s) => s !== g))}><CloseIcon size={10} /></button>
        </span>
      ))}
      {open ? (
        <span className="tag-input-wrap">
          <input ref={inputRef} autoFocus className="tag-input" value={draft} placeholder="tag name" aria-label="Add a tag" disabled={disabled}
            role="combobox" aria-expanded={options.length > 0} aria-autocomplete="list"
            onChange={(e) => { setDraft(e.target.value); setSel(0); }}
            onBlur={blur}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel(Math.min(pick + 1, options.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel(Math.max(pick - 1, 0)); }
              else if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                if (options[pick]) add(options[pick].name);
                else if (typed) add(typed);
              } else if (e.key === "Backspace" && !draft && list.length) change(list.slice(0, -1));
            }} />
          {options.length > 0 && (
            <span className="tag-menu" role="listbox">
              {options.map((o, i) => (
                <button type="button" key={o.name} role="option" aria-selected={i === pick} className={`tag-option${i === pick ? " on" : ""}`}
                  // Keep the input focused (no blur) so the pick lands.
                  onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setSel(i)} onClick={() => { add(o.name); inputRef.current?.focus(); }}>
                  <span className="tag-dot" style={tagStyle(o.name)} />
                  {o.create ? <>Create “{o.name}”</> : o.name}
                  {!!o.count && <span className="tag-count">{o.count}</span>}
                </button>
              ))}
            </span>
          )}
        </span>
      ) : (
        <button type="button" className="tag-add" disabled={disabled} onClick={start}>+ tag</button>
      )}
    </div>
  );
}

/** Above this many tags the Tags list gets a find box. */
const TAG_FIND_FROM = 8;

/**
 * "Tags ▾" filter chip in the board bar: a list of the board's tags (in their colors, with counts) to tick.
 * Ticked tags are the board's tag filter, the same one the search box shows as chips. A bottom sheet on a phone.
 */
export function TagFilter({ tickets, picked, onChange }: {
  tickets: { tags?: string[] }[];
  picked: string[];
  onChange: (tags: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  // No keyboard popping up over the sheet on a phone.
  const phone = usePhone();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = (focusButton = true) => {
    setOpen(false);
    setFind("");
    if (focusButton) button.current?.focus();
  };
  useLayer(() => close(), { active: open });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const known = boardTags(tickets);
  // A picked tag no ticket has any more stays in the list, so it can be unticked.
  const all = [...known, ...picked.filter((g) => !known.some((k) => k.name === g)).map((name) => ({ name, count: 0 }))];
  if (!all.length) return null;
  const needle = normalizeTag(find);
  const shown = needle ? all.filter((k) => k.name.includes(needle)) : all;
  const toggle = (name: string) => onChange(picked.includes(name) ? picked.filter((g) => g !== name) : [...picked, name]);

  return (
    <div className="tag-filter" ref={root}>
      <button ref={button} type="button" className={`chip${picked.length ? " on" : ""}`} aria-haspopup="dialog" aria-expanded={open}
        title="Show only tickets with these tags" onClick={() => (open ? close() : setOpen(true))}>
        Tags{picked.length > 0 && <span className="chip-count">· {picked.length}</span>} <span aria-hidden>▾</span>
      </button>
      {open && (
        <MenuSheet onClose={() => close(false)}>
          <div className="tag-filter-menu" role="dialog" aria-label="Filter by tag">
            {all.length > TAG_FIND_FROM && (
              <input className="tag-filter-find" autoFocus={!phone} value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a tag" aria-label="Find a tag" />
            )}
            <div className="tag-filter-list">
              {shown.map((k) => (
                <label key={k.name} className="tag-filter-item">
                  <input type="checkbox" checked={picked.includes(k.name)} onChange={() => toggle(k.name)}
                    autoFocus={!phone && all.length <= TAG_FIND_FROM && k === shown[0]} />
                  <span className="tag-chip" style={tagStyle(k.name)}>#{k.name}</span>
                  <span className="tag-count">{k.count}</span>
                </label>
              ))}
              {!shown.length && <p className="muted small tag-filter-none">No tag matches “{find}”.</p>}
            </div>
            {picked.length > 0 && (
              <button type="button" className="link-btn small tag-filter-clear" onClick={() => onChange([])}>Clear tags</button>
            )}
          </div>
        </MenuSheet>
      )}
    </div>
  );
}
