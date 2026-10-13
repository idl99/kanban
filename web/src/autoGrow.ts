/** Grows the textarea with its text (up to `lines` lines, at most 30% of the window), then it scrolls.
 *  The cap is a whole number of lines plus the box's own padding, so no line shows half cut off. */
export function autoGrow(el: HTMLTextAreaElement | null, lines = 8) {
  if (!el) return;
  const cs = getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || 22;
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const fit = Math.max(1, Math.min(lines, Math.floor((window.innerHeight * 0.3 - pad - border) / line)));
  const max = fit * line + pad;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, max) + border}px`;
  el.style.overflowY = el.scrollHeight > max + 1 ? "auto" : "hidden";
}
