/** Pure text edits behind image paste (kept free of React/DOM so they can be unit tested). */

export type Edit = { value: string; start: number; end: number };

/**
 * Map an index in `from` to the matching index in `to`, assuming the two differ in one region (e.g. a
 * placeholder swapped in state but not yet rendered). An index inside the changed region lands after it.
 */
export function mapIndex(from: string, to: string, i: number): number {
  if (from === to) return i;
  let p = 0;
  const max = Math.min(from.length, to.length);
  while (p < max && from[p] === to[p]) p++;
  let s = 0;
  while (s < max - p && from[from.length - 1 - s] === to[to.length - 1 - s]) s++;
  if (i <= p) return i;
  if (i >= from.length - s) return to.length - (from.length - i);
  return to.length - s;
}

/**
 * Replace `value[start..end)` with the placeholders, one per line: a newline is added before them unless
 * they start a line, and after them unless they end the text or a line. The caret goes after the block.
 */
export function insertBlock(value: string, start: number, end: number, holders: string[]): Edit {
  const before = start > 0 && value[start - 1] !== "\n" ? "\n" : "";
  const after = end < value.length && value[end] !== "\n" ? "\n" : "";
  const text = before + holders.join("\n") + after;
  const caret = start + text.length;
  return { value: value.slice(0, start) + text + value.slice(end), start: caret, end: caret };
}

/**
 * Replace `holder` with `replacement`, moving a selection that sat after it by the length difference so it
 * never ends up inside the new text. An empty replacement also drops the line break the holder added.
 */
export function swapHolder(value: string, holder: string, replacement: string, start: number, end: number): Edit {
  let a = value.indexOf(holder);
  if (a < 0) return { value, start, end };
  let b = a + holder.length;
  if (!replacement) {
    if (a > 0 && value[a - 1] === "\n") a--;
    else if (value[b] === "\n") b++;
  }
  const shift = (i: number) => (i >= b ? i + replacement.length - (b - a) : i > a ? a + replacement.length : i);
  return { value: value.slice(0, a) + replacement + value.slice(b), start: shift(start), end: shift(end) };
}

/**
 * Where picked images go: at the selection once the user has been in the box, otherwise at the end (an
 * untouched box reports its caret at 0, and a phone user who taps the button first wants them below the text).
 */
export function pickRange(length: number, start: number, end: number, touched: boolean): [number, number] {
  return touched ? [start, end] : [length, length];
}
