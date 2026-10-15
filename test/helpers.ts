import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/server/git";

/** Temp dirs made by this test file; test/preload.ts deletes them once the file's tests are done. */
export const tempDirs: string[] = ((globalThis as any).__ckTempDirs ??= []);

export function tempDir(prefix = "ck-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

export async function makeRepo(): Promise<string> {
  const dir = tempDir("ck-repo-");
  await run(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hi\n");
  await run(["git", "add", "."], dir);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], dir);
  return dir;
}

/** Wait until `cond()` holds, checking every 20ms; throws after `ms`. */
export async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

/**
 * The JSON lines a fake claude appended to `file` so far. A file it just created (still empty) or a
 * line it is still writing is skipped, so polling while fakes run never trips on a half-written line.
 */
export function readJsonl(file: string): any[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const out: any[] = [];
  for (const [i, l] of lines.entries()) {
    try {
      out.push(JSON.parse(l));
    } catch (e) {
      if (i < lines.length - 1) throw e;
    }
  }
  return out;
}
