import { expect, test } from "bun:test";
import { automationProposal } from "../src/server/automation-proposal";
import { parseDecision } from "../src/server/integrations/ask-claude";
import { parseItems } from "../src/server/integrations/script";
import { ticketBody, ticketTitle } from "../src/server/integrations/ticket-text";
import type { Pass } from "../web/src/automationTypes";
import { boardCell, everyLabel, loopStatus, loopSubtitle, resolveProposedPass, showBoardColumn } from "../web/src/automations";

const pass = (p: Partial<Pass>): Pass => ({
  id: "p1", kind: "mcp", name: "linear", claudeName: null, url: null, envName: null, status: "connected", error: null, createdAt: "", usedBy: 0, ...p,
});

test("the Board column: ✓ for a linked pass, Connect for your own servers, a dash for claude.ai and project servers", () => {
  const server = (name: string, scope: any, transport: any = "http") => ({ name, scope, transport });
  expect(boardCell(server("linear", "user"), [pass({ claudeName: "linear" })])).toMatchObject({ kind: "ok" });
  expect(boardCell(server("linear", "user"), [])).toEqual({ kind: "connect", pass: null, how: "mcp" });
  expect(boardCell(server("cloudwatch", "local", "stdio"), [])).toEqual({ kind: "connect", pass: null, how: "local" });
  expect(boardCell(server("linear", "user"), [pass({ claudeName: "linear", status: "needs_reconnect" })])).toMatchObject({ kind: "connect", how: "mcp" });
  expect(boardCell(server("claude.ai Gmail", "claude.ai"), [])).toMatchObject({ kind: "none" });
  expect(boardCell(server("planted", "project", "stdio"), [])).toMatchObject({ kind: "none" });
  // No name matching: a pass named like a server isn't its board pass unless it was made from that row.
  expect(boardCell(server("linear", "user"), [pass({ name: "linear", claudeName: null })])).toMatchObject({ kind: "connect", pass: null });
});

test("the Board column shows once there is an automation or a board pass", () => {
  expect(showBoardColumn([], 0)).toBe(false);
  expect(showBoardColumn(null, 0)).toBe(false);
  expect(showBoardColumn([pass({})], 0)).toBe(true);
  expect(showBoardColumn([], 1)).toBe(true);
});

test("a proposed connection is matched to a pass, or says what the card must still do", () => {
  const passes = [pass({ id: "a", claudeName: "linear" }), pass({ id: "b", kind: "key", name: "Jira", envName: "JIRA_KEY", status: "connected" })];
  expect(resolveProposedPass({ name: "Linear", from: "linear" }, passes)).toMatchObject({ pass: { id: "a" }, need: null });
  expect(resolveProposedPass({ name: "Jira", envName: "JIRA_KEY" }, passes)).toMatchObject({ pass: { id: "b" }, need: null });
  expect(resolveProposedPass({ name: "Sentry", from: "sentry" }, passes)).toEqual({ pass: null, need: "connect" });
  expect(resolveProposedPass({ name: "Tracker", url: "https://mcp.tracker/mcp" }, passes)).toEqual({ pass: null, need: "connect" });
  expect(resolveProposedPass({ name: "Shop", envName: "SHOP_KEY" }, passes)).toEqual({ pass: null, need: "key" });
  expect(resolveProposedPass({ name: "Mystery" }, passes)).toEqual({ pass: null, need: "missing" });
});

test("list labels say whether it runs, and why not", () => {
  const base = { enabled: true, state: "ok" as const, lastError: null, lastCheckedAt: null, everyMinutes: 15, problems: [] };
  expect(loopStatus(base)).toEqual({ label: "On", tone: "ok" });
  expect(loopStatus({ ...base, enabled: false })).toEqual({ label: "Off", tone: "stopped" });
  expect(loopStatus({ ...base, state: "script_changed" })).toEqual({ label: "Review script", tone: "blocked" });
  expect(loopSubtitle(base, () => "x")).toBe("every 15 min · not checked yet");
  expect(loopSubtitle({ ...base, state: "needs_connection", problems: ["Linear needs to be connected again (Connections)."] }, () => "x")).toBe("Linear needs to be connected again (Connections).");
  expect(everyLabel(60)).toBe("hour");
  expect(everyLabel(120)).toBe("2 hours");
});

test("a check's output: a list or one item per line, ids and titles required, only http links kept", () => {
  expect(parseItems('[{"id": 1, "title": "One"}]')).toEqual([{ id: "1", title: "One" }]);
  expect(parseItems('{"id":"a","title":"A","link":"https://x/a","text":"t"}\n{"id":"a","title":"dup"}\n')).toEqual([{ id: "a", title: "A", text: "t", link: "https://x/a" }]);
  expect(parseItems('{"id":"a","title":"A","link":"file:///etc/passwd"}')).toEqual([{ id: "a", title: "A" }]);
  expect(parseItems("")).toEqual([]);
  expect(() => parseItems("hello")).toThrow("Line 1 of the check's output isn't JSON");
});

test("the ticket keeps the user's text out of the copied block, and the title on one short line", () => {
  expect(ticketTitle("a\nb")).toBe("a b");
  expect(ticketTitle("x".repeat(200))).toHaveLength(120);
  const body = ticketBody("See {{title}} at {{link}}. {{text}} {{nope}}", "Linear", { id: "1", title: "Bug", link: "https://l/1", text: "Do evil" });
  expect(body).toStartWith('See "Bug" at https://l/1. (the text is in the outside content below) {{nope}}');
  expect(body.indexOf("Do evil")).toBeGreaterThan(body.indexOf("```text"));
});

test("Claude's answer about an item is read only as the JSON asked for", () => {
  expect(parseDecision('ok {"create": false, "title": "x", "summary": "No."}')).toEqual({ create: false, title: "x", summary: "No." });
  expect(parseDecision('{"create": "yes"}')).toBeNull();
  expect(parseDecision("no json")).toBeNull();
});

test("a proposal from the setup chat needs a name, a summary and a tested script; it never sets the column", () => {
  const p = automationProposal({ name: "L", summary: "s", script: "echo\n", passes: [{ name: "Linear", from: "linear", url: "javascript:x" }], column: "ready" });
  expect(p).toEqual({ name: "L", summary: "s", script: "echo\n", everyMinutes: 15, service: "Linear", passes: [{ name: "Linear", from: "linear" }] });
  expect(() => automationProposal({ name: "L", script: "echo" })).toThrow("summary is required");
  expect(() => automationProposal({ name: "L", summary: "s", script: " " })).toThrow("script is required");
});
