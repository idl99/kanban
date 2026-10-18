import { expect, test } from "bun:test";
import { fileFinder } from "../web/src/fileLinkContext";
import { codePath, textPaths } from "../web/src/filePaths";

test("codePath takes relative, absolute and home paths", () => {
  expect(codePath("applications/sierra/swe-agent/review-for-leo.md")).toBe("applications/sierra/swe-agent/review-for-leo.md");
  expect(codePath("/Users/leo/notes/a.txt")).toBe("/Users/leo/notes/a.txt");
  expect(codePath("~/docs/plan.md")).toBe("~/docs/plan.md");
  expect(codePath("./README.md")).toBe("./README.md");
  expect(codePath("README.md")).toBe("README.md");
  expect(codePath("web/src/Transcript.tsx")).toBe("web/src/Transcript.tsx");
});

test("codePath joins a path wrapped across lines inside the backticks", () => {
  expect(codePath("applications/sierra/swe-\nagent-mandarin/review-for-\nleo.md")).toBe("applications/sierra/swe-agent-mandarin/review-for-leo.md");
  expect(codePath("docs/\n  plan.md")).toBe("docs/plan.md");
});

test("codePath skips commands, urls, flags and plain words", () => {
  expect(codePath("bun run test")).toBeNull();
  expect(codePath("https://example.com/a.md")).toBeNull();
  expect(codePath("--no-verify")).toBeNull();
  expect(codePath("useState")).toBeNull();
  expect(codePath("src/")).toBeNull();
  expect(codePath("..")).toBeNull();
  expect(codePath("")).toBeNull();
});

test("textPaths finds paths in prose, not urls or trailing dots", () => {
  expect(textPaths("Please read applications/sierra/review.md. It lists the form.")).toEqual([{ at: 12, path: "applications/sierra/review.md" }]);
  expect(textPaths("Saved to /Users/leo/out/report.pdf and ~/x/y.json")).toEqual([
    { at: 9, path: "/Users/leo/out/report.pdf" },
    { at: 39, path: "~/x/y.json" },
  ]);
  expect(textPaths("See https://example.com/docs/a.html for more")).toEqual([]);
  expect(textPaths("and/or the plan.md file")).toEqual([]);
  expect(textPaths("no paths here")).toEqual([]);
});

test("fileFinder remembers found paths and rechecks missing ones after a while", async () => {
  let clock = 0;
  const asked: string[][] = [];
  const exists = new Set(["a.md"]);
  const find = fileFinder(async (paths) => { asked.push(paths); return paths.filter((p) => exists.has(p)); }, () => clock);
  expect([...await find(["a.md", "b.md"])]).toEqual(["a.md"]);
  expect([...await find(["a.md", "b.md"])]).toEqual(["a.md"]);
  expect(asked).toEqual([["a.md", "b.md"]]);
  exists.add("b.md");
  clock = 20_000;
  expect([...await find(["a.md", "b.md"])]).toEqual(["a.md", "b.md"]);
  expect(asked[1]).toEqual(["b.md"]);
});
