import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, PlusIcon } from "./icons";
import { useLayer } from "./layers";

const GAP = 4;
const MARGIN = 8;

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

/** Plain text of a label for type-ahead (labels can be JSX). */
function textOf(n: ReactNode): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (typeof n === "object" && "props" in n) return textOf((n as any).props.children);
  return "";
}

/** Styled dropdown replacing the native <select>. Keyboard: Enter/Space/↓ open, ↑↓ move, type to jump, Enter pick, Esc close. */
export function Select<T extends string>({ value, options, onChange, footer, className, ariaLabel, renderValue, menuClassName, renderOption, menuMaxHeight = 320, badge }: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  /** Extra items under a divider, e.g. "New board…". */
  footer?: { label: ReactNode; onSelect: () => void; icon?: ReactNode }[];
  className?: string;
  ariaLabel?: string;
  renderValue?: (o: SelectOption<T> | undefined) => ReactNode;
  /** Extra class on the portaled menu, to restyle one dropdown without touching the others. */
  menuClassName?: string;
  /** Custom row content instead of the left check + label/hint column. */
  renderOption?: (o: SelectOption<T>, selected: boolean) => ReactNode;
  menuMaxHeight?: number;
  /** Extra content inside the root, e.g. a <KeyHint>. */
  badge?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  const listId = useId();
  const typed = useRef({ text: "", at: 0 });
  useLayer(() => setOpen(false), { active: open });
  const items = [
    ...options.map((o) => ({ kind: "option" as const, o })),
    ...(footer ?? []).map((f) => ({ kind: "footer" as const, f })),
  ];
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // The menu is portaled to <body> with position: fixed so scroll containers (e.g. the ticket
  // details column) can't clip it. Place it under the trigger, flipping up / shifting left to stay on screen.
  useLayoutEffect(() => {
    if (!open) {
      setPos({ visibility: "hidden" });
      return;
    }
    const place = () => {
      const trigger = root.current?.getBoundingClientRect();
      const m = menu.current;
      if (!trigger || !m) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (trigger.bottom < 0 || trigger.top > vh) {
        setOpen(false);
        return;
      }
      const w = m.offsetWidth;
      const h = m.offsetHeight;
      const left = Math.max(MARGIN, Math.min(trigger.left, vw - MARGIN - w));
      const below = vh - trigger.bottom - GAP - MARGIN;
      const above = trigger.top - GAP - MARGIN;
      const up = h > below && above > below;
      setPos(up
        ? { left, bottom: vh - trigger.top + GAP, minWidth: trigger.width, maxHeight: Math.min(menuMaxHeight, above) }
        : { left, top: trigger.bottom + GAP, minWidth: trigger.width, maxHeight: Math.min(menuMaxHeight, below) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const openMenu = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  const pick = (i: number) => {
    const it = items[i];
    if (!it) return;
    if (it.kind === "option") {
      if (it.o.disabled) return;
      onChange(it.o.value);
    } else {
      it.f.onSelect();
    }
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["Enter", " ", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Type-ahead: jump to the first option starting with what was typed in the last second.
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 1000 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const i = options.findIndex((o) => !o.disabled && textOf(o.label).trim().toLowerCase().startsWith(typed.current.text));
      if (i >= 0) setActive(i);
      return;
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className={`select ${open ? "open" : ""} ${className ?? ""}`} ref={root} onKeyDown={onKey}>
      <button type="button" className="select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        aria-controls={open ? listId : undefined} aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}>
        <span className="select-value">{renderValue ? renderValue(current) : current?.label ?? "Select…"}</span>
        <svg className="select-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {badge}
      {open && createPortal(
        <div className={`select-menu ${menuClassName ?? ""}`} role="listbox" id={listId} aria-label={ariaLabel} ref={menu} style={pos}>
          {items.map((it, i) =>
            it.kind === "option" ? (
              <div key={it.o.value} id={`${listId}-${i}`} role="option" aria-selected={it.o.value === value} aria-disabled={it.o.disabled}
                className={`select-item ${i === active ? "active" : ""} ${it.o.value === value ? "selected" : ""} ${it.o.disabled ? "disabled" : ""}`}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}>
                {renderOption ? renderOption(it.o, it.o.value === value) : <>
                  <span className="select-check" aria-hidden>{it.o.value === value && <CheckIcon size={12} />}</span>
                  <span className="select-label">{it.o.label}{it.o.hint && <span className="select-hint">{it.o.hint}</span>}</span>
                </>}
              </div>
            ) : (
              <div key={`f${i}`} id={`${listId}-${i}`} role="option" aria-selected={false} className={`select-item footer ${i === active ? "active" : ""} ${i === options.length ? "first-footer" : ""}`}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}>
                <span className="select-check" aria-hidden>{it.f.icon ?? <PlusIcon size={12} />}</span>
                <span className="select-label">{it.f.label}</span>
              </div>
            ),
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
