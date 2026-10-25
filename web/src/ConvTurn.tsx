import { useEffect, useRef, useState, type ReactNode } from "react";
import { copy } from "./api";
import { avatarColor, avatarLetter } from "./avatar";
import { stepsSummary } from "./chatTurns";
import { CheckIcon, CopyIcon } from "./icons";
import { elapsed, fullTime, timeAgo } from "./time";
import { toast } from "./toast";

/**
 * The chat's message layout, shared by the ticket chat and quick chats (Claude panel, phone Ask tab): a turn is an
 * avatar and a "Claude · 3m ago" name line, then the replies, steps lines and cards under it. Rows that continue a
 * turn show no avatar or name (screen readers still hear the name).
 */

/** Claude's avatar: the spark on the accent colour. */
export function ClaudeAvatar() {
  return (
    <span className="turn-av claude" aria-hidden>
      <svg viewBox="0 0 24 24" fill="currentColor" focusable="false">
        <path d="M12 2l1.8 6.2L20 6l-4.2 4.9L22 12l-6.2 1.1L20 18l-6.2-2.2L12 22l-1.8-6.2L4 18l4.2-4.9L2 12l6.2-1.1L4 6l6.2 2.2z" />
      </svg>
    </span>
  );
}

/** A letter avatar (another ticket, later a teammate): colour from `seed`, so it stays the same everywhere. */
export function LetterAvatar({ seed, name }: { seed: string; name: string }) {
  return <span className="turn-av" style={{ background: avatarColor(seed) }} aria-hidden>{avatarLetter(name)}</span>;
}

export function Turn({ start, avatar = <ClaudeAvatar />, name = "Claude", sub, at, className, children }: {
  /** First row of the turn: shows the avatar and the name line. */
  start: boolean;
  avatar?: ReactNode;
  name?: ReactNode;
  /** After the name, e.g. "from another ticket". */
  sub?: ReactNode;
  at?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`turn${start ? " start" : ""}${className ? ` ${className}` : ""}`}>
      {start && avatar}
      {start && (
        <div className="turn-name">
          <b>{name}</b>
          {sub && <span>{sub}</span>}
          {at && <time dateTime={at} title={fullTime(at)}>{timeAgo(at)}</time>}
        </div>
      )}
      <div className="turn-body">
        {!start && typeof name === "string" && <span className="sr-only">{name}:</span>}
        {children}
      </div>
    </div>
  );
}

/** Copies the reply as shown; ✓ for a moment after. */
function CopyButton({ text }: { text: () => string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button type="button" className="act-btn" aria-label={done ? "Copied" : "Copy this reply"}
      onClick={async () => {
        if (!(await copy(text()))) return void toast("Couldn't copy: select the text and copy it instead", { tone: "error" });
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1500);
      }}>
      {done ? <CheckIcon size={13} /> : <CopyIcon size={13} />} {done ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * "Copy · Say it simpler" under a reply. On a computer it shows on hover or focus (always on the newest reply); on a
 * phone, under the last reply of each turn. active: something is going on in it (simplifying, simpler version shown).
 */
export function ReplyActions({ text, simpler, newest, lastOfTurn, active }: {
  text: () => string;
  simpler?: ReactNode;
  newest?: boolean;
  lastOfTurn?: boolean;
  active?: boolean;
}) {
  return (
    <div className={`reply-actions${newest ? " newest" : ""}${lastOfTurn ? " last-of-turn" : ""}${active ? " active" : ""}`}>
      <CopyButton text={text} />
      {simpler}
    </div>
  );
}

/** A run of tool calls: one line under the reply, "✓ Did 6 steps · last step"; click to see each step. */
export function StepsLine({ items, running, old, children }: {
  items: { text: string; error?: true }[];
  /** The run is on this step right now: spinner and "Step 4 · …". */
  running: boolean;
  old?: boolean;
  /** The step list (ToolRows). */
  children: ReactNode;
}) {
  const s = stepsSummary(items, running);
  return (
    <details className={`steps-line${old ? " inherited" : ""}`}>
      <summary>
        {running ? <span className="spinner" /> : <CheckIcon size={13} className="icon steps-ok" />}
        <span className="steps-text">{s.text}</span>
        {s.failed > 0 && <span className="steps-failed">· {s.failed} failed</span>}
      </summary>
      {children}
    </details>
  );
}

/** Claude's place while it works: spinner, what it is doing and for how long; dots before the first step shows. */
export function WorkingRow({ start, activity, step, startedAt, stalled, children }: {
  start: boolean;
  activity: string | null;
  /** How many steps this turn has taken so far: "Step 4 · Reading api.ts". */
  step?: number;
  startedAt?: string | null;
  /** No output for this many minutes: the row turns amber (children: what the user can do). */
  stalled?: number | null;
  children?: ReactNode;
}) {
  const since = startedAt ? elapsed(startedAt) : "";
  const early = !activity && !!startedAt && Date.now() - Date.parse(startedAt) < 3000;
  return (
    <Turn start={start} className="working">
      <div className={`working-row${stalled ? " stalled" : ""}`} role="status" aria-live="polite">
        {stalled ? <span>No output for {stalled} min</span>
          : early || (!activity && !startedAt) ? <span className="typing-dots" aria-label="Claude is working"><i /><i /><i /></span>
          : <><span className="spinner" /><span className="working-text">{step && activity ? `Step ${step} · ${activity}` : activity ?? "Working"}</span></>}
        {since && !stalled && <span className="working-time">· {since}</span>}
      </div>
      {children}
    </Turn>
  );
}

/** A run that ended with an error, on Claude's side: the first line, Retry and the full text behind Details. */
export function ErrorTurn({ error, onRetry, retryDisabled }: { error: string; onRetry?: () => void; retryDisabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const first = error.trim().split("\n")[0].slice(0, 240);
  return (
    <Turn start className="error">
      <div className="error-line" role="alert">
        <span>The run stopped with an error: {first}</span>
        <span className="error-actions">
          {onRetry && <button type="button" className="act-btn" disabled={retryDisabled} onClick={onRetry}>Retry</button>}
          <button type="button" className="act-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide details" : "Details"}</button>
        </span>
      </div>
      {open && <pre className="error-details">{error}</pre>}
    </Turn>
  );
}

export function TimeDivider({ label }: { label: string }) {
  return <div className="time-divider" role="separator"><span>{label}</span></div>;
}

/** Clicks on Stop this soon after it took Send's place are a double tap on Send, not a stop. */
const STOP_GUARD_MS = 800;

/**
 * The composer's main button: Send, or Stop while Claude works and there is nothing to send. With a draft typed during
 * a run, a small Stop sits next to Send.
 */
export function SendOrStop({ running, hasDraft, stopping, onStop, send }: {
  running: boolean;
  hasDraft: boolean;
  stopping: boolean;
  onStop: () => void;
  /** The Send button. */
  send: ReactNode;
}) {
  const alone = running && !hasDraft;
  const shownAt = useRef(0);
  useEffect(() => {
    if (alone) shownAt.current = Date.now();
  }, [alone]);
  const label = stopping ? "Stopping…" : "Stop";
  if (alone) {
    return (
      <button className="btn danger small stop-btn" disabled={stopping}
        onClick={() => Date.now() - shownAt.current >= STOP_GUARD_MS && onStop()}>
        <span aria-hidden>■</span> {label}
      </button>
    );
  }
  return (
    <>
      {running && (
        <button className="btn danger small stop-btn icon-only" disabled={stopping} onClick={onStop} aria-label={label} title={label}>
          <span aria-hidden>■</span>
        </button>
      )}
      {send}
    </>
  );
}
