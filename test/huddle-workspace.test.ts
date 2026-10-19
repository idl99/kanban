// Huddles: stopping, board slots and where agents work (worktrees, snapshots, plain folders).
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTool } from "../src/mcp-server";
import { git, store, board, huddles, server, client, setup, idle, heard, heardBy, processes, host, participant, agentCtx, you, messages, until, useHuddleEnv } from "./huddle-env";
import { tempDir } from "./helpers";

useHuddleEnv();

test("stop agents stops every huddle run and routing until resumed; close keeps the history read-only", async () => {
  await Promise.all([board.shutdown(), huddles.shutdown()]);
  server.stop(true);
  await setup(60_000);
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "qa", count: 2 }, { preset: "reviewer" }]);
  await until(() => heardBy("qa-1").length === 1 && heardBy("qa-2").length === 1 && heardBy("reviewer").length === 1);
  expect(huddles.isRunning("p", store.getHuddle("p", h.id)!, participant(h, "qa-1"))).toBe(true);
  // Only the user can stop.
  const r = await fetch(`${client.url}/api/profiles/p/huddles/${h.id}/stop`, {
    method: "POST", headers: { "content-type": "application/json", "x-ckanban-run": `p/${t.id}` }, body: "{}",
  });
  expect(r.status).toBe(403);
  const res = await fetch(`${client.url}/api/profiles/p/huddles/${h.id}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(((await res.json()) as any).status).toBe("stopped");
  await idle();
  const stopped = store.getHuddle("p", h.id)!;
  expect(stopped.participants.filter((p) => p.kind === "agent").every((p) => p.status === "stopped")).toBe(true);
  // Stop agents leaves the tickets' own sessions alone.
  expect(participant(h, "main").status).toBe("idle");
  expect(messages(h).at(-1)!.text).toContain("The tickets' own runs keep going");
  for (const p of stopped.participants) expect(huddles.isRunning("p", stopped, p)).toBe(false);
  // Stopped: messages are kept, nobody wakes; stopped agents can't post.
  const n = heard().length;
  huddles.post("p", h.id, you(h), "@all still there?");
  await idle();
  expect(heard().length).toBe(n);
  expect((await callTool("huddle_post", { text: "x" }, agentCtx(h, "qa-1"))).isError).toBe(true);
  // Resume: routing again.
  huddles.resume("p", h.id);
  huddles.post("p", h.id, you(h), "@reviewer go");
  await until(() => heardBy("reviewer").length === 2);
  // Close: every run stops, history stays and is read-only.
  huddles.close("p", h.id);
  await idle();
  const closed = store.getHuddle("p", h.id)!;
  expect(closed.status).toBe("closed");
  expect(closed.closedAt).toBeTruthy();
  for (const p of closed.participants) expect(huddles.isRunning("p", closed, p)).toBe(false);
  expect(() => huddles.post("p", h.id, you(h), "hello?")).toThrow("closed (read-only)");
  expect(() => huddles.resume("p", h.id)).toThrow("closed");
  expect(messages(h).at(-1)!.text).toContain("Huddle closed by @you");
  const page = await client.huddleRead("p", h.id, {}, {});
  expect(page.messages.length).toBe(messages(h).length);
  // A new huddle can start on the ticket once the old one is closed.
  expect(huddles.create("p", t.id, [{ preset: "reviewer" }]).status).toBe("live");
}, 30000);

test("huddle runs don't take board slots", async () => {
  await Promise.all([board.shutdown(), huddles.shutdown()]);
  server.stop(true);
  await setup(60_000, 1);
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "qa", count: 2 }]);
  await until(() => heardBy("qa-1").length === 1 && heardBy("qa-2").length === 1);
  expect(huddles.isRunning("p", store.getHuddle("p", h.id)!, participant(h, "qa-1"))).toBe(true);
  expect(board.running("p")).toBe(0);
  // maxParallel is 1 and two huddle agents are live: a Ready ticket still starts.
  const work = await board.createTicket("p", { title: "Work", body: "", status: "ready" });
  expect(board.isRunning("p", work.id)).toBe(true);
  expect(board.running("p")).toBe(1);
  huddles.stopAll("p", h.id);
}, 30000);

test("own workspace: the agent gets a copy of the host's folder as it is now and may edit there", async () => {
  const t = await host();
  await board.ensureSession("p", t.id);
  const hostDir = store.getTicket("p", t.id)!.worktree!;
  // @main's work in progress, committed or not, is in the helper's copy; the host's index and files stay as they were.
  writeFileSync(join(hostDir, "README.md"), "wip\n");
  writeFileSync(join(hostDir, "new.txt"), "new\n");
  const status = await git(hostDir, "status", "--porcelain");
  const h = huddles.create("p", t.id, [{ preset: "engineer", focus: "API" }]);
  await idle();
  const p = participant(h, "engineer");
  expect(p).toMatchObject({ canEdit: true, workspace: "own" });
  expect(p.worktree ?? null).toBeNull();
  expect(p.copy).toMatchObject({ kind: "git", branch: `ck/${t.id}-engineer` });
  expect(p.copy!.dir).toContain(`${t.id}.huddle`);
  expect(readFileSync(join(p.copy!.dir, "README.md"), "utf8")).toBe("wip\n");
  expect(readFileSync(join(p.copy!.dir, "new.txt"), "utf8")).toBe("new\n");
  expect(await git(p.copy!.dir, "status", "--porcelain")).toBe("");
  expect(await git(hostDir, "status", "--porcelain")).toBe(status);
  const run = processes()[0];
  expect(run.cwd).toBe(p.copy!.dir);
  expect(run.args).not.toContain("--disallowedTools");
  expect(run.args.join(" ")).toContain("huddle_hand_in");
}, 20000);

test("read-only agents work in a detached snapshot of the host's HEAD, refreshed at every wake", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer", focus: "auth" }]);
  await idle();
  const hostDir = store.getTicket("p", t.id)!.worktree!;
  const p = participant(h, "reviewer");
  const head = (dir: string) => git(dir, "rev-parse", "HEAD").then((x) => x.trim());
  const sha = await head(hostDir);
  expect(p.worktree).toContain(`${t.id}.huddle`);
  expect(p.branch).toBeNull();
  const branch = store.getTicket("p", t.id)!.branch!;
  expect(p.snapshot).toEqual({ branch, sha });
  expect(processes()[0].cwd).toBe(p.worktree);
  expect(await head(p.worktree!)).toBe(sha);
  expect((await git(p.worktree!, "branch", "--show-current")).trim()).toBe("");
  const system = processes()[0].args.join(" ");
  expect(system).toContain(`host branch ${branch}, commit ${sha}`);
  expect(system).toContain(`git diff main...${sha}`);
  expect(system).toContain("focused on: auth");
  expect(system).toContain("you see committed code only; ask @main to commit WIP".replace("you", "You"));
  // What it writes stays in its snapshot.
  writeFileSync(join(p.worktree!, "scratch.txt"), "x");
  writeFileSync(join(p.worktree!, "README.md"), "changed");
  expect(existsSync(join(hostDir, "scratch.txt"))).toBe(false);
  expect(await git(hostDir, "status", "--porcelain")).toBe("");
  // The host commits; the reviewer's next wake sees it, and the local changes are gone.
  writeFileSync(join(hostDir, "login.ts"), "export {}\n");
  await git(hostDir, "add", ".");
  await git(hostDir, "commit", "-qm", "login");
  const next = await head(hostDir);
  huddles.post("p", h.id, you(h), "@reviewer please look again");
  await idle();
  expect(heardBy("reviewer").at(-1)).toContain("please look again");
  expect(await head(p.worktree!)).toBe(next);
  expect(existsSync(join(p.worktree!, "login.ts"))).toBe(true);
  expect(existsSync(join(p.worktree!, "scratch.txt"))).toBe(false);
  expect(await git(p.worktree!, "status", "--porcelain")).toBe("");
  expect(participant(h, "reviewer").snapshot!.sha).toBe(next);
  expect(processes().at(-1)!.args.join(" ")).toContain(`commit ${next}`);
  // Closing removes the snapshot.
  huddles.close("p", h.id);
  await idle();
  expect(existsSync(p.worktree!)).toBe(false);
  expect(participant(h, "reviewer").worktree).toBeNull();
  expect((await git(store.getProfile("p")!.path, "worktree", "list")).includes(p.worktree!)).toBe(false);
}, 30000);

test("a failing post-checkout hook in the project doesn't fail the snapshot or its reset", async () => {
  writeFileSync(join(store.getProfile("p")!.path, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  const hostDir = store.getTicket("p", t.id)!.worktree!;
  const p = participant(h, "reviewer");
  expect(p).toMatchObject({ status: "idle", error: null });
  writeFileSync(join(hostDir, "login.ts"), "export {}\n");
  await git(hostDir, "add", ".");
  await git(hostDir, "commit", "-qm", "login");
  const next = (await git(hostDir, "rev-parse", "HEAD")).trim();
  huddles.post("p", h.id, you(h), "@reviewer please look again");
  await idle();
  expect(participant(h, "reviewer")).toMatchObject({ status: "idle", error: null });
  expect((await git(p.worktree!, "rev-parse", "HEAD")).trim()).toBe(next);
  expect(heardBy("reviewer").at(-1)).toContain("please look again");
}, 30000);

test("in a repo with no commits yet, read-only agents read the host's folder and editing ones get a plain copy", async () => {
  const empty = tempDir("ck-empty-");
  await git(empty, "init", "-q", "-b", "main");
  writeFileSync(join(empty, "notes.md"), "hi\n");
  store.saveProfile({ ...store.getProfile("p")!, path: empty });
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }, { role: "Fixer", prompt: "Fix it", workspace: "own", canEdit: true }]);
  await idle();
  for (const a of ["reviewer", "fixer"]) {
    expect(participant(h, a)).toMatchObject({ status: "idle", error: null });
    expect(participant(h, a).worktree ?? null).toBeNull();
    expect(heardBy(a)[0]).toContain(`You just joined the huddle as @${a}`);
  }
  expect(participant(h, "reviewer").snapshot ?? null).toBeNull();
  const copy = participant(h, "fixer").copy!;
  expect(copy).toMatchObject({ kind: "folder", branch: null });
  // A plain copy: the files, without the version history folder.
  expect(readFileSync(join(copy.dir, "notes.md"), "utf8")).toBe("hi\n");
  expect(existsSync(join(copy.dir, ".git"))).toBe(false);
  expect(processes().map((x) => x.cwd).sort()).toEqual([empty, copy.dir].sort());
  // A later wake uses the same copy.
  huddles.post("p", h.id, you(h), "@reviewer @fixer again");
  await idle();
  expect(heardBy("fixer").at(-1)).toContain("again");
  expect(processes().filter((x) => x.cwd === copy.dir).length).toBe(2);
  expect(messages(h).some((m) => /branch|worktree|commit/i.test(m.text))).toBe(false);
}, 30000);

test("in a plain folder, read-only agents read the host's folder and editing ones work in a copy of it", async () => {
  const plain = tempDir("ck-plain-");
  writeFileSync(join(plain, "index.html"), "<h1>Hi</h1>\n");
  store.saveProfile({ ...store.getProfile("p")!, path: plain });
  const t = await host();
  const h = huddles.create("p", t.id, [
    { preset: "reviewer" },
    { role: "Fixer", prompt: "Fix it", workspace: "own", canEdit: true },
    { role: "Helper", prompt: "Help", workspace: "shared", canEdit: true },
  ]);
  await idle();
  for (const a of ["reviewer", "fixer", "helper"]) expect(participant(h, a)).toMatchObject({ status: "idle", error: null });
  expect(participant(h, "reviewer").copy ?? null).toBeNull();
  // canEdit always means its own copy, whatever the workspace said.
  for (const a of ["fixer", "helper"]) {
    expect(participant(h, a)).toMatchObject({ workspace: "own", canEdit: true, copy: { kind: "folder" } });
    expect(readFileSync(join(participant(h, a).copy!.dir, "index.html"), "utf8")).toBe("<h1>Hi</h1>\n");
  }
  expect(processes().map((x) => x.cwd).sort()).toEqual([plain, participant(h, "fixer").copy!.dir, participant(h, "helper").copy!.dir].sort());
}, 30000);

test("an agent that can't start shows why: failed with the error, and a line in the huddle", async () => {
  const t = await host();
  // The host's linked folder is gone, so no agent can get a workspace.
  store.updateTicket("p", t.id, { workdir: join(tempDir("ck-gone-"), "gone") });
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  const p = participant(h, "reviewer");
  expect(p.status).toBe("failed");
  expect(p.error).toContain("linked session folder no longer exists");
  expect(messages(h).at(-1)).toMatchObject({ kind: "system", text: `@reviewer failed: ${p.error}` });
  expect(processes()).toEqual([]);
}, 30000);

test("a live monitor-mode snapshot is reset to the host's latest commit before new messages go in", async () => {
  await Promise.all([board.shutdown(), huddles.shutdown()]);
  server.stop(true);
  await setup(60_000);
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "qa" }]);
  await until(() => heardBy("qa").length === 1 && participant(h, "qa").status === "idle");
  const hostDir = store.getTicket("p", t.id)!.worktree!;
  writeFileSync(join(hostDir, "form.ts"), "export {}\n");
  await git(hostDir, "add", ".");
  await git(hostDir, "commit", "-qm", "form");
  const next = (await git(hostDir, "rev-parse", "HEAD")).trim();
  huddles.post("p", h.id, you(h), "@qa the form is in");
  await until(() => heardBy("qa").length === 2);
  expect(processes().length).toBe(1);
  expect(heardBy("qa")[1]).toContain(`your snapshot now shows ${store.getTicket("p", t.id)!.branch} at ${next}`);
  expect(existsSync(join(participant(h, "qa").worktree!, "form.ts"))).toBe(true);
  huddles.stopAll("p", h.id);
}, 30000);
