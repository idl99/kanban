import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/server/git";
import { parseSession } from "../src/server/session";
import {
  changesSince, cutSession, listSnapshots, pruneSnapshots, restoreSnapshot, rewindSessionFile, snapshotFor, takeSnapshot, textKey,
} from "../src/server/rewind";
import { filesLine, laterLine, noFilesLine, restoredDraft, rewindOff } from "../web/src/rewindText";
import { tempDir } from "./helpers";

const commit = (dir: string, msg: string) =>
  run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", msg], dir);

/** A repo with one commit (signing off, so it works wherever the user's git is set to sign). */
async function makeRepo(): Promise<string> {
  const dir = tempDir("ck-repo-");
  await run(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hi\n");
  await run(["git", "add", "."], dir);
  await commit(dir, "init");
  return dir;
}

const user = (uuid: string, text: string, at = "2026-10-26T10:00:00Z") =>
  JSON.stringify({ type: "user", uuid, timestamp: at, message: { role: "user", content: text } });
const reply = (uuid: string, text: string) =>
  JSON.stringify({ type: "assistant", uuid, timestamp: "2026-10-26T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text }] } });

const session = [user("u1", "one"), reply("a1", "ok one"), user("u2", "two"), reply("a2", "ok two"), user("u3", "three"), reply("a3", "ok three")].join("\n") + "\n";

test("cutSession keeps everything before the chosen message", () => {
  const r = cutSession(session, "u2")!;
  expect(r.text).toBe([user("u1", "one"), reply("a1", "ok one")].join("\n") + "\n");
  expect(r.cut).toEqual({ kept: 2, empty: false });
  expect(parseSession(r.text).entries.map((e) => e.text)).toEqual(["one", "ok one"]);
});

test("cutSession at the first message leaves nothing of the conversation", () => {
  const r = cutSession(`${JSON.stringify({ type: "summary", summary: "x" })}\n${session}`, "u1")!;
  expect(r.cut.empty).toBe(true);
});

test("cutSession refuses messages it can't cut at safely", () => {
  expect(cutSession(session, "nope")).toBeNull();
  expect(cutSession(session, "a1")).toBeNull();
  const toolResult = JSON.stringify({ type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] } });
  expect(cutSession(`${session}${toolResult}\n`, "r1")).toBeNull();
});

test("only plain user messages can be rewound to", () => {
  const queued = JSON.stringify({ type: "attachment", uuid: "q1", timestamp: "2026-10-26T10:00:02Z", attachment: { type: "queued_command", commandMode: "prompt", prompt: "later" } });
  const entries = parseSession(`${session}${queued}\n`).entries;
  expect(entries.filter((e) => e.rewind).map((e) => e.uuid)).toEqual(["u1", "u2", "u3"]);
});

test("rewindSessionFile cuts the file and keeps the original beside it", () => {
  const file = join(tempDir("ck-rw-"), "s.jsonl");
  writeFileSync(file, session);
  expect(rewindSessionFile(file, "u3").kept).toBe(4);
  expect(readFileSync(file, "utf8")).toBe(session.split("\n").slice(0, 4).join("\n") + "\n");
  expect(readFileSync(`${file}.before-rewind`, "utf8")).toBe(session);
  expect(() => rewindSessionFile(file, "gone")).toThrow("can't be rewound");
});

const write = (dir: string, name: string, text: string) => {
  mkdirSync(join(dir, name, ".."), { recursive: true });
  writeFileSync(join(dir, name), text);
};
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

test("restoreSnapshot puts files back: edited, deleted and new ones, work in progress included", async () => {
  const dir = await makeRepo();
  write(dir, "a.txt", "a0");
  write(dir, "b.txt", "b0");
  await run(["git", "add", "."], dir);
  await commit(dir, "files");
  write(dir, "a.txt", "a-uncommitted"); // the user's own work before the message
  write(dir, "sub/deep/c.txt", "c0");
  const ref = (await takeSnapshot(dir, "t_1", "do it", 1000))!;
  expect(ref).toContain("refs/ckanban/rewind/t_1/1000-");
  const headBefore = (await run(["git", "rev-parse", "HEAD"], dir)).stdout;

  write(dir, "a.txt", "a-claude");
  await run(["rm", "b.txt"], dir);
  write(dir, "new/d.txt", "d");
  await run(["rm", "sub/deep/c.txt"], dir);
  write(dir, "sub/deep/e.txt", "e");

  const changes = (await changesSince(dir, ref))!;
  expect(changes.map((c) => `${c.status} ${c.path}`).sort()).toEqual(["A new/d.txt", "A sub/deep/e.txt", "D b.txt", "D sub/deep/c.txt", "M a.txt"]);
  await restoreSnapshot(dir, ref);
  expect(read(dir, "a.txt")).toBe("a-uncommitted");
  expect(read(dir, "b.txt")).toBe("b0");
  expect(read(dir, "sub/deep/c.txt")).toBe("c0");
  expect(existsSync(join(dir, "new"))).toBe(false);
  expect(existsSync(join(dir, "sub/deep/e.txt"))).toBe(false);
  expect(existsSync(join(dir, "README.md"))).toBe(true);
  expect(await changesSince(dir, ref)).toEqual([]);
  // The user's own history and staging area are untouched.
  expect((await run(["git", "rev-parse", "HEAD"], dir)).stdout).toBe(headBefore);
  expect((await run(["git", "diff", "--cached", "--name-only"], dir)).stdout).toBe("");
  expect((await run(["git", "branch", "--list"], dir)).stdout.trim()).toBe("* main");
});

test("snapshots are found by message text and time, and newer ones are pruned", async () => {
  const dir = await makeRepo();
  await takeSnapshot(dir, "t_2", "continue", 1000);
  write(dir, "x.txt", "1");
  await takeSnapshot(dir, "t_2", "continue", 5000);
  await takeSnapshot(dir, "t_2", "other", 3000);
  await takeSnapshot(dir, "t_other", "continue", 2000);
  const snaps = await listSnapshots(dir, "t_2");
  expect(snaps.map((s) => s.at)).toEqual([1000, 3000, 5000]);
  expect(snapshotFor(snaps, "continue", new Date(2000).toISOString())?.at).toBe(1000);
  expect(snapshotFor(snaps, "continue", new Date(6000).toISOString())?.at).toBe(5000);
  expect(snapshotFor(snaps, "never sent", new Date(6000).toISOString())).toBeNull();
  expect(textKey(" hi ")).toBe(textKey("hi"));
  await pruneSnapshots(dir, "t_2", snaps[0]);
  expect((await listSnapshots(dir, "t_2")).map((s) => s.at)).toEqual([1000]);
  expect((await listSnapshots(dir, "t_other")).length).toBe(1);
});

test("without version history nothing is saved and files stay as they are", async () => {
  const plain = tempDir("ck-plain-");
  write(plain, "a.txt", "a");
  expect(await takeSnapshot(plain, "t_3", "hi")).toBeNull();
  expect(await changesSince(plain, "refs/ckanban/rewind/t_3/1-abc")).toBeNull();
  await expect(restoreSnapshot(plain, "refs/ckanban/rewind/t_3/1-abc")).rejects.toThrow("no version history");
  expect(read(plain, "a.txt")).toBe("a");

  const empty = tempDir("ck-empty-");
  await run(["git", "init", "-q", "-b", "main"], empty);
  write(empty, "a.txt", "a");
  expect(await takeSnapshot(empty, "t_3", "hi")).toBeNull();
});

test("the confirmation words", () => {
  expect(laterLine(1)).toBe("1 later message is removed");
  expect(laterLine(3)).toBe("3 later messages are removed");
  expect(filesLine([{ path: "src/a.ts", status: "M" }])).toBe("1 file changes back: a.ts");
  const many = Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.ts`, status: "M" as const }));
  expect(filesLine(many)).toBe("7 files change back: f0.ts, f1.ts, f2.ts, f3.ts, f4.ts and 2 more");
  expect(filesLine([])).toBe("No files have changed since then");
  expect(noFilesLine("no-history")).toContain("no version history");
  expect(rewindOff(true, 0)).toContain("Claude is working");
  expect(rewindOff(false, 1)).toContain("waiting");
  expect(rewindOff(false, 0)).toBeNull();
  expect(restoredDraft("msg", "")).toBe("msg");
  expect(restoredDraft("msg", "typed")).toBe("msg\n\ntyped");
});
