import { expect, test } from "bun:test";
import { checkInsText, complete, planFinished } from "../web/src/planText";

const kid = (status: string, outcome: string | null = null, prUrl: string | null = null) => ({ status, outcome, prUrl });

test("planFinished needs at least one child and every child done", () => {
  expect(planFinished([])).toBe(false);
  expect(planFinished([kid("done"), kid("done")])).toBe(true);
  expect(planFinished([kid("done"), kid("review", "done")])).toBe(true);
  expect(planFinished([kid("done"), kid("review", "done", "https://github.com/o/r/pull/1")])).toBe(false);
  // A child added later brings the normal plan UI back.
  expect(planFinished([kid("done"), kid("done"), kid("backlog")])).toBe(false);
  expect(complete(kid("in_progress"))).toBe(false);
});

test("checkInsText says the wake-up count in plain words", () => {
  expect(checkInsText(0)).toBe("Claude checked in 0 times");
  expect(checkInsText(1)).toBe("Claude checked in once");
  expect(checkInsText(4)).toBe("Claude checked in 4 times");
});
