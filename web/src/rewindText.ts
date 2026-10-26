/** Words of the Rewind confirmation (kept free of React so they can be unit tested). */

export type Change = { path: string; status: "A" | "D" | "M" };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 later messages are removed" */
export function laterLine(n: number): string {
  if (n <= 0) return "No later messages are removed";
  return `${plural(n, "later message is", "later messages are")} removed`;
}

/** "2 files change back: a.ts, b.ts" (at most 5 names, then "and N more"). */
export function filesLine(changes: Change[]): string {
  if (!changes.length) return "No files have changed since then";
  const names = changes.slice(0, 5).map((c) => c.path.split("/").pop()!);
  const more = changes.length - names.length;
  return `${plural(changes.length, "file changes", "files change")} back: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** Why files can't be changed back for this message. */
export function noFilesLine(reason: "no-history" | "no-snapshot" | null): string {
  return reason === "no-snapshot"
    ? "Files can't be changed back for this message: no copy of the folder was saved at that point."
    : "Files can't be changed back here: this folder has no version history.";
}

/** Why the Rewind button is off, or null when it can be used. */
export function rewindOff(running: boolean, queued: number): string | null {
  if (running) return "Claude is working. Stop it or wait until it has replied.";
  if (queued > 0) return "A message is still waiting to be sent. Send or discard it first.";
  return null;
}

/** The chat box after a rewind: the removed message, above whatever was typed meanwhile. */
export function restoredDraft(text: string, current: string): string {
  return current.trim() && current.trim() !== text.trim() ? `${text}\n\n${current}` : text;
}
