import { expect, test } from "bun:test";
import { extractFinalText, summarizeEvent } from "../src/server/activity";
import { chatPrompt, firstRunPrompt, freshSessionPrompt, orchestratorPrompt, planningCommand, planningPrompt, resumeCommand, resumePrompt } from "../src/server/prompts";
import { parseResult } from "../src/server/result";
import type { Ticket } from "../src/server/types";

const ticket = { id: "t_1", title: "Add dark mode", body: "Use CSS vars." } as Ticket;

test("parseResult last line wins", () => {
  const text = `work\nCKANBAN_RESULT: {"status":"blocked","prUrl":null,"summary":"a"}\nmore\nCKANBAN_RESULT: {"status":"done","prUrl":"https://github.com/x/y/pull/1","summary":"ok"}`;
  expect(parseResult(text)).toEqual({ status: "done", prUrl: "https://github.com/x/y/pull/1", summary: "ok" });
});

test("parseResult tolerates markdown backticks", () => {
  expect(parseResult('`CKANBAN_RESULT: {"status":"done","summary":"s"}`')).toEqual({ status: "done", prUrl: null, summary: "s" });
});

test("parseResult missing or invalid", () => {
  expect(parseResult("no line here")).toBeNull();
  expect(parseResult("CKANBAN_RESULT: {nope")).toBeNull();
  expect(parseResult('CKANBAN_RESULT: {"status":"weird","summary":"x"}')).toBeNull();
});

test("summarizeEvent tool uses and text", () => {
  const tool = (name: string, input: any) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
  expect(summarizeEvent(tool("Edit", { file_path: "/repo/src/app.ts" }))).toBe("Editing app.ts");
  expect(summarizeEvent(tool("Bash", { command: "npm test" }))).toBe("Running tests");
  expect(summarizeEvent({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(200) }] } })).toBe("x".repeat(80));
  expect(summarizeEvent({ type: "result", result: "done" })).toBe("Finished");
  expect(summarizeEvent({ type: "system" })).toBeNull();
});

test("summarizeEvent describes tool calls in plain English", () => {
  const tool = (name: string, input: any) => summarizeEvent({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
  expect(tool("Read", { file_path: "/repo/src/mcp-server.ts" })).toBe("Reading mcp-server.ts");
  expect(tool("MultiEdit", { file_path: "/repo/web/src/Card.tsx" })).toBe("Editing Card.tsx");
  expect(tool("Write", { file_path: "/repo/web/src/Card.tsx" })).toBe("Writing Card.tsx");
  expect(tool("Grep", { pattern: "lastActivity" })).toBe('Searching for "lastActivity"');
  expect(tool("Glob", { pattern: "**/*.tsx" })).toBe("Finding **/*.tsx");
  expect(tool("WebFetch", { url: "https://docs.github.com/en/rest" })).toBe("Reading docs.github.com");
  expect(tool("WebSearch", { query: "bun test" })).toBe("Searching the web");
  expect(tool("Task", { description: "Find card CSS" })).toBe("Delegating: Find card CSS");
  expect(tool("Agent", { description: "Review diff" })).toBe("Delegating: Review diff");
  expect(tool("mcp__ckanban__list_tickets", {})).toBe("ckanban: list tickets");
  expect(tool("SomethingNew", { path: "/a/b/c.ts" })).toBe("SomethingNew: b/c.ts");
  expect(tool("SomethingNew", {})).toBe("SomethingNew");
  const ev = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "sed -n 1,60p src/x.ts" } }] } };
  expect(summarizeEvent(ev, { raw: true })).toBe("Bash: sed -n 1,60p src/x.ts");
});

test("summarizeEvent reads Bash commands", () => {
  const bash = (command: string) => summarizeEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
  expect(bash("sed -n 1,60p src/mcp-server.ts")).toBe("Reading mcp-server.ts");
  expect(bash("cd /repo && cat package.json")).toBe("Reading package.json");
  expect(bash("head -n 20 web/src/styles.css | grep card")).toBe("Reading styles.css");
  expect(bash("sed -i '' 's/a/b/' src/x.ts")).toBe("Editing x.ts");
  expect(bash("cd /repo && bun test test")).toBe("Running tests");
  expect(bash("FOO=1 bun run test")).toBe("Running tests");
  expect(bash("git -C /repo status --short")).toBe("Git: status");
  expect(bash("git commit -m 'x'")).toBe("Git: commit");
  expect(bash("rg -n 'summarizeEvent' src")).toBe('Searching for "summarizeEvent"');
  expect(bash("bunx tsc --noEmit")).toBe("Running tsc");
  expect(bash("cat <<'EOF' > out.txt")).toBe("Running cat");
});

test("extractFinalText prefers result event", () => {
  const events = [
    { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } },
    { type: "result", result: "final" },
  ];
  expect(extractFinalText(events)).toBe("final");
  expect(extractFinalText(events.slice(0, 1))).toBe("partial");
  expect(extractFinalText([])).toBe("");
});

test("prompts include ticket and comments", () => {
  const p = firstRunPrompt(ticket, { repo: "remote" as const, outputDir: "/out" });
  expect(p).toContain("Add dark mode");
  expect(p).toContain("Use CSS vars.");
  expect(p).toContain("CKANBAN_RESULT:");
  const r = resumePrompt(ticket, [{ id: "1", author: "user", text: "use blue", at: "" }], "/out");
  expect(r).toContain("use blue");
  expect(r).toContain("CKANBAN_RESULT:");
  expect(planningPrompt(ticket, "/x/ticket.md")).toContain("/x/ticket.md");
});

test("commands are shell quoted", () => {
  expect(resumeCommand("/tmp/a b", "u1")).toBe("cd '/tmp/a b' && claude --resume u1");
  expect(planningCommand("/tmp/a", "u1", "it's", false)).toBe(`cd '/tmp/a' && claude --session-id u1 'it'\\''s'`);
  expect(planningCommand("/tmp/a", "u1", "p", true)).toBe(`cd '/tmp/a' && claude --resume u1 'p'`);
});

test("parseResult drops non-https prUrl", () => {
  expect(parseResult('CKANBAN_RESULT: {"status":"done","prUrl":"javascript:alert(1)","summary":"s"}')!.prUrl).toBeNull();
  expect(parseResult('CKANBAN_RESULT: {"status":"done","prUrl":"http://x/pull/1","summary":"s"}')!.prUrl).toBeNull();
});

test("interview mode asks questions first and never forbids questions", () => {
  const t = { ...ticket, mode: "interview" } as Ticket;
  const p = firstRunPrompt(t, { repo: "remote" as const, outputDir: "/out/t1" });
  expect(p).toContain("interview first");
  expect(p).toContain('status "questions"');
  expect(p).not.toContain("do not ask questions");
  expect(p).toContain("/out/t1");
  const notYet = resumePrompt(t, [], "/out/t1");
  expect(notYet).toContain("interview first");
  const r = resumePrompt({ ...t, interviewed: true } as Ticket, [{ id: "1", author: "user", text: "1a, 2b", at: "" }], "/out/t1");
  expect(r).toContain("Brief");
  expect(r).toContain("1a, 2b");
});

test("auto mode keeps autonomous wording and still asks for a deliverable", () => {
  const p = firstRunPrompt({ ...ticket, mode: "auto" } as Ticket, { repo: "plain" as const, outputDir: "/out" });
  expect(p).toContain("do not ask questions");
  expect(p).toContain("Outputs folder for this ticket: /out");
  expect(resumePrompt({ ...ticket, mode: "auto" } as Ticket, [], "/out")).not.toContain("Brief");
});

test("parseResult accepts questions status", () => {
  expect(parseResult('CKANBAN_RESULT: {"status":"questions","prUrl":null,"summary":"4 questions"}')!.status).toBe("questions");
});

test("run prompts point Claude at the artifact helper only when the board turns it on", () => {
  const t = { ...ticket, mode: "auto", runCount: 1 } as Ticket;
  const fresh = { repo: "remote" as const, linked: false, baseBranch: "main", lastResult: null, comments: [], outputDir: "/o" };
  for (const p of [firstRunPrompt(t, { repo: "remote" as const, outputDir: "/o", artifacts: true }), resumePrompt(t, [], "/o", false, true), chatPrompt(t, "hi", "act", "/o", true), freshSessionPrompt(t, { ...fresh, artifacts: true })]) {
    expect(p).toContain("Artifact tool is not available");
    expect(p).toContain("artifact publish <file.html> --url <url>");
  }
  for (const p of [firstRunPrompt(t, { repo: "remote" as const, outputDir: "/o" }), resumePrompt(t, [], "/o"), chatPrompt(t, "hi", "act", "/o"), freshSessionPrompt(t, fresh)]) {
    expect(p).not.toContain("claude.ai artifacts");
    expect(p).not.toContain("artifact publish");
  }
  expect(chatPrompt(t, "hi", "refine", "/o", true)).not.toContain("artifact publish");
});

test("planning chats reach artifacts through the MCP tools, not the Bash helper (when on)", () => {
  const p = chatPrompt({ ...ticket, mode: "auto" } as Ticket, "", "refine", "/o", true);
  expect(p).toContain("`read_artifact`");
  expect(p).toContain("`publish_artifact` with the full edited page and the same url");
  expect(p).toContain("Publishing artifacts is allowed while planning");
  expect(chatPrompt({ ...ticket, mode: "auto" } as Ticket, "", "refine", "/o")).not.toContain("read_artifact");
});

test("a scheduled ticket's first run is told its schedule", () => {
  const t = { ...ticket, scheduleId: "s1" } as Ticket;
  const p = firstRunPrompt(t, { repo: "remote" as const, outputDir: "/out", schedule: { id: "s1", name: "Nightly audit", board: "kanban" } });
  expect(p).toContain('created by schedule s1 ("Nightly audit") on board kanban');
  expect(p).toContain("update_schedule");
  expect(firstRunPrompt(t, { repo: "remote" as const, outputDir: "/out", schedule: { id: "s1", name: null, board: "kanban" } })).toContain("since been deleted");
  expect(firstRunPrompt(ticket, { repo: "remote" as const, outputDir: "/out" })).not.toContain("schedule");
});

test("planning and Review/Done chats can propose new tickets, first runs can't", () => {
  const t = { ...ticket, runCount: 1 } as Ticket;
  const refine = chatPrompt(t, "split it", "refine", "/o");
  expect(refine).toContain("<ckanban-tickets>");
  expect(refine).toContain("list_tickets");
  // Tools first; the text blocks are only the fallback.
  for (const tool of ["ask_questions", "propose_ticket", "propose_tickets"]) expect(refine).toContain(`\`${tool}\` tool`);
  expect(refine.indexOf("`propose_tickets` tool")).toBeLessThan(refine.indexOf("<ckanban-tickets>"));
  expect(refine).toContain("Only if the ckanban tools aren't available");
  expect(refine).not.toContain("ckanban-stay");
  const act = chatPrompt(t, "create a follow-up ticket", "act", "/o");
  expect(act).toContain("`propose_tickets` tool");
  expect(act).toContain("list_tickets");
  expect(act).toContain("follow-up tickets from this ticket");
  expect(act).toContain("<ckanban-stay/>");
  expect(firstRunPrompt(t, { repo: "remote" as const, outputDir: "/o" })).not.toContain("ckanban-tickets");
});

test("every ticket chat can offer a branch; first runs can't", () => {
  const t = { ...ticket, runCount: 1 } as Ticket;
  expect(chatPrompt(t, "branch this", "refine", "/o")).toContain("`propose_branch` tool");
  const act = chatPrompt(t, "branch this", "act", "/o");
  expect(act).toContain("`propose_branch` tool");
  expect(act).toContain("proposing tickets, a branch or a teammate was all");
  expect(firstRunPrompt(t, { repo: "remote" as const, outputDir: "/o" })).not.toContain("propose_branch");
});

test("every ticket chat may propose a teammate; it can't save one", () => {
  const t = { ...ticket, runCount: 1 } as Ticket;
  for (const mode of ["refine", "act"] as const) {
    const p = chatPrompt(t, "I want a teammate that watches our inbox", mode, "/o");
    expect(p).toContain("`propose_teammate` tool");
    expect(p).toContain("save_huddle_preset saves nothing here");
  }
});

test("planner wake-ups: events or final check, scoped rights, one visible line first", () => {
  const t = { ...ticket, id: "t_plan", title: "Big plan" } as Ticket;
  const ev = orchestratorPrompt(t, { kind: "event", events: ['t_1 "A" failed (review)'], table: "- t_1 \"A\": review; failed", board: "kanban", outputDir: "/o" });
  expect(ev.split("\n")[0]).toBe("Plan update: 1 child ticket needs a decision.");
  expect(ev).toContain('- t_1 "A" failed (review)');
  expect(ev).toContain("THIS plan's child tickets only");
  expect(ev).toContain("gh pr merge");
  expect(ev).toContain("CKANBAN_RESULT");
  const fin = orchestratorPrompt(t, { kind: "final", events: [], table: "", board: "kanban", outputDir: "/o" });
  expect(fin.split("\n")[0]).toStartWith("Plan finished");
  expect(fin).toContain("/o/plan-summary.md");
  expect(chatPrompt(t, "split it", "refine", "/o")).toContain('"dependsOn":["api"]');
});

test("a plan's child is told to rebase onto the remote base branch first", () => {
  const t = { ...ticket, mode: "auto", parentId: "t_plan" } as Ticket;
  expect(firstRunPrompt(t, { repo: "remote" as const, outputDir: "/o" })).toContain("part of a plan (planner ticket t_plan)");
  expect(firstRunPrompt({ ...t, parentId: null } as Ticket, { repo: "remote" as const, outputDir: "/o" })).not.toContain("part of a plan");
});

test("API connection retries show on the card instead of looking frozen", () => {
  expect(summarizeEvent({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10 })).toBeNull();
  expect(summarizeEvent({ type: "system", subtype: "api_retry", attempt: 4, max_retries: 10 })).toBe("Can't reach Claude's API, retrying (4/10)…");
});

test("ticket chats can manage tickets when the user asks; planners hear about needs", () => {
  const act = chatPrompt(ticket, "manage A and B", "act", "/o");
  for (const s of ["adopt_tickets", "plan_control", "needs (e.g. [\"emulator\"])", "If the user only asked to create or adopt tickets, don't start the plan"]) expect(act).toContain(s);
  const refine = chatPrompt(ticket, "manage A and B", "refine", "/o");
  expect(refine).not.toContain("read-only and can't change the board");
  for (const s of ["ONLY when the user asks for it in their message", "move_ticket", "propose_delete", "Never change this ticket itself", "Say in your reply what you changed"]) {
    expect(refine).toContain(s);
  }
  expect(refine).toContain('"needs":["emulator"]');
  const wake = orchestratorPrompt(ticket, { kind: "event", events: [], table: "", board: "kanban", outputDir: "/o" });
  expect(wake).toContain("one ticket per exclusive resource (needs) at a time");
  expect(wake).toContain("instead of a dependsOn chain");
});

test("run prompts adapt to the folder's version history and never block on missing git", () => {
  const t = { ...ticket, mode: "auto", parentId: "t_plan", branch: "ck/t1-x" } as Ticket;
  const plain = firstRunPrompt(t, { repo: "plain", outputDir: "/o" });
  const empty = firstRunPrompt(t, { repo: "empty", outputDir: "/o" });
  const local = firstRunPrompt(t, { repo: "local", outputDir: "/o" });
  const remote = firstRunPrompt(t, { repo: "remote", outputDir: "/o" });
  for (const p of [plain, empty, local, remote]) {
    expect(p).not.toContain('report status "blocked" explaining what is missing');
    expect(p).toContain("never a reason to stop or report \"blocked\"");
    expect(p).toContain("The user may not be technical");
  }
  // Plain folder: edit in place, list the files, nothing to commit or push.
  expect(plain).toContain("no version history");
  expect(plain).toContain("list every file you created, changed or deleted");
  expect(plain).not.toContain("gh pr create");
  expect(plain).not.toContain("git fetch");
  // No commits: no worktree, no branch, no rebase.
  for (const word of ["worktree", "branch", "git fetch", "rebase", "gh pr create"]) expect(empty).not.toContain(word);
  expect(empty).toContain("no first snapshot yet");
  // No remote: commit locally, no fetch from origin, no push or PR.
  expect(local).toContain("commit them on this branch");
  expect(local).not.toContain("git fetch");
  expect(local).not.toContain("gh pr create");
  expect(local).toContain("rebase this branch onto the local base branch");
  // No pull requests: the branch is merged into the project folder so the user sees the change.
  expect(firstRunPrompt(t, { repo: "local", outputDir: "/o", home: { folder: "/p/shop", baseBranch: "main" } })).toContain("bring the work into the project folder (`/p/shop`) so the user sees it there: if that folder is on `main`");
  expect(remote).not.toContain("bring the work into");
  // Remote: the PR flow, with a way out when gh is missing.
  expect(remote).toContain("gh pr create");
  expect(remote).toContain("`git fetch` and rebase");
  expect(remote).toContain("worktree on this ticket's own branch (`ck/t1-x`)");
  expect(remote).toContain("If `gh` isn't available");
});

test("resume, fresh, chat and planner prompts drop git steps the folder can't do", () => {
  const t = { ...ticket, mode: "auto", runCount: 1 } as Ticket;
  expect(resumePrompt(t, [], "/o", false, false, "plain")).not.toContain("push new commits");
  expect(resumePrompt(t, [], "/o", false, false, "plain")).toContain("edit them in place");
  expect(resumePrompt(t, [], "/o")).toContain("push new commits to the same branch");
  const fresh = { linked: false, baseBranch: "main", lastResult: null, comments: [], outputDir: "/o" };
  const fp = freshSessionPrompt(t, { ...fresh, repo: "empty" });
  expect(fp).not.toContain("git log");
  expect(fp).not.toContain("gh pr create");
  expect(fp).not.toContain("this worktree");
  expect(freshSessionPrompt(t, { ...fresh, repo: "remote" })).toContain("git log --oneline main..HEAD");
  expect(chatPrompt(t, "hi", "act", "/o", false, "plain")).toContain("no version history yet");
  expect(chatPrompt(t, "hi", "act", "/o", false, "local")).toContain("no remote");
  const base = { kind: "final" as const, events: [], table: "", board: "kanban", outputDir: "/o" };
  expect(orchestratorPrompt(t, base)).toContain("origin/<base branch>");
  for (const repo of ["plain", "empty", "local"] as const) {
    const fin = orchestratorPrompt(t, { ...base, repo });
    expect(fin).not.toContain("git fetch");
    expect(fin).not.toContain("origin/");
  }
  expect(orchestratorPrompt(t, { ...base, repo: "plain" })).not.toContain("git worktree add");
  expect(orchestratorPrompt(t, { ...base, kind: "event", repo: "local" })).not.toContain("gh pr merge");
});

test("the auto huddle and huddle prompts don't ask to commit in a folder without commits", () => {
  const t = { ...ticket, mode: "auto" } as Ticket;
  const plain = firstRunPrompt(t, { repo: "plain", outputDir: "/o", autoHuddles: true });
  expect(plain).toContain("BEFORE you finish");
  expect(plain).not.toContain("done and committed");
  expect(firstRunPrompt(t, { repo: "remote", outputDir: "/o", autoHuddles: true })).toContain("done and committed");
});

test("work in the project folder on a git repo: commit to the current branch, no branch, push or PR steps", () => {
  const t = { ...ticket, parentId: "t_plan" } as Ticket;
  for (const repo of ["remote", "local"] as const) {
    const p = firstRunPrompt(t, { repo, inPlace: true, outputDir: "/out", home: { folder: "/proj", baseBranch: "main" } });
    expect(p).toContain("Don't create or switch branches");
    expect(p).toContain("to the current branch");
    expect(p).toContain("mention them in your summary");
    expect(p).not.toContain("gh pr create");
    expect(p).not.toContain("push the branch");
    expect(p).not.toContain("rebase");
    expect(p).not.toContain("merge --no-edit");
    const r = resumePrompt(t, [], "/out", false, false, repo, true);
    expect(r).toContain("to the current branch");
    expect(r).not.toContain("gh pr create");
    expect(r).not.toContain("push new commits");
    const c = chatPrompt(t, "hi", "act", "/out", false, repo, true);
    expect(c).toContain("don't create or switch branches");
    expect(c).not.toContain("push new commits");
  }
});
