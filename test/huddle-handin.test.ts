// Huddles: helpers that change files hand their changes in from their own copy; a lead, @main or the user accepts or
// rejects them. The same flow on a git repo, a repo with no commits and a plain folder.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTool } from "../src/mcp-server";
import type { Huddle } from "../src/server/types";
import { agentCtx, board, git, heardBy, host, huddles, idle, mainCtx, messages, participant, postJson, processes, store, text, until, useHuddleEnv, you } from "./huddle-env";
import { tempDir } from "./helpers";

useHuddleEnv();

type Kind = "git" | "no commits" | "plain folder";
const KINDS: Kind[] = ["git", "no commits", "plain folder"];

/** Points the board at a project of this kind with app.txt and old.txt in it; returns the host ticket's folder. */
async function project(kind: Kind) {
  if (kind !== "git") {
    const dir = tempDir("ck-proj-");
    if (kind === "no commits") await git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "app.txt"), "one\n");
    writeFileSync(join(dir, "old.txt"), "old\n");
    store.saveProfile({ ...store.getProfile("p")!, path: dir });
  } else {
    const repo = store.getProfile("p")!.path;
    writeFileSync(join(repo, "app.txt"), "one\n");
    writeFileSync(join(repo, "old.txt"), "old\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "files");
  }
  const t = await host();
  const dir = (await board.ensureSession("p", t.id)).dir;
  return { t, dir };
}

const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : null);
const handIns = (h: Huddle) => store.getHuddle("p", h.id)!.handIns ?? [];

for (const kind of KINDS) {
  test(`${kind}: a helper hands in its changes and accepting brings them into the ticket's folder`, async () => {
    const { t, dir } = await project(kind);
    const h = huddles.create("p", t.id, [{ preset: "designer" }]);
    await idle();
    const copy = participant(h, "designer").copy!;
    expect(copy.kind).toBe(kind === "git" ? "git" : "folder");
    expect(processes()[0].cwd).toBe(copy.dir);
    // @main keeps working meanwhile (not saved anywhere yet): accepting must not touch it.
    writeFileSync(join(dir, "main-wip.txt"), "mine\n");
    // The designer changes, adds and removes files in its copy.
    writeFileSync(join(copy.dir, "app.txt"), "two\n");
    writeFileSync(join(copy.dir, "logo.svg"), "<svg/>\n");
    unlinkSync(join(copy.dir, "old.txt"));
    const r = text(await callTool("huddle_hand_in", { summary: "New logo, app text, old file gone" }, agentCtx(h, "designer")));
    expect(r).toContain("Handed in c1 (3 files: changed app.txt, added logo.svg, removed old.txt)");
    // Edits after the hand-in don't change what was handed in.
    writeFileSync(join(copy.dir, "app.txt"), "three\n");
    expect(handIns(h)[0]).toMatchObject({ id: "c1", from: "designer", status: "waiting", summary: "New logo, app text, old file gone" });
    const card = messages(h).find((m) => m.kind === "handin")!;
    expect(card).toMatchObject({ from: "designer", handIn: "c1", mentions: ["main"] });
    expect(card.text).toContain("changed app.txt, added logo.svg, removed old.txt");
    // Nothing reached the ticket's folder yet.
    expect(read(join(dir, "app.txt"))).toBe("one\n");
    // A second hand-in waits for the first one's decision.
    expect(text(await callTool("huddle_hand_in", { summary: "more" }, agentCtx(h, "designer")))).toContain("still waits for a decision");
    // The user accepts from the board.
    const res = await postJson(`/huddles/${h.id}/hand-ins/c1/accept`, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe("accepted");
    expect(read(join(dir, "app.txt"))).toBe("two\n");
    expect(read(join(dir, "logo.svg"))).toBe("<svg/>\n");
    expect(read(join(dir, "old.txt"))).toBeNull();
    expect(read(join(dir, "main-wip.txt"))).toBe("mine\n");
    expect(handIns(h)[0]).toMatchObject({ status: "accepted", by: "you" });
    const note = messages(h).at(-1)!;
    expect(note.text).toContain("@you accepted @designer's changes (c1): 3 files now in the ticket's folder. @main: they are in your folder now.");
    expect(note.mentions).toEqual(["main"]);
    // The next hand-in counts from what was accepted: only the later edit.
    expect(text(await callTool("huddle_hand_in", { summary: "Shorter text" }, agentCtx(h, "designer")))).toContain("Handed in c2 (1 file: changed app.txt)");
    await idle();
    huddles.stopAll("p", h.id);
  }, 30000);

  test(`${kind}: a rejected hand-in changes nothing and tells the helper why`, async () => {
    const { t, dir } = await project(kind);
    const h = huddles.create("p", t.id, [{ preset: "engineer" }, { preset: "qa" }]);
    await idle();
    const copy = participant(h, "engineer").copy!;
    writeFileSync(join(copy.dir, "app.txt"), "broken\n");
    await callTool("huddle_hand_in", { summary: "Faster app" }, agentCtx(h, "engineer"));
    // Only a lead, @main or the user decides.
    const qa = await callTool("huddle_review_changes", { id: "c1", accept: true }, agentCtx(h, "qa"));
    expect(qa.isError).toBe(true);
    expect(text(qa)).toContain("only a lead, @main or the user");
    expect((await callTool("huddle_review_changes", { id: "c1", accept: false }, mainCtx(h))).isError).toBe(true);
    await idle();
    const heard = heardBy("engineer").length;
    expect(text(await callTool("huddle_review_changes", { id: "c1", accept: false, reason: "breaks the tests" }, mainCtx(h)))).toContain("Rejected c1");
    expect(read(join(dir, "app.txt"))).toBe("one\n");
    expect(handIns(h)[0]).toMatchObject({ status: "rejected", by: "main", reason: "breaks the tests" });
    expect(messages(h).at(-1)!).toMatchObject({ kind: "system", mentions: ["engineer"] });
    expect(messages(h).at(-1)!.text).toContain("@main rejected @engineer's changes (c1): breaks the tests");
    await until(() => heardBy("engineer").length > heard);
    expect(heardBy("engineer").at(-1)).toContain("breaks the tests");
    // Decided once.
    expect(text(await callTool("huddle_review_changes", { id: "c1", accept: true }, mainCtx(h)))).toContain("already rejected");
    await idle();
    huddles.stopAll("p", h.id);
  }, 30000);

  test(`${kind}: a conflict applies nothing and gives the helper a fresh copy to redo it`, async () => {
    const { t, dir } = await project(kind);
    const h = huddles.create("p", t.id, [{ preset: "engineer" }]);
    await idle();
    const copy = participant(h, "engineer").copy!;
    writeFileSync(join(copy.dir, "app.txt"), "helper\n");
    writeFileSync(join(copy.dir, "extra.txt"), "extra\n");
    await callTool("huddle_hand_in", { summary: "Rewrite app" }, agentCtx(h, "engineer"));
    // Meanwhile @main changed the same file in the ticket's folder.
    writeFileSync(join(dir, "app.txt"), "main\n");
    await idle();
    const heard = heardBy("engineer").length;
    const r = text(await callTool("huddle_review_changes", { id: "c1", accept: true }, mainCtx(h)));
    expect(r).toContain("Conflict on c1: the ticket's folder also changed app.txt");
    // Nothing was applied, not even the file without a conflict.
    expect(read(join(dir, "app.txt"))).toBe("main\n");
    expect(read(join(dir, "extra.txt"))).toBeNull();
    expect(handIns(h)[0]).toMatchObject({ status: "conflict", conflicts: ["app.txt"] });
    const note = messages(h).at(-1)!;
    expect(note.mentions).toEqual(["engineer"]);
    expect(note.text).toContain("@engineer's changes (c1) weren't brought in: the ticket's folder also changed app.txt");
    expect(note.text.replace(/\/\S+/g, "")).not.toMatch(/branch|worktree|commit|merge/i);
    // The helper's copy is fresh: the ticket's folder as it is now, its own change gone (saved with the hand-in).
    const fresh = participant(h, "engineer").copy!;
    expect(fresh.dir).toBe(copy.dir);
    expect(read(join(fresh.dir, "app.txt"))).toBe("main\n");
    expect(read(join(fresh.dir, "extra.txt"))).toBeNull();
    expect(note.text).toContain(`${copy.dir}.handins/c1`);
    expect(read(join(`${copy.dir}.handins`, "c1", "app.txt"))).toBe("helper\n");
    await until(() => heardBy("engineer").length > heard);
    expect(heardBy("engineer").at(-1)).toContain("redo your change there");
    // Redone on the fresh copy, it goes in.
    writeFileSync(join(fresh.dir, "app.txt"), "main and helper\n");
    expect(text(await callTool("huddle_hand_in", { summary: "Rewrite app again" }, agentCtx(h, "engineer")))).toContain("Handed in c2 (1 file: changed app.txt)");
    expect(text(await callTool("huddle_review_changes", { id: "c2", accept: true }, mainCtx(h)))).toContain("Accepted c2");
    expect(read(join(dir, "app.txt"))).toBe("main and helper\n");
    await idle();
    huddles.stopAll("p", h.id);
  }, 30000);
}

test("read-only helpers can't hand in; a lead or @main lets them change files, and they get a copy", async () => {
  const { t, dir } = await project("git");
  const h = huddles.create("p", t.id, [{ preset: "researcher" }, { preset: "qa" }]);
  await idle();
  expect(participant(h, "researcher")).toMatchObject({ canEdit: false, workspace: "shared" });
  const snap = participant(h, "researcher").worktree!;
  expect(existsSync(snap)).toBe(true);
  expect(text(await callTool("huddle_hand_in", { summary: "x" }, agentCtx(h, "researcher")))).toContain("ask @main or a lead to let you");
  // Only a lead, @main or the user grants it.
  expect((await callTool("huddle_allow_changes", { handle: "researcher" }, agentCtx(h, "qa"))).isError).toBe(true);
  expect(text(await callTool("huddle_allow_changes", { handle: "@researcher" }, mainCtx(h)))).toContain("@researcher can change files now");
  await idle();
  const p = participant(h, "researcher");
  expect(p).toMatchObject({ canEdit: true, workspace: "own", worktree: null, snapshot: null });
  expect(p.copy).toMatchObject({ kind: "git", dir: snap });
  expect(messages(h).some((m) => m.text.includes("@main let @researcher change files"))).toBe(true);
  // Its new run works in the copy with the edit tools.
  const last = processes().at(-1)!;
  expect(last.cwd).toBe(snap);
  expect(last.args).not.toContain("--disallowedTools");
  writeFileSync(join(p.copy!.dir, "app.txt"), "fixed\n");
  expect(text(await callTool("huddle_hand_in", { summary: "Fix what I found" }, agentCtx(h, "researcher")))).toContain("Handed in c1");
  expect(text(await callTool("huddle_review_changes", { id: "c1", accept: true }, mainCtx(h)))).toContain("Accepted c1");
  expect(read(join(dir, "app.txt"))).toBe("fixed\n");
  await idle();
  huddles.stopAll("p", h.id);
}, 30000);

test("in Planning nobody gets a copy or the right to change files", async () => {
  const { t } = await project("plain folder");
  store.updateTicket("p", t.id, { status: "planning" });
  const h = huddles.create("p", t.id, [{ preset: "engineer" }]);
  await idle();
  expect(participant(h, "engineer")).toMatchObject({ canEdit: false, workspace: "shared" });
  expect(participant(h, "engineer").copy ?? null).toBeNull();
  expect(text(await callTool("huddle_allow_changes", { handle: "engineer" }, mainCtx(h)))).toContain("Planning");
  huddles.stopAll("p", h.id);
}, 30000);

test("an outside edit of the huddle file can't accept a hand-in or move a helper's copy", async () => {
  const { t, dir } = await project("plain folder");
  const h = huddles.create("p", t.id, [{ preset: "engineer" }]);
  await idle();
  const copy = participant(h, "engineer").copy!;
  writeFileSync(join(copy.dir, "app.txt"), "two\n");
  await callTool("huddle_hand_in", { summary: "x" }, agentCtx(h, "engineer"));
  const raw = store.getHuddle("p", h.id)!;
  raw.handIns![0].status = "accepted";
  raw.participants.find((p) => p.handle === "engineer")!.copy!.dir = dir;
  store.saveHuddle("p", raw);
  const back = huddles.get("p", h.id);
  expect(back.handIns![0].status).toBe("waiting");
  expect(back.participants.find((p) => p.handle === "engineer")!.copy!.dir).toBe(copy.dir);
  await idle();
  huddles.stopAll("p", h.id);
}, 30000);

test("symlinks: a plain copy keeps them as they are, and accept never writes through one in the ticket's folder", async () => {
  const { t, dir } = await project("plain folder");
  const outside = tempDir("ck-outside-");
  writeFileSync(join(outside, "target.txt"), "keep\n");
  symlinkSync(join(outside, "target.txt"), join(dir, "config.txt"));
  symlinkSync(outside, join(dir, "linkdir"));
  symlinkSync("app.txt", join(dir, "alias.txt"));
  const h = huddles.create("p", t.id, [{ preset: "engineer" }]);
  await idle();
  const copy = participant(h, "engineer").copy!;
  // A relative link stays relative, so it points inside the copy, not at the ticket's folder.
  expect(readlinkSync(join(copy.dir, "alias.txt"))).toBe("app.txt");
  // The helper swaps the links for real files and folders and hands them in.
  for (const f of ["config.txt", "linkdir"]) rmSync(join(copy.dir, f));
  writeFileSync(join(copy.dir, "config.txt"), "evil\n");
  mkdirSync(join(copy.dir, "linkdir"));
  writeFileSync(join(copy.dir, "linkdir", "planted.sh"), "echo hi\n");
  await callTool("huddle_hand_in", { summary: "x" }, agentCtx(h, "engineer"));
  const r = text(await callTool("huddle_review_changes", { id: "c1", accept: true }, mainCtx(h)));
  expect(r).toContain("Conflict on c1");
  expect(handIns(h)[0].conflicts!.sort()).toEqual(["config.txt", "linkdir/planted.sh"]);
  expect(read(join(outside, "target.txt"))).toBe("keep\n");
  expect(existsSync(join(outside, "planted.sh"))).toBe(false);
  await idle();
  huddles.stopAll("p", h.id);
}, 30000);

test("a conflict saves the helper's later, never handed-in edits; closing keeps them and what it handed in", async () => {
  const { t, dir } = await project("plain folder");
  const h = huddles.create("p", t.id, [{ preset: "engineer" }]);
  await idle();
  const copy = participant(h, "engineer").copy!;
  writeFileSync(join(copy.dir, "app.txt"), "helper\n");
  await callTool("huddle_hand_in", { summary: "Rewrite app" }, agentCtx(h, "engineer"));
  // It keeps working after the hand-in; @main changes the same file meanwhile.
  writeFileSync(join(copy.dir, "later.txt"), "later\n");
  writeFileSync(join(dir, "app.txt"), "main\n");
  await idle();
  expect(text(await callTool("huddle_review_changes", { id: "c1", accept: true }, mainCtx(h)))).toContain("Conflict on c1");
  const saved = messages(h).find((m) => m.text.includes("never handed in to"))!;
  expect(saved.text).toContain(`${copy.dir}.kept/`);
  const keptAt = saved.text.match(/to (\S+) before/)![1];
  expect(read(join(keptAt, "later.txt"))).toBe("later\n");
  expect(read(join(copy.dir, "later.txt"))).toBeNull();
  await idle();
  huddles.close("p", h.id);
  await idle();
  expect(existsSync(copy.dir)).toBe(false);
  expect(read(join(`${copy.dir}.handins`, "c1", "app.txt"))).toBe("helper\n");
  expect(read(join(keptAt, "later.txt"))).toBe("later\n");
  const note = messages(h).at(-1)!.text;
  expect(note).toContain(`${copy.dir}.handins (changes that weren't brought in because of a conflict)`);
  expect(note).toContain(`${copy.dir}.kept (changes saved before a fresh copy was made)`);
}, 30000);

test("a helper can't accept its own hand-in or give itself the right to change files", async () => {
  const { t } = await project("plain folder");
  const h = huddles.create("p", t.id, [{ preset: "engineer", lead: true }, { preset: "reviewer", lead: true }]);
  await idle();
  writeFileSync(join(participant(h, "engineer").copy!.dir, "app.txt"), "x\n");
  await callTool("huddle_hand_in", { summary: "x" }, agentCtx(h, "engineer"));
  expect(text(await callTool("huddle_review_changes", { id: "c1", accept: true }, agentCtx(h, "engineer")))).toContain("your own hand-in");
  expect(text(await callTool("huddle_allow_changes", { handle: "reviewer" }, agentCtx(h, "reviewer")))).toContain("give yourself");
  await idle();
  huddles.stopAll("p", h.id);
}, 30000);
