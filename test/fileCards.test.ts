import { expect, test } from "bun:test";
import { filesByReply } from "../web/src/fileCards";

const e = (uuid: string, at: string, role: "user" | "assistant", kind = "text") => ({ uuid, at, role, kind, text: uuid });
const f = (name: string, updatedAt: string) => ({ name, size: 10, updatedAt });

test("output files go under the last reply of the turn they were written in", () => {
  const entries = [
    e("u1", "2026-10-06T10:00:00Z", "user"),
    e("a1", "2026-10-06T10:00:05Z", "assistant"),
    e("t1", "2026-10-06T10:00:06Z", "assistant", "tool"),
    e("a2", "2026-10-06T10:01:00Z", "assistant"),
    e("u2", "2026-10-06T11:00:00Z", "user"),
    e("a3", "2026-10-06T11:00:30Z", "assistant"),
  ];
  const cards = filesByReply(entries, [
    f("report.md", "2026-10-06T10:00:50Z"),
    f("b/data.csv", "2026-10-06T10:00:40Z"),
    f("later.md", "2026-10-06T11:00:20Z"),
    f("mockups/a-x.html", "2026-10-06T10:00:30Z"),
    f("old.md", "2026-10-05T10:00:00Z"),
  ]);
  expect(cards.get("a2")?.map((x) => x.name)).toEqual(["b/data.csv", "report.md"]);
  expect(cards.get("a3")?.map((x) => x.name)).toEqual(["later.md"]);
  expect(cards.has("a1")).toBe(false);
  expect([...cards.values()].flat().some((x) => x.name === "old.md" || x.name.startsWith("mockups/"))).toBe(false);
});

test("a turn without a reply yet gets no card", () => {
  const cards = filesByReply([e("a0", "2026-10-06T09:00:00Z", "assistant"), e("u1", "2026-10-06T10:00:00Z", "user")], [f("r.md", "2026-10-06T10:00:10Z")]);
  expect(cards.size).toBe(0);
});

test("many files under one reply stay fast", () => {
  const files = Array.from({ length: 50_000 }, (_, i) => f(`dir/${50_000 - i}.js`, "2026-10-06T10:00:10Z"));
  const start = performance.now();
  const cards = filesByReply([e("u1", "2026-10-06T10:00:00Z", "user"), e("a1", "2026-10-06T10:00:05Z", "assistant")], files);
  expect(cards.get("a1")?.length).toBe(50_000);
  expect(cards.get("a1")?.[0].name).toBe("dir/1.js");
  expect(performance.now() - start).toBeLessThan(2000);
});
