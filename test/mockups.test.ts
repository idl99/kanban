import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractMockups, mockupName, saveMockups, stripMockups } from "../src/server/mockups";
import { parseSession } from "../src/server/session";
import { chatPrompt, firstRunPrompt, resumePrompt } from "../src/server/prompts";
import type { Ticket } from "../src/server/types";
import { tempDir } from "./helpers";

const reply = `Here are two layouts.
<ckanban-mockup name="a-compact.html">
\`\`\`html
<!doctype html><p>A</p>
\`\`\`
</ckanban-mockup>
<ckanban-mockup name="b-sidebar.html"><!doctype html><p>B</p></ckanban-mockup>
<ckanban-mockup name="../evil.html"><p>x</p></ckanban-mockup>
Review them in the Outputs tab.`;

test("mockup names are plain html file names", () => {
  expect(mockupName("a-compact.html")).toBe("a-compact.html");
  expect(mockupName("B_2.HTM")).toBe("B_2.HTM");
  for (const bad of ["../x.html", "a/b.html", "x.js", ".hidden.html", "a..b.html", ""]) expect(mockupName(bad)).toBeNull();
});

test("mockup blocks are extracted, fences dropped, bad names skipped", () => {
  expect(extractMockups(reply)).toEqual([
    { name: "a-compact.html", html: "<!doctype html><p>A</p>" },
    { name: "b-sidebar.html", html: "<!doctype html><p>B</p>" },
  ]);
});

test("the chat shows the reply without mockup blocks, even an unfinished one", () => {
  const s = stripMockups(reply);
  expect(s.names).toEqual(["a-compact.html", "b-sidebar.html"]);
  expect(s.text).not.toContain("<p>");
  expect(s.text).toContain("Here are two layouts.");
  expect(s.text).toContain("Review them in the Outputs tab.");
  expect(stripMockups('Drawing:\n<ckanban-mockup name="a.html"><html>').text.trim()).toBe("Drawing:");
  expect(stripMockups('Drawing:\n<ckanban-mockup name="a.html">\n').text.trim()).toBe("Drawing:");
});

test("a reply that only mentions the mockup tag keeps everything after it", () => {
  const mention = 'Claude sends <ckanban-mockup name=\\"...\\"> blocks.';
  const ticket = `<ckanban-ticket>{"title":"Fix","description":"Uses ${mention}"}</ckanban-ticket>`;
  for (const text of [`Here:\n${ticket}`, `The <ckanban-mockup> tag. ${ticket}`, `Real tag <ckanban-mockup name="a.html"><p> then ${ticket}`]) {
    expect(stripMockups(text).text).toContain("<ckanban-ticket>");
  }
  const raw = JSON.stringify({ type: "assistant", uuid: "u1", timestamp: "2026-10-04T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: `Here:\n${ticket}` }] } });
  expect(parseSession(raw).entries[0].proposal?.title).toBe("Fix");
});

test("question options keep a valid mockup file name", () => {
  const q = '<ckanban-questions>[{"question":"Start button?","options":[{"label":"a: two buttons","mockup":"a-two-buttons.html","recommended":true},{"label":"b","mockup":"../x.html"},{"label":"c","mockup":5}],"multiSelect":false}]</ckanban-questions>';
  const raw = JSON.stringify({ type: "assistant", uuid: "u1", timestamp: "2026-10-04T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: q }] } });
  const opts = parseSession(raw).entries[0].questions![0].options;
  expect(opts[0].mockup).toBe("a-two-buttons.html");
  expect("mockup" in opts[1]).toBe(false);
  expect("mockup" in opts[2]).toBe(false);
});

test("mockups are saved to outputs/mockups and replaced by name", () => {
  const out = tempDir("ck-out-");
  expect(saveMockups(out, "no mockups")).toEqual([]);
  expect(existsSync(join(out, "mockups"))).toBe(false);
  expect(saveMockups(out, reply)).toEqual(["a-compact.html", "b-sidebar.html"]);
  expect(readFileSync(join(out, "mockups", "a-compact.html"), "utf8")).toBe("<!doctype html><p>A</p>\n");
  expect(existsSync(join(out, "evil.html"))).toBe(false);
  saveMockups(out, '<ckanban-mockup name="a-compact.html"><p>A2</p></ckanban-mockup>');
  expect(readFileSync(join(out, "mockups", "a-compact.html"), "utf8")).toBe("<p>A2</p>\n");
});

test("planning asks for mockup blocks and question-form feedback; runs follow the target design only when there are mockups", () => {
  const t = { id: "t_1", title: "New sidebar", body: "b", runCount: 1, mode: "auto" } as Ticket;
  const out = tempDir("ck-out-");
  const refine = chatPrompt(t, "", "refine", out);
  expect(refine).toContain('<ckanban-mockup name="a-compact.html">');
  expect(refine).toContain(join(out, "mockups"));
  expect(refine).toContain('"mockup":"a-two-buttons.html"');
  expect(refine).toContain("one question per design decision");
  expect(refine).toContain('"Target design"');
  expect(refine).not.toMatch(/approve/i);
  expect(chatPrompt(t, "hi", "act", out)).not.toContain("ckanban-mockup");
  const runs = () => [firstRunPrompt(t, { repo: "remote" as const, outputDir: out }), resumePrompt(t, [], out), chatPrompt(t, "hi", "act", out)];
  for (const p of runs()) expect(p).not.toContain("# Target design");
  mkdirSync(join(out, "mockups"));
  writeFileSync(join(out, "mockups", "notes.txt"), "x");
  for (const p of runs()) expect(p).not.toContain("# Target design");
  writeFileSync(join(out, "mockups", "a-two-buttons.html"), "<p>ok</p>");
  for (const p of runs()) {
    expect(p).toContain("# Target design");
    expect(p).toContain(join(out, "mockups"));
  }
  expect(chatPrompt(t, "", "refine", out)).not.toContain("# Target design");
});
