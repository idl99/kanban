import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { useLayer } from "./layers";
import { inlineSlashQuery, insertInlineCommand, matchCommands, SLASH_GROUPS, slashQuery, sourceLabel, type SlashCommand } from "./slashText";

const GAP = 6;
const STALE_MS = 30_000;

// Per ticket (its worktree decides the project skills) or per board; refetched when older than STALE_MS.
const cache = new Map<string, { at: number; list: SlashCommand[] }>();

/** What `/` can run in this ticket's chat, or in the board's folder without a ticket. null while loading. */
export function useSlashCommands(slug: string, ticketId?: string): SlashCommand[] | null {
  const key = `${slug}/${ticketId ?? ""}`;
  const [list, setList] = useState<SlashCommand[] | null>(() => cache.get(key)?.list ?? null);
  useEffect(() => {
    setList(cache.get(key)?.list ?? null);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < STALE_MS) return;
    let live = true;
    (ticketId ? api.commands(slug, ticketId) : api.boardCommands(slug)).then((l) => {
      cache.set(key, { at: Date.now(), list: l });
      if (live) setList(l);
    }).catch(() => {});
    return () => { live = false; };
  }, [key]);
  return list;
}

/**
 * `/name` picker for the chat composer, like Claude Code's: typing `/` as the message's first character lists
 * skills, custom commands and built-ins in sections. ↑↓ choose, Enter/Tab insert `/name ` (not send), Esc closes.
 * `inline` (descriptions): `/` opens it at any word start, and the pick replaces just that word.
 * Wire `handlers` onto the textarea and call `onKeyDown` first in its key handler (true = handled).
 */
export function useSlashPicker({ commands, ref, setValue, inline = false }: {
  commands: SlashCommand[] | null;
  ref: RefObject<HTMLTextAreaElement | null>;
  setValue: (v: string) => void;
  inline?: boolean;
}) {
  const [q, setQ] = useState<{ start: number; query: string } | null>(null);
  const query = q?.query ?? null;
  const [active, setActive] = useState(0);
  // Esc closes the picker for this one `/` (chat: until the message no longer starts with "/").
  const dismissed = useRef<number | null>(null);
  const caret = useRef<number | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const matches = query !== null && commands ? matchCommands(commands, query) : [];
  const open = query !== null && matches.length > 0;

  useLayer(() => {
    if (q) dismissed.current = q.start;
    setQ(null);
  }, { active: open });

  useLayoutEffect(() => {
    const el = ref.current;
    if (caret.current === null || !el) return;
    el.focus();
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  // Keep the chosen row in view while arrowing through a long list.
  useLayoutEffect(() => {
    list.current?.querySelector(".slash-item.on")?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const update = () => {
    const el = ref.current;
    if (!el || el.selectionStart !== el.selectionEnd) return setQ(null);
    let next: { start: number; query: string } | null;
    if (inline) next = inlineSlashQuery(el.value, el.selectionStart);
    else {
      const word = slashQuery(el.value, el.selectionStart);
      next = word === null ? null : { start: 0, query: word };
    }
    // Chat: a dismissed picker stays closed until the message no longer starts with "/".
    if (inline ? !next || next.start !== dismissed.current : !el.value.startsWith("/")) dismissed.current = null;
    if (next && next.start === dismissed.current) return setQ(null);
    if (next?.start !== q?.start || next?.query !== query) setActive(0);
    setQ(next);
  };

  const insert = (i: number) => {
    const el = ref.current;
    const c = matches[i];
    if (!el || !c || !q) return;
    if (inline) {
      const r = insertInlineCommand(el.value, q.start, c.name);
      caret.current = r.caret;
      setValue(r.value);
    } else {
      // Replace the first word, keep whatever was typed after it.
      const rest = el.value.replace(/^\/\S*\s?/, "");
      const head = `/${c.name} `;
      caret.current = head.length;
      setValue(head + rest);
    }
    setQ(null);
  };

  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    const go = (d: number) => setActive((a) => (a + d + matches.length) % matches.length);
    if (e.key === "ArrowDown") go(1);
    else if (e.key === "ArrowUp") go(-1);
    else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) insert(active);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  let popup: React.ReactNode = null;
  const el = ref.current;
  if (open && el) {
    const rect = el.getBoundingClientRect();
    // Descriptions can sit in a narrow panel: wide enough to read what a skill does anyway.
    const width = Math.min(560, window.innerWidth - 16, Math.max(inline ? 380 : 300, rect.width - 24));
    const style: CSSProperties = { left: Math.min(rect.left + 12, window.innerWidth - width - 8), width };
    if (rect.top > 300) style.bottom = window.innerHeight - rect.top + GAP;
    else style.top = rect.bottom + GAP;
    let n = 0;
    popup = createPortal(
      <div ref={list} className="snippet-pop slash-pop" role="listbox" aria-label="Slash commands" style={style} onMouseDown={(e) => e.preventDefault()}>
        {SLASH_GROUPS.map((g) => {
          const items = matches.filter((c) => c.kind === g.kind);
          if (!items.length) return null;
          return (
            <div key={g.kind} role="group" aria-label={g.label}>
              <div className="slash-group">{g.label}</div>
              {items.map((c) => {
                const i = n++;
                return (
                  <div key={c.name} role="option" aria-selected={i === active} className={`slash-item${i === active ? " on" : ""}`}
                    onMouseEnter={() => setActive(i)} onClick={() => insert(i)}>
                    <b title={`/${c.name}`}>
                      {/* A long plugin namespace gives way first: the skill's own name stays readable. */}
                      <span className="slash-ns">/{c.name.includes(":") ? c.name.slice(0, c.name.lastIndexOf(":") + 1) : ""}</span>
                      <span className="slash-name">{c.name.slice(c.name.lastIndexOf(":") + 1)}</span>
                    </b>
                    <span title={c.description}>{c.description}</span>
                    <em className="snippet-scope">{sourceLabel(c)}</em>
                  </div>
                );
              })}
            </div>
          );
        })}
        <div className="snippet-foot">Type to filter · {matches.length} available</div>
      </div>,
      document.body,
    );
  }

  return {
    popup,
    onKeyDown,
    /** Spread on the textarea; re-checks the `/query` whenever the text or caret moves. */
    handlers: { onSelect: update, onBlur: () => setQ(null) },
  };
}
