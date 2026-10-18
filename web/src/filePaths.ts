/** Finding file paths in chat text, so the ones that exist can be opened with a tap (FileLinks.tsx). */

const SEG = "[\\p{L}\\p{N}_@+.-]+";
const CODE_PATH = new RegExp(`^(?:~/|/|\\./)?${SEG}(?:/${SEG})*$`, "u");
const EXT = /\.[\p{L}\p{N}]{1,8}$/u;
/** In prose a path needs a folder and an extension: "notes/plan.md", "/Users/me/a.txt", "~/x/y.json". */
const TEXT_PATH = /(?<![\p{L}\p{N}_@+./~:-])((?:~\/|\/|\.\/)?(?:[\p{L}\p{N}_@+.-]+\/)+[\p{L}\p{N}_@+-][\p{L}\p{N}_@+.-]*\.[\p{L}\p{N}]{1,8})(?![\p{L}\p{N}_@+/-])/gu;

/**
 * The path an inline code span holds, or null. A long path Claude wrapped inside the backticks comes back as one
 * ("docs/plan-\nfinal.md" is "docs/plan-final.md"); text with other spaces is a command, not a path.
 */
export function codePath(code: string): string | null {
  const s = code.trim().replace(/([/-])\s+/g, "$1");
  if (!s || s.length > 400 || /\s/.test(s) || s.includes("://")) return null;
  if (!CODE_PATH.test(s) || s.startsWith("-") || /^\.+$/.test(s)) return null;
  if (!s.includes("/") && !EXT.test(s)) return null;
  if (s.endsWith("/")) return null;
  return s;
}

/** Paths in a run of prose, with where they are. */
export function textPaths(text: string): { at: number; path: string }[] {
  if (!text.includes("/")) return [];
  return [...text.matchAll(TEXT_PATH)].map((m) => ({ at: m.index!, path: m[1] }));
}
