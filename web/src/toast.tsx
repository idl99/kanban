import { useSyncExternalStore, type ReactNode } from "react";
import { CloseIcon } from "./icons";

type Tone = "info" | "ok" | "error";
interface Toast {
  id: number;
  text: ReactNode;
  tone: Tone;
  action?: { label: string; run: () => void };
}

let toasts: Toast[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const emit = () => subs.forEach((f) => f());
let touch: { x: number; y: number } | null = null;

export function dismissToast(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function arm(id: number, ms: number) {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => dismissToast(id), ms));
}

/** Small message at the bottom of the screen that goes away on its own. Errors stay longer. */
export function toast(text: ReactNode, opts: { tone?: Tone; action?: Toast["action"]; ms?: number } = {}): number {
  const tone = opts.tone ?? "info";
  const id = nextId++;
  // Same text twice in a row (e.g. a retry that fails again): replace instead of stacking.
  toasts = [...toasts.filter((t) => !(typeof text === "string" && t.text === text)), { id, text, tone, action: opts.action }].slice(-4);
  emit();
  arm(id, opts.ms ?? (tone === "error" ? 8000 : opts.action ? 7000 : 4000));
  return id;
}

export function Toaster() {
  const list = useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => toasts);
  if (!list.length) return null;
  return (
    <div className="toaster">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} role={t.tone === "error" ? "alert" : "status"}
          onMouseEnter={() => clearTimeout(timers.get(t.id))} onMouseLeave={() => arm(t.id, 3000)}
          // Phone: swipe it up (or sideways) to dismiss.
          onTouchStart={(e) => { touch = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
          onTouchEnd={(e) => {
            const p = e.changedTouches[0];
            if (touch && (touch.y - p.clientY > 24 || Math.abs(p.clientX - touch.x) > 60)) dismissToast(t.id);
            touch = null;
          }}>
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button className="toast-action" onClick={() => { t.action!.run(); dismissToast(t.id); }}>{t.action.label}</button>
          )}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)}><CloseIcon size={12} /></button>
        </div>
      ))}
    </div>
  );
}
