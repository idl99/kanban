import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLayer } from "./layers";
import { firstLine, matchSnippets, replaceQuery, snippetQuery } from "./snippetText";
import { useSnippets } from "./snippets";

const GAP = 6;

/**
 * `@name` autocomplete for a markdown textarea: typing `@` at a word start lists the board's snippets,
 * ↑↓ choose, Enter/Tab replace `@query` with the snippet's full text, Esc closes.
 * Wire `handlers` onto the textarea and call `onKeyDown` first in its own key handler (true = handled).
 */
export function useSnippetPicker({ slug, ref, setValue }: {
  slug: string;
  ref: RefObject<HTMLTextAreaElement | null>;
  setValue: (v: string) => void;
}) {
  const snippets = useSnippets(slug);
  const [q, setQ] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  // Esc closes the popup for this one `@` (it reopens on a new one).
  const dismissed = useRef<number | null>(null);
  const caret = useRef<number | null>(null);

  const matches = q && snippets ? matchSnippets(snippets, q.query) : [];
  const empty = !!q && !!snippets && snippets.length === 0 && q.query === "";
  const open = !!q && (matches.length > 0 || empty);

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

  const update = () => {
    const el = ref.current;
    if (!el || el.selectionStart !== el.selectionEnd) return setQ(null);
    const next = snippetQuery(el.value, el.selectionStart);
    if (!next || next.start !== dismissed.current) dismissed.current = null;
    if (next && next.start === dismissed.current) return setQ(null);
    if (!next || q?.start !== next.start || q.query !== next.query) setActive(0);
    setQ(next);
  };

  const insert = (i: number) => {
    const el = ref.current;
    const s = matches[i];
    if (!el || !q || !s) return;
    const r = replaceQuery(el.value, q.start, q.start + 1 + q.query.length, s.text);
    caret.current = r.caret;
    setValue(r.value);
    setQ(null);
  };

  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open || !matches.length || e.nativeEvent.isComposing) return false;
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
    const width = Math.min(420, window.innerWidth - 16, Math.max(260, rect.width - 24));
    const style: CSSProperties = { left: Math.min(rect.left + 12, window.innerWidth - width - 8), width };
    // Above the textarea when there's room (chat composer sits at the bottom), else below.
    if (rect.top > 260) style.bottom = window.innerHeight - rect.top + GAP;
    else style.top = rect.bottom + GAP;
    popup = createPortal(
      <div className="snippet-pop" role="listbox" aria-label="Snippets" style={style} onMouseDown={(e) => e.preventDefault()}>
        {empty ? (
          <div className="snippet-empty">
            <b>No snippets yet</b>
            <span>Save reusable prompt text under <b>⋯ → Snippets</b>, then type <code>@name</code> here to insert it.</span>
          </div>
        ) : (
          <>
            {matches.map((s, i) => (
              <div key={s.id} role="option" aria-selected={i === active} className={`snippet-item${i === active ? " on" : ""}`}
                onMouseEnter={() => setActive(i)} onClick={() => insert(i)}>
                <b>@{s.name}{s.scope !== "global" && <span className="snippet-scope">this board</span>}</b>
                <span>{firstLine(s.text)}</span>
              </div>
            ))}
            <div className="snippet-foot"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Enter</kbd> insert text · <kbd>Esc</kbd> close</div>
          </>
        )}
      </div>,
      document.body,
    );
  }

  return {
    popup,
    onKeyDown,
    /** Spread on the textarea; re-checks the `@query` whenever the text or caret moves. */
    handlers: { onSelect: update, onBlur: () => setQ(null) },
  };
}
