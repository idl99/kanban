import { expect, test } from "bun:test";
import type { IntegrationCatalog } from "../web/src/automationTypes";
import { accountState, addValue, insertAt, loopStatus, loopSubtitle, newRule, removeValue, withField } from "../web/src/automations";

const trigger = {
  id: "issue_assigned", label: "Issue assigned", variables: [], defaultInstructions: "",
  fields: [
    { id: "assignee", label: "Assignee", operators: ["is", "is_not"], pick: true },
    { id: "label", label: "Label", operators: ["is"], pick: false },
  ],
};
const catalog: IntegrationCatalog = {
  callbackUrl: "http://localhost:7777/cb", actions: [],
  providers: [{ id: "linear", name: "Linear", steps: [], fields: [], oauth: true, triggers: [trigger] }],
};

test("a new rule starts on the trigger's first field and operator", () => {
  expect(newRule(trigger)).toEqual({ field: "assignee", op: "is", values: [] });
});

test("changing a rule's field keeps the operator only when the new field allows it", () => {
  expect(withField(trigger, { field: "assignee", op: "is_not", values: ["u1"] }, "label")).toEqual({ field: "label", op: "is", values: [] });
  expect(withField(trigger, { field: "label", op: "is", values: ["x"] }, "assignee")).toEqual({ field: "assignee", op: "is", values: [] });
  expect(withField(trigger, { field: "label", op: "is_not", values: ["x"] }, "assignee").op).toBe("is_not");
});

test("variables are inserted at the caret or over the selection", () => {
  expect(insertAt("Fix  now", 4, 4, "{{a}}")).toEqual({ text: "Fix {{a}} now", caret: 9 });
  expect(insertAt("Fix XX now", 4, 6, "{{a}}")).toEqual({ text: "Fix {{a}} now", caret: 9 });
  expect(insertAt("abc", 99, 99, "!")).toEqual({ text: "abc!", caret: 4 });
});

test("values are added once and removed by value", () => {
  expect(addValue(["a"], "b")).toEqual(["a", "b"]);
  expect(addValue(["a"], "a")).toEqual(["a"]);
  expect(addValue(["a"], "")).toEqual(["a"]);
  expect(removeValue(["a", "b"], "a")).toEqual(["b"]);
});

test("list labels say what the loop listens to and whether it runs", () => {
  expect(loopSubtitle(catalog, { provider: "linear", trigger: "issue_assigned" })).toBe("Linear · Issue assigned");
  expect(loopSubtitle(catalog, { provider: "gone", trigger: "x" })).toBe("gone · x");
  expect(loopStatus({ enabled: true, state: "ok" })).toEqual({ label: "On", tone: "ok" });
  expect(loopStatus({ enabled: false, state: "ok" }).label).toBe("Off");
  expect(loopStatus({ enabled: true, state: "unsupported" }).label).toBe("Not supported");
  expect(loopStatus({ enabled: true, state: "needs_reconnect" }).label).toBe("Needs connection");
  expect(accountState({ status: "connected" }).label).toBe("Connected");
  expect(accountState({ status: "needs_reconnect" }).tone).toBe("failed");
  expect(accountState({ status: "pending" }).label).toBe("Waiting for sign-in");
});
