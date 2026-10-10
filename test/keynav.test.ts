import { expect, test } from "bun:test";
import { boardDigit, canStartFromProposal, cardDir, hintStep, isTyping, nextStep, panelStep, stepBoard, stepCard } from "../web/src/keynav";

test("cardDir maps J/K/H/L and arrows, ignores other keys", () => {
  expect(cardDir("j")).toBe("down");
  expect(cardDir("ArrowDown")).toBe("down");
  expect(cardDir("K")).toBe("up");
  expect(cardDir("ArrowUp")).toBe("up");
  expect(cardDir("h")).toBe("left");
  expect(cardDir("ArrowRight")).toBe("right");
  expect(cardDir("l")).toBe("right");
  expect(cardDir("n")).toBeNull();
  expect(cardDir("Enter")).toBeNull();
});

test("stepCard with nothing selected picks the first card of the first non-empty column", () => {
  expect(stepCard([0, 0, 3, 1], null, "down")).toEqual({ col: 2, row: 0 });
  expect(stepCard([0, 0, 3, 1], null, "left")).toEqual({ col: 2, row: 0 });
  expect(stepCard([0, 0], null, "down")).toBeNull();
});

test("stepCard moves up and down within a column, clamped", () => {
  expect(stepCard([3], { col: 0, row: 0 }, "down")).toEqual({ col: 0, row: 1 });
  expect(stepCard([3], { col: 0, row: 2 }, "down")).toEqual({ col: 0, row: 2 });
  expect(stepCard([3], { col: 0, row: 0 }, "up")).toEqual({ col: 0, row: 0 });
});

test("stepCard sideways skips empty columns, keeps the row and clamps to shorter columns", () => {
  expect(stepCard([4, 0, 2], { col: 0, row: 1 }, "right")).toEqual({ col: 2, row: 1 });
  expect(stepCard([4, 0, 2], { col: 0, row: 3 }, "right")).toEqual({ col: 2, row: 1 });
  expect(stepCard([4, 0, 2], { col: 2, row: 1 }, "left")).toEqual({ col: 0, row: 1 });
  // At the edge: stay put.
  expect(stepCard([4, 0, 2], { col: 2, row: 0 }, "right")).toEqual({ col: 2, row: 0 });
  expect(stepCard([4, 0, 0], { col: 0, row: 2 }, "right")).toEqual({ col: 0, row: 2 });
});

test("stepCard recovers when the selected column emptied", () => {
  expect(stepCard([0, 2], { col: 0, row: 0 }, "down")).toEqual({ col: 1, row: 0 });
});

test("stepBoard wraps around both ways", () => {
  expect(stepBoard(3, 0, 1)).toBe(1);
  expect(stepBoard(3, 2, 1)).toBe(0);
  expect(stepBoard(3, 0, -1)).toBe(2);
  expect(stepBoard(1, 0, 1)).toBe(0);
  expect(stepBoard(3, -1, 1)).toBe(0);
  expect(stepBoard(0, 0, 1)).toBe(-1);
});

test("boardDigit reads the physical key, 1-9 only", () => {
  expect(boardDigit("Digit1")).toBe(0);
  expect(boardDigit("Digit9")).toBe(8);
  expect(boardDigit("Numpad2")).toBe(1);
  expect(boardDigit("Digit0")).toBeNull();
  expect(boardDigit("KeyA")).toBeNull();
});

test("panelStep: plain arrows and J/K step tickets, modifiers and other keys don't", () => {
  const k = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
    panelStep({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  expect(k("ArrowUp")).toBe("prev");
  expect(k("k")).toBe("prev");
  expect(k("ArrowDown")).toBe("next");
  expect(k("J")).toBe("next");
  expect(k("ArrowLeft")).toBeNull();
  expect(k("e")).toBeNull();
  expect(k("ArrowUp", { altKey: true })).toBeNull();
  expect(k("ArrowDown", { shiftKey: true })).toBeNull();
  expect(k("j", { metaKey: true })).toBeNull();
});

test("nextStep applies a pending proposal first (starting work from Backlog/Planning), then the column's action", () => {
  expect(nextStep({ status: "planning", working: false, proposalPending: true })).toBe("apply-start");
  expect(nextStep({ status: "backlog", working: false, proposalPending: true })).toBe("apply-start");
  expect(nextStep({ status: "ready", working: false, proposalPending: true })).toBe("apply");
  expect(nextStep({ status: "planning", working: false, proposalPending: false })).toBe("start");
  expect(nextStep({ status: "backlog", working: false, proposalPending: false })).toBe("start");
  expect(nextStep({ status: "review", working: false, proposalPending: false })).toBe("done");
  expect(nextStep({ status: "review", working: false, proposalPending: true })).toBe("apply");
  expect(nextStep({ status: "ready", working: false, proposalPending: false })).toBeNull();
  expect(nextStep({ status: "done", working: false, proposalPending: false })).toBeNull();
  expect(nextStep({ status: "planning", working: true, proposalPending: true })).toBeNull();
});

test("nextStep moves a planner whose plan is finished to Done instead of starting work", () => {
  expect(nextStep({ status: "planning", working: false, proposalPending: false, planFinished: true })).toBe("done");
  expect(nextStep({ status: "backlog", working: false, proposalPending: false, planFinished: true })).toBe("done");
  expect(nextStep({ status: "review", working: false, proposalPending: false, planFinished: true })).toBe("done");
  expect(nextStep({ status: "done", working: false, proposalPending: false, planFinished: true })).toBeNull();
  expect(nextStep({ status: "planning", working: false, proposalPending: true, planFinished: true })).toBe("apply-start");
  expect(nextStep({ status: "planning", working: true, proposalPending: false, planFinished: true })).toBeNull();
});

test("hintStep: holding ⌘ arms, any other key or releasing hides", () => {
  expect(hintStep({ type: "keydown", key: "Meta" }, true)).toBe("arm");
  expect(hintStep({ type: "keydown", key: "Meta", repeat: true }, true)).toBe("none");
  expect(hintStep({ type: "keydown", key: "c" }, true)).toBe("hide");
  expect(hintStep({ type: "keydown", key: "Shift" }, true)).toBe("hide");
  expect(hintStep({ type: "keyup", key: "Meta" }, true)).toBe("hide");
  expect(hintStep({ type: "keyup", key: "c" }, true)).toBe("none");
  // Ctrl is the hint key off Mac only.
  expect(hintStep({ type: "keydown", key: "Control" }, true)).toBe("hide");
  expect(hintStep({ type: "keydown", key: "Control" }, false)).toBe("arm");
  expect(hintStep({ type: "keydown", key: "Meta" }, false)).toBe("hide");
});

test("isTyping is true in text fields only", () => {
  expect(isTyping({ target: { tagName: "INPUT" } as any })).toBe(true);
  expect(isTyping({ target: { tagName: "TEXTAREA" } as any })).toBe(true);
  expect(isTyping({ target: { tagName: "DIV", isContentEditable: true } as any })).toBe(true);
  expect(isTyping({ target: { tagName: "BUTTON", isContentEditable: false } as any })).toBe(false);
  expect(isTyping({ target: null })).toBe(false);
});

test("canStartFromProposal only from Backlog or Planning while Claude is idle", () => {
  expect(canStartFromProposal({ status: "planning", working: false })).toBe(true);
  expect(canStartFromProposal({ status: "backlog", working: false })).toBe(true);
  expect(canStartFromProposal({ status: "planning", working: true })).toBe(false);
  for (const status of ["ready", "in_progress", "review", "done"]) expect(canStartFromProposal({ status, working: false })).toBe(false);
});
