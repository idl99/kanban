import { afterAll } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests run inside board and huddle runs too; their identity vars would leak into the code under test
// (and into fake claude children), so every test file starts without them.
for (const k of ["CKANBAN_TICKET", "CKANBAN_HUDDLE_AGENT", "CKANBAN_OUTPUT_DIR"]) delete process.env[k];

// Git in tests ignores the user's own git config: no commit signing (slow, may prompt), hooks or
// aliases from their setup. Commits get a fixed test identity.
const gitConfig = join(tmpdir(), "ckanban-test-gitconfig");
const gitConfigText = "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n";
let current = "";
try {
  current = readFileSync(gitConfig, "utf8");
} catch {}
if (current !== gitConfigText) writeFileSync(gitConfig, gitConfigText);
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";

// Delete the temp dirs a test file made (helpers.ts tempDir) once its tests are done, so runs don't pile them up.
afterAll(() => {
  const dirs: string[] = (globalThis as any).__ckTempDirs ?? [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
