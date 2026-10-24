import { expect, test } from "bun:test";
import { RUN_ENV } from "../src/client";
import { callTool, messageResultText, type ToolContext } from "../src/mcp-server";

const none = { delivered: false, devices: 0, onScreen: 0, webhook: false, banner: false, reason: null, error: null };

test("notify_user tells Claude where the message went, or why it went nowhere", () => {
  expect(messageResultText({ ...none, delivered: true, devices: 2, banner: true })).toBe("Sent to 2 phones or browsers, the Mac banner. It is logged on the ticket.");
  expect(messageResultText({ ...none, delivered: true, webhook: true, onScreen: 1 })).toContain("Skipped 1 where the board is on screen.");
  expect(messageResultText({ ...none, reason: "off" })).toContain("turned off \"Messages from Claude\"");
  expect(messageResultText({ ...none, reason: "on-screen", onScreen: 1 })).toContain("board open on screen right now (1 device)");
  expect(messageResultText({ ...none, reason: "nowhere" })).toContain("hasn't set up any notifications");
  expect(messageResultText({ ...none, error: "webhook answered 500" })).toBe("Not sent: webhook answered 500.");
});

test("notify_user works only from a ticket's own run or chat, on that ticket", async () => {
  const calls: unknown[][] = [];
  const client = {
    listProfiles: async () => [{ name: "Kanban", slug: "kb", path: "/tmp/kb" }],
    notifyUser: async (...a: unknown[]) => (calls.push(a), { ...none, delivered: true, devices: 1 }),
  };
  const ctx = (env: Record<string, string>) => ({ client, cwd: "/tmp", env }) as unknown as ToolContext;
  const outside = await callTool("notify_user", { message: "Pick A or B" }, ctx({}));
  expect(outside.isError).toBe(true);
  expect(outside.content[0].text).toContain("inside a board run or ticket chat");
  const inside = await callTool("notify_user", { message: "Pick A or B" }, ctx({ [RUN_ENV]: "kb/t_1" }));
  expect(inside.content[0].text).toBe("Sent to 1 phone or browser. It is logged on the ticket.");
  expect(calls).toEqual([["kb", "t_1", "Pick A or B", "kb/t_1"]]);
});
