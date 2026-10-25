import { expect, test } from "bun:test";
import { expired, handoff, HANDOFF_AFTER_RUN_MS, HANDOFF_RUNNING_MS, liveView, repeats, saved, withHandoff } from "../web/src/liveReply";

const reply = (text: string) => ({ role: "assistant" as const, kind: "text", text });
const RESULT = (summary: string) => `CKANBAN_RESULT: ${JSON.stringify({ status: "done", prUrl: null, summary })}`;

// The reply of ticket t_20261008_24aw's chat run 2 (shortened), as it streamed and as the session file saved it.
const final = `It works end to end, but I'd still improve eight things.

**Worth fixing (small):**
1. **Bundled skills often don't show in the picker.**
2. **Queued commands show the wrong hint.**

I'd do 1–2 as one small follow-up ticket.

<ckanban-move to="planning"/>

${RESULT("Slash commands work end to end, but a review found 8 things to improve.")}`;

test("a reply right after another reply's result line is found in the saved conversation", () => {
  // The previous run's reply ends with its result line; the moved reply is saved without the move tag.
  const entries = [
    reply(`Slash commands now run from every ticket chat.\n\n${RESULT("Pushed to main.")}`),
    reply(final.replace('<ckanban-move to="planning"/>', "").trim()),
  ];
  const h = handoff(final, 1);
  expect(h.flat.startsWith("It works end to end")).toBe(true);
  expect(saved(entries, h)).toBe(true);
});

test("the live copy stays while the saved reply isn't loaded yet", () => {
  const entries = [reply(`Earlier reply.\n\n${RESULT("Earlier.")}`)];
  expect(saved(entries, handoff(final, 1))).toBe(false);
});

test("stay tag and result line don't stop the match", () => {
  const text = `Proposed a follow-up.\n<ckanban-stay/>\n${RESULT("Proposed.")}`;
  const entries = [reply(`Before.\n${RESULT("x")}`), reply(`Proposed a follow-up.\n\n${RESULT("Proposed.")}`)];
  expect(saved(entries, handoff(text, 1))).toBe(true);
});

test("a reply split over several saved text blocks still matches", () => {
  const text = "First part.\n\nSecond part.";
  expect(saved([reply(`x\n${RESULT("x")}`), reply("First part."), reply("Second part.")], handoff(text, 1))).toBe(true);
});

test("only board blocks: waits for any new entry", () => {
  const h = handoff('<ckanban-questions>[{"question":"Q?"}]</ckanban-questions>', 1);
  expect(h.flat).toBe("");
  expect(saved([reply("a")], h)).toBe(false);
  expect(saved([reply("a"), reply("")], h)).toBe(true);
});

test("live view hides board blocks and the result line", () => {
  expect(liveView(final).text.endsWith("follow-up ticket.")).toBe(true);
  expect(liveView('Text\n<ckanban-questions>[').preparing).toBe("Preparing questions…");
});

test("a finished reply waits for its saved copy while the run goes on, and only briefly after it ended", () => {
  const h = handoff("A long reply, then a tool call that streams for a while.", 3, 1_000);
  // Claude Code saves the message only once its tool call has streamed too: well past the old 5 s cut-off.
  expect(expired(h, 1_000 + 30_000, null)).toBe(false);
  expect(expired(h, 1_000 + HANDOFF_RUNNING_MS, null)).toBe(true);
  // The run ended at 40 s: a little longer, counted from the end.
  expect(expired(h, 40_000 + HANDOFF_AFTER_RUN_MS - 1, 40_000)).toBe(false);
  expect(expired(h, 40_000 + HANDOFF_AFTER_RUN_MS, 40_000)).toBe(true);
});

test("the same reply handed over twice (run end and last clear) shows once, the longer copy", () => {
  const short = handoff("It works end to e", 2, 10);
  const full = handoff("It works end to end.", 2, 20);
  const hs = withHandoff([short], full);
  expect(hs.map((h) => [h.text, h.at])).toEqual([["It works end to end.", 10]]);
  expect(withHandoff(hs, short)).toBe(hs);
  expect(withHandoff(hs, handoff("Another reply.", 3, 30)).length).toBe(2);
});

test("the status line doesn't repeat an excerpt of a reply on screen", () => {
  const text = "I checked the code.\n\nThe board   blocks a ticket's own Claude from moving its own card, because a move would cut off the reply.";
  // summarizeEvent: the last text block, whitespace collapsed, first 80 characters.
  const excerpt = "The board blocks a ticket's own Claude from moving its own card, because a move w";
  expect(repeats(excerpt, ["", text])).toBe(true);
  expect(repeats("Editing web/src/Chat.tsx", [text])).toBe(false);
  expect(repeats(null, [text])).toBe(false);
  // The excerpt runs into the result line, which the reply on screen hides: compared with the whole text.
  const done = `Done: \`tea-brewing.md\` is in the Outputs tab.\n\n${RESULT("Wrote it.")}`;
  expect(repeats("Done: `tea-brewing.md` is in the Outputs tab. CKANBAN_RESULT: {\"status\":\"done\",\"prUrl", [done])).toBe(true);
});
