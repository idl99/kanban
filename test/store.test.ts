import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";

let store: Store;
const profile: Profile = {
  name: "Demo", slug: "demo", path: "/tmp/demo", baseBranch: "main",
  maxParallel: 1, model: null, createdAt: "2026-09-29T00:00:00.000Z",
};

beforeEach(() => {
  store = new Store(mkdtempSync(join(tmpdir(), "ck-store-")));
  store.saveProfile(profile);
});

test("config defaults", () => {
  expect(store.config()).toEqual({ port: 7777, prPollMinutes: 5 });
});

test("profile CRUD", () => {
  expect(store.listProfiles().map((p) => p.slug)).toEqual(["demo"]);
  expect(store.getProfile("demo")?.name).toBe("Demo");
  store.saveProfile({ ...profile, maxParallel: 3 });
  expect(store.getProfile("demo")?.maxParallel).toBe(3);
  store.deleteProfile("demo");
  expect(store.getProfile("demo")).toBeNull();
});

test("ticket round-trip with tricky title", () => {
  const title = `He said: "hi" — ✨`;
  const t = store.createTicket("demo", { title, body: "line1\n---\nline2", status: "backlog" });
  const got = store.getTicket("demo", t.id)!;
  expect(got.title).toBe(title);
  expect(got.body).toBe("line1\n---\nline2");
  expect(got.status).toBe("backlog");
  expect(got.outcome).toBeNull();
  expect(store.listTickets("demo").length).toBe(1);
});

test("new tickets append in Ready and go on top elsewhere", () => {
  const a = store.createTicket("demo", { title: "a", body: "", status: "ready" });
  const b = store.createTicket("demo", { title: "b", body: "", status: "ready" });
  const c = store.createTicket("demo", { title: "c", body: "", status: "backlog" });
  const d = store.createTicket("demo", { title: "d", body: "", status: "backlog" });
  expect(b.order).toBe(a.order + 1);
  expect(c.order).toBe(1);
  expect(d.order).toBe(c.order - 1);
  expect(store.listTickets("demo").filter((t) => t.status === "backlog").map((t) => t.title)).toEqual(["d", "c"]);
});

test("changing column puts the ticket on top, except Ready which appends", () => {
  const r1 = store.createTicket("demo", { title: "r1", body: "", status: "ready" });
  const v1 = store.createTicket("demo", { title: "v1", body: "", status: "review" });
  const v2 = store.createTicket("demo", { title: "v2", body: "", status: "review" });
  const x = store.createTicket("demo", { title: "x", body: "", status: "backlog" });
  expect(store.updateTicket("demo", x.id, { status: "review" }).order).toBe(Math.min(v1.order, v2.order) - 1);
  expect(store.updateTicket("demo", x.id, { status: "ready" }).order).toBe(r1.order + 1);
});

test("explicit order wins and same-column updates keep the position", () => {
  store.createTicket("demo", { title: "v1", body: "", status: "review" });
  const x = store.createTicket("demo", { title: "x", body: "", status: "backlog" });
  expect(store.updateTicket("demo", x.id, { status: "review", order: 2.5 }).order).toBe(2.5);
  expect(store.updateTicket("demo", x.id, { status: "review", title: "renamed" }).order).toBe(2.5);
  expect(store.updateTicket("demo", x.id, { body: "edited", lastActivity: "working" }).order).toBe(2.5);
});

test("comments append in order", () => {
  const t = store.createTicket("demo", { title: "x", body: "", status: "backlog" });
  store.addComment("demo", t.id, "user", "first");
  store.addComment("demo", t.id, "ai", "second");
  expect(store.listComments("demo", t.id).map((c) => [c.author, c.text])).toEqual([
    ["user", "first"], ["ai", "second"],
  ]);
});

test("activity append/read", () => {
  const t = store.createTicket("demo", { title: "x", body: "", status: "backlog" });
  store.appendActivity("demo", t.id, 1, { type: "system" });
  store.appendActivity("demo", t.id, 1, { type: "result" });
  const a = store.readActivity("demo", t.id);
  expect(a.map((e) => e.event.type)).toEqual(["system", "result"]);
  expect(a[0].run).toBe(1);
});

test("corrupt ticket listed with error", () => {
  const dir = join(store.root, "profiles", "demo", "tickets", "t_bad");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ticket.md"), "garbage without frontmatter");
  const list = store.listTickets("demo");
  const bad = list.find((t) => t.id === "t_bad")!;
  expect(bad.error).toStartWith("corrupt");
});

test("parentId round-trips; tickets without it still load", () => {
  const planner = store.createTicket("demo", { title: "plan", body: "", status: "planning" });
  const child = store.createTicket("demo", { title: "child", body: "b", status: "backlog", parentId: planner.id });
  expect(store.getTicket("demo", child.id)!.parentId).toBe(planner.id);
  expect(store.getTicket("demo", planner.id)!.parentId).toBeUndefined();
  expect(readFileSync(store.ticketPath("demo", planner.id), "utf8")).not.toContain("parentId");
});
