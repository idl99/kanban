/** Keyboard moves between cards: J/K/↑/↓ in a column, H/L/←/→ to the neighbouring non-empty column. */
export type CardDir = "up" | "down" | "left" | "right";
export type CardPos = { col: number; row: number };

/** Key (ignoring modifiers) → direction, or null for keys that don't move between cards. */
export function cardDir(key: string): CardDir | null {
  switch (key) {
    case "j": case "J": case "ArrowDown": return "down";
    case "k": case "K": case "ArrowUp": return "up";
    case "h": case "H": case "ArrowLeft": return "left";
    case "l": case "L": case "ArrowRight": return "right";
    default: return null;
  }
}

/**
 * Next selected card, given the card count of each column. With nothing selected, any move picks the first
 * card of the first non-empty column. Moves clamp at the edges; sideways moves skip empty columns and keep
 * the row (or the last card when the column is shorter). Null when the board has no cards.
 */
export function stepCard(cols: number[], at: CardPos | null, dir: CardDir): CardPos | null {
  const first = cols.findIndex((n) => n > 0);
  if (first < 0) return null;
  if (!at || !cols[at.col]) return { col: first, row: 0 };
  const row = Math.min(at.row, cols[at.col] - 1);
  if (dir === "down") return { col: at.col, row: Math.min(cols[at.col] - 1, row + 1) };
  if (dir === "up") return { col: at.col, row: Math.max(0, row - 1) };
  const step = dir === "right" ? 1 : -1;
  for (let c = at.col + step; c >= 0 && c < cols.length; c += step) {
    if (cols[c] > 0) return { col: c, row: Math.min(row, cols[c] - 1) };
  }
  return { col: at.col, row };
}

/** Board `delta` steps away from the current one, wrapping around; the first board when the current one isn't listed. */
export function stepBoard(count: number, current: number, delta: number): number {
  if (count <= 0) return -1;
  if (current < 0) return 0;
  return (((current + delta) % count) + count) % count;
}

/** 1…9 → board index 0…8, by physical key so numpad digits work and the keyboard layout doesn't matter. */
export function boardDigit(code: string): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return m ? Number(m[1]) - 1 : null;
}

/** Focus is in a text field (input, textarea, contenteditable): single-letter and arrow shortcuts stay quiet. */
export function isTyping(e: { target: EventTarget | null }): boolean {
  const el = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || !!el.isContentEditable);
}

/** Plain ↑/K and ↓/J in the ticket panel: previous / next ticket. Null for other keys or with a modifier held. */
export function panelStep(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): "prev" | "next" | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  switch (e.key) {
    case "ArrowUp": case "k": case "K": return "prev";
    case "ArrowDown": case "j": case "J": return "next";
    default: return null;
  }
}

/** A proposal can be applied and started in one go only from Backlog or Planning, while Claude isn't working on it. */
export function canStartFromProposal(t: { status: string; working: boolean }): boolean {
  return !t.working && (t.status === "backlog" || t.status === "planning");
}

/**
 * ⌘⇧Enter in the ticket panel does the ticket's next step: apply a pending proposal first (and start work when it can),
 * then the column's action. A planner whose plan is finished moves to Done.
 */
export type NextStep = "apply" | "apply-start" | "start" | "done" | null;
export function nextStep(t: { status: string; working: boolean; proposalPending: boolean; planFinished?: boolean }): NextStep {
  if (t.working) return null;
  if (t.proposalPending) return canStartFromProposal(t) ? "apply-start" : "apply";
  if (t.planFinished && t.status !== "done") return "done";
  if (t.status === "backlog" || t.status === "planning") return "start";
  if (t.status === "review") return "done";
  return null;
}

/**
 * Hold ⌘ (Ctrl off Mac) to show key hints. "arm" starts the short reveal timer, "hide" cancels it and hides
 * the hints. Any other key hides them, so ⌘C / ⌘K never flash hints; key repeat of the held key changes nothing.
 */
export function hintStep(e: { type: "keydown" | "keyup"; key: string; repeat?: boolean }, mac: boolean): "arm" | "hide" | "none" {
  const hold = e.key === (mac ? "Meta" : "Control");
  if (e.type === "keyup") return hold ? "hide" : "none";
  if (!hold) return "hide";
  return e.repeat ? "none" : "arm";
}
