import { expect, test } from "bun:test";
import { matches, ruleError, type Rule } from "../src/server/integrations/filters";
import { render, usedVariables } from "../src/server/integrations/template";
import type { IntegrationEvent, Identity, TriggerDef } from "../src/server/integrations/types";
import { dummyProvider } from "./fixtures/dummy-provider";

const trigger: TriggerDef = dummyProvider({ things: [], polls: 0, fail: null }).triggers[0];
const me: Identity = { userId: "u1", userName: "Dum", workspace: "W" };
const event = (color: string, size: string): IntegrationEvent => ({ key: "k", at: "", title: "", url: "", fields: { color: [color], size: [size] }, vars: {} });
const rule = (field: string, op: Rule["op"], ...values: string[]): Rule => ({ field, op, values });

test("IS and IS NOT, with several values", () => {
  expect(matches(trigger, "all", [rule("color", "is", "red")], event("red", "s"), me)).toBe(true);
  expect(matches(trigger, "all", [rule("color", "is", "blue")], event("red", "s"), me)).toBe(false);
  expect(matches(trigger, "all", [rule("color", "is", "blue", "red")], event("red", "s"), me)).toBe(true);
  expect(matches(trigger, "all", [rule("color", "is_not", "red")], event("red", "s"), me)).toBe(false);
  expect(matches(trigger, "all", [rule("color", "is_not", "blue", "green")], event("red", "s"), me)).toBe(true);
});

test("AND needs every rule, OR needs one", () => {
  const rules = [rule("color", "is", "red"), rule("size", "is", "l")];
  expect(matches(trigger, "all", rules, event("red", "l"), me)).toBe(true);
  expect(matches(trigger, "all", rules, event("red", "s"), me)).toBe(false);
  expect(matches(trigger, "any", rules, event("red", "s"), me)).toBe(true);
  expect(matches(trigger, "any", rules, event("blue", "s"), me)).toBe(false);
});

test("no rules match everything; a rule on an unknown field never holds", () => {
  expect(matches(trigger, "all", [], event("red", "s"), me)).toBe(true);
  expect(matches(trigger, "any", [], event("red", "s"), me)).toBe(true);
  expect(matches(trigger, "all", [rule("nope", "is", "x")], event("red", "s"), me)).toBe(false);
  expect(matches(trigger, "all", [rule("nope", "is_not", "x")], event("red", "s"), me)).toBe(false);
});

test("a field's resolve turns a picked value into what events carry", () => {
  expect(matches(trigger, "all", [rule("color", "is", "@favorite")], event("red", "s"), me)).toBe(true);
  expect(matches(trigger, "all", [rule("color", "is", "@favorite")], event("blue", "s"), me)).toBe(false);
});

test("ruleError names the problem in plain words", () => {
  expect(ruleError(trigger, [rule("color", "is", "red")])).toBeNull();
  expect(ruleError(trigger, [rule("nope", "is", "x")])).toContain("not a filter");
  expect(ruleError(trigger, [rule("size", "is_not", "x")])).toContain("Size can't use");
  expect(ruleError(trigger, [rule("color", "is")])).toBe("Pick a value for Color");
});

test("variables are filled in; unknown ones stay visible", () => {
  expect(usedVariables("{{ a.b }} and {{c}} and {{a.b}}")).toEqual(["a.b", "c"]);
  expect(render("Fix {{issue.title}} ({{issue.url}}) {{typo}}", { "issue.title": "Bug", "issue.url": "u" })).toBe("Fix Bug (u) {{typo}}");
  expect(render("[{{x}}]", { x: "" })).toBe("[]");
});
