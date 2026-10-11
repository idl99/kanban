import { describe, expect, test } from "bun:test";
import { artifactUrlsIn, collectLinks, isArtifact } from "../src/server/links";
import { parseSession } from "../src/server/session";

const line = (o: object) => JSON.stringify(o);
/** A huddle teammate's transcript that published one artifact through the publish_artifact MCP tool. */
const teammateSession = [
  line({ type: "assistant", uuid: "a1", timestamp: "2026-10-11T10:00:00Z", message: { content: [{ type: "tool_use", id: "p1", name: "mcp__ckanban__publish_artifact", input: {} }] } }),
  line({ type: "user", uuid: "u1", timestamp: "2026-10-11T10:00:05Z", message: { content: [{ type: "tool_result", tool_use_id: "p1", content: "Published /o/findings-board.html at https://claude.ai/artifact/Huddle1" }] } }),
].join("\n");

describe("collectLinks", () => {
  test("merges every source, newest first, with its source", () => {
    const links = collectLinks({
      ticket: [{ url: "https://claude.ai/artifact/Mine1", label: "report", at: "2026-10-11T09:00:00Z" }],
      huddles: [{ handle: "researcher", artifacts: parseSession(teammateSession).artifacts }],
      results: [{ author: "ai", text: "Done. See [Ranked ideas](https://claude.ai/code/artifact/Res-1).", at: "2026-10-11T11:00:00Z" }],
      shareLinks: [{ file: "mockups/report.html", url: "https://claude.ai/artifact/Share1", at: "2026-10-11T08:00:00Z" }],
    });
    expect(links).toEqual([
      { url: "https://claude.ai/code/artifact/Res-1", label: "Ranked ideas", at: "2026-10-11T11:00:00Z", source: "result" },
      { url: "https://claude.ai/artifact/Huddle1", label: "findings-board", at: "2026-10-11T10:00:05Z", source: "huddle:@researcher" },
      { url: "https://claude.ai/artifact/Mine1", label: "report", at: "2026-10-11T09:00:00Z", source: "ticket" },
      { url: "https://claude.ai/artifact/Share1", label: "report.html", at: "2026-10-11T08:00:00Z", source: "share" },
    ]);
    expect(links.map(isArtifact)).toEqual([true, true, true, false]);
  });

  test("removes duplicates by URL, keeping the newest time and the publish's label", () => {
    const url = "https://claude.ai/artifact/Same1";
    const links = collectLinks({
      ticket: [{ url, label: "Competitor research", at: "2026-10-11T09:00:00Z" }],
      huddles: [{ handle: "qa", artifacts: [{ url, label: "older", at: "2026-10-11T08:00:00Z" }] }],
      results: [{ author: "ai", text: `Published at ${url}`, at: "2026-10-11T12:00:00Z" }],
    });
    expect(links).toEqual([{ url, label: "Competitor research", at: "2026-10-11T09:00:00Z", source: "ticket" }]);
  });

  test("a result summary mentioning publishes doesn't reorder them", () => {
    const a = "https://claude.ai/artifact/OldA";
    const b = "https://claude.ai/artifact/NewB";
    const ticket = [{ url: a, label: "A", at: "2026-10-11T09:00:00Z" }, { url: b, label: "B", at: "2026-10-11T10:00:00Z" }];
    const listed = collectLinks({ ticket, results: [{ author: "ai", text: `See ${a} and ${b}`, at: "2026-10-11T10:05:00Z" }] });
    expect(listed.map((l) => [l.url, l.at])).toEqual([[b, "2026-10-11T10:00:00Z"], [a, "2026-10-11T09:00:00Z"]]);
    const again = collectLinks({ ticket, results: [{ author: "ai", text: `Still: ${a}`, at: "2026-10-11T11:00:00Z" }] });
    expect(again[0].url).toBe(b);
  });

  test("result-only links: newest mention, and a Markdown label beats the default", () => {
    const url = "https://claude.ai/artifact/R1";
    const links = collectLinks({
      results: [
        { author: "ai", text: `Bare ${url}`, at: "2026-10-11T09:00:00Z" },
        { author: "ai", text: `[Roadmap](${url})`, at: "2026-10-11T10:00:00Z" },
      ],
    });
    expect(links).toEqual([{ url, label: "Roadmap", at: "2026-10-11T10:00:00Z", source: "result" }]);
  });

  test("results: only claude.ai artifact URLs from Claude's comments", () => {
    const links = collectLinks({
      results: [
        { author: "ai", text: "Docs: https://docs.google.com/document/d/abc and https://notion.so/x, PR https://github.com/a/b/pull/1", at: "2026-10-11T10:00:00Z" },
        { author: "user", text: "https://claude.ai/artifact/UserSaid", at: "2026-10-11T10:00:00Z" },
        { author: "ai", text: "Artifact: https://claude.ai/artifact/Ok1.", at: "2026-10-11T10:00:00Z" },
      ],
    });
    expect(links.map((l) => [l.url, l.label])).toEqual([["https://claude.ai/artifact/Ok1", "claude.ai artifact"]]);
  });

  test("drops non-https links", () => {
    expect(collectLinks({ shareLinks: [{ file: "a.html", url: "javascript:alert(1)", at: "2026-10-11T10:00:00Z" }] })).toEqual([]);
  });
});

test("artifactUrlsIn", () => {
  expect(artifactUrlsIn("x https://claude.ai/artifact/A1) [T](https://claude.ai/code/artifact/B2) https://claude.ai/chat/C3")).toEqual([
    { url: "https://claude.ai/artifact/A1", label: null },
    { url: "https://claude.ai/code/artifact/B2", label: "T" },
  ]);
});
