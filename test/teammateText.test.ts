import { expect, test } from "bun:test";
import { proposedTeammate, savedText, teammateDiff, teammateMeta, type TeammateDraft } from "../web/src/teammateText";

const qa: TeammateDraft = { name: "qa", role: "QA tester", prompt: "Test the work.", model: null, mode: "monitor", lead: false, canEdit: false, workspace: "shared" };

test("a new teammate gets the daemon's defaults for what Claude left out", () => {
  const t = proposedTeammate({ name: "wa-watcher", prompt: "Draft replies.", why: "w" });
  expect(t).toEqual({ name: "wa-watcher", role: "Wa watcher", prompt: "Draft replies.", model: null, mode: "tagged", lead: false, canEdit: false, workspace: "shared" });
  expect(teammateMeta({ ...t, model: "sonnet" })).toBe("Wakes when @mentioned · reads only · sonnet");
  expect(proposedTeammate({ name: "eng", prompt: "p", workspace: "own", why: "w" }).canEdit).toBe(true);
  expect(teammateMeta(proposedTeammate({ name: "eng", prompt: "p", workspace: "own", lead: true, why: "w" }))).toBe("Wakes when @mentioned · changes files (own copy, hands them in) · lead · board's model");
});

test("a change keeps the existing teammate's values and lists what differs", () => {
  const next = proposedTeammate({ name: "qa", prompt: "Test the work. Test in light and dark mode for every UI change.", mode: "tagged", why: "w" }, qa);
  expect(next).toMatchObject({ role: "QA tester", mode: "tagged", model: null, workspace: "shared" });
  expect(teammateDiff(next, qa)).toEqual([
    { kind: "-", text: "mode: Gets every message" },
    { kind: "+", text: "mode: Wakes when @mentioned" },
    { kind: "+", text: "prompt: …Test in light and dark mode for every UI change." },
  ]);
  const rewritten = proposedTeammate({ name: "qa", prompt: "Only the API.", model: "haiku", why: "w" }, qa);
  expect(teammateDiff(rewritten, qa)).toEqual([
    { kind: "-", text: "model: board's model" },
    { kind: "+", text: "model: haiku" },
    { kind: "-", text: "prompt: Test the work." },
    { kind: "+", text: "prompt: Only the API." },
  ]);
  expect(teammateDiff(proposedTeammate({ name: "qa", prompt: "Test the work.", why: "w" }, qa), qa)).toEqual([]);
});

test("savedText", () => {
  expect(savedText("wa-watcher", "global")).toBe("@wa-watcher · all boards");
  expect(savedText("qa", "board")).toBe("@qa · this board");
});
