// Rewind end to end without a server: three exchanges, files edited in two of them, rewound to the second message.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/server/git";
import { applyRewind, previewRewind, takeSnapshot } from "../src/server/rewind";
import { parseSession } from "../src/server/session";
import { tempDir } from "./helpers";

async function project(history: boolean) {
  const dir = tempDir("ck-proj-");
  if (history) {
    await run(["git", "init", "-q", "-b", "main"], dir);
    writeFileSync(join(dir, "README.md"), "hi\n");
    await run(["git", "add", "."], dir);
    await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], dir);
  }
  return dir;
}

const line = (type: "user" | "assistant", uuid: string, ms: number, text: string) => JSON.stringify({
  type, uuid, timestamp: new Date(ms).toISOString(),
  message: { role: type, content: type === "user" ? text : [{ type: "text", text }] },
});

/** Claude edits one file in the second exchange and another in the third; snapshots are taken as the board does. */
async function chat(dir: string) {
  const T = Date.now() - 60_000;
  const lines: string[] = [];
  const texts = ["first", "second", "third"];
  for (let i = 0; i < 3; i++) {
    await takeSnapshot(dir, "t_1", texts[i], T + i * 10_000);
    lines.push(line("user", `u${i}`, T + i * 10_000 + 500, texts[i]), line("assistant", `a${i}`, T + i * 10_000 + 900, `done ${texts[i]}`));
    if (i === 1) writeFileSync(join(dir, "two.txt"), "from exchange 2\n");
    if (i === 2) writeFileSync(join(dir, "three.txt"), "from exchange 3\n");
  }
  const sessionFile = join(tempDir("ck-claude-"), "s.jsonl");
  writeFileSync(sessionFile, lines.join("\n") + "\n");
  const entry = parseSession(readFileSync(sessionFile, "utf8")).entries.find((e) => e.uuid === "u1")!;
  return { sessionFile, entry };
}

const texts = (file: string) => parseSession(readFileSync(file, "utf8")).entries.map((e) => e.text);

test("rewind to the second message: chat cut, both files back, the message's text returned", async () => {
  const dir = await project(true);
  const { sessionFile, entry } = await chat(dir);
  expect(entry.rewind).toBe(true);
  const preview = await previewRewind(dir, "t_1", entry);
  expect(preview.files!.map((c) => c.path).sort()).toEqual(["three.txt", "two.txt"]);

  const r = await applyRewind({ dir, ticketId: "t_1", entry, sessionFile, files: true });
  expect(r.restored).toBe(2);
  expect(r.cut.empty).toBe(false);
  expect(existsSync(join(dir, "two.txt"))).toBe(false);
  expect(existsSync(join(dir, "three.txt"))).toBe(false);
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("hi\n");
  expect(texts(sessionFile)).toEqual(["first", "done first"]);
  expect(entry.text).toBe("second");
});

test("chat only keeps the files", async () => {
  const dir = await project(true);
  const { sessionFile, entry } = await chat(dir);
  const r = await applyRewind({ dir, ticketId: "t_1", entry, sessionFile, files: false });
  expect(r.restored).toBe(0);
  expect(readFileSync(join(dir, "two.txt"), "utf8")).toBe("from exchange 2\n");
  expect(readFileSync(join(dir, "three.txt"), "utf8")).toBe("from exchange 3\n");
  expect(texts(sessionFile)).toEqual(["first", "done first"]);
});

test("a folder with no version history: the preview says so, the chat is cut, files are untouched", async () => {
  const dir = await project(false);
  const { sessionFile, entry } = await chat(dir);
  expect(await previewRewind(dir, "t_1", entry)).toEqual({ files: null, filesReason: "no-history" });
  const r = await applyRewind({ dir, ticketId: "t_1", entry, sessionFile, files: true });
  expect(r.restored).toBe(0);
  expect(readFileSync(join(dir, "two.txt"), "utf8")).toBe("from exchange 2\n");
  expect(texts(sessionFile)).toEqual(["first", "done first"]);
});

test("a message with no saved copy of the folder: chat only", async () => {
  const dir = await project(true);
  const { sessionFile, entry } = await chat(dir);
  const other = { ...entry, text: "typed in a terminal" };
  expect(await previewRewind(dir, "t_1", other)).toEqual({ files: null, filesReason: "no-snapshot" });
  expect(await previewRewind(null, "t_1", other)).toEqual({ files: null, filesReason: "no-history" });
  const r = await applyRewind({ dir, ticketId: "t_1", entry, sessionFile, files: true });
  expect(r.restored).toBe(2);
});
