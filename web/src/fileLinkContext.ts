import { createContext } from "react";

/** Lets Markdown inside a ticket turn file paths that exist into chips that open them (FileViewer.tsx). */
export interface FileLinks {
  /** Which of these paths (as written) exist in the ticket's folders. */
  find(paths: string[]): Promise<Set<string>>;
  open(path: string): void;
}

export const FileLinkContext = createContext<FileLinks | null>(null);

/** A path that wasn't there is asked about again after this long: the run may write it any moment. */
const MISSING_TTL = 15_000;

/** `find` with a memory: found paths stay found, missing ones are rechecked after a while, one request per batch. */
export function fileFinder(lookup: (paths: string[]) => Promise<string[]>, now = () => Date.now()): FileLinks["find"] {
  const found = new Set<string>();
  const missing = new Map<string, number>();
  return async (paths) => {
    const ask = [...new Set(paths)].filter((p) => !found.has(p) && !(now() - (missing.get(p) ?? -Infinity) < MISSING_TTL));
    if (ask.length) {
      try {
        const hits = new Set(await lookup(ask));
        for (const p of ask) {
          if (hits.has(p)) {
            found.add(p);
            missing.delete(p);
          } else missing.set(p, now());
        }
      } catch {}
    }
    return new Set(paths.filter((p) => found.has(p)));
  };
}
