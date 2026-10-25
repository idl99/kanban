// The board learns on its own (learn.ts, learner.ts): the quiet pile, saving on repeat, standing rules, undo, huddle
// lessons, expiry and the weekly tidy.
import { beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Bus } from "../src/server/events";
import { type HuddleNote, parseNotes, serializeNotes } from "../src/server/huddle-notes";
import {
  addToPile, applyTidyOp, type Candidate, emptyPile, EXPIRE_DAYS, learnedRulesBlock, newCorrections, parseLearned, parseTidy, prune, shiftNotes, ticketKey, type TidyNote,
} from "../src/server/learn";
import { Learner } from "../src/server/learner";
import { corrections } from "../src/server/lessons";
import type { SessionEntry } from "../src/server/session";
import type { SideCallInput, SideCallResult } from "../src/server/side-call";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

const RESULT = 'CKANBAN_RESULT: {"status":"done","prUrl":null,"summary":"Added the link."}';
let n = 0;
const entry = (role: "user" | "assistant", text: string): SessionEntry => ({ uuid: `u${++n}`, at: `2026-10-25T01:${String(n).padStart(2, "0")}:00Z`, role, kind: "text", text });
/** A finished run, then what the user typed after it. */
const conversation = (...said: string[]) => [entry("user", "Add a forgot password link."), entry("assistant", `Added it.\n${RESULT}`), ...said.map((t) => entry("user", t))];

let store: Store;
let bus: Bus;
let learner: Learner;
let calls: SideCallInput[];
let answers: ((i: SideCallInput) => SideCallResult)[];
const sessions = new Map<string, SessionEntry[]>();
let clock: Date;

const ok = (o: unknown): SideCallResult => ({ ok: true, text: JSON.stringify(o), costUsd: 0.01, model: "claude-haiku-5-5" });
/** The next side call answers with these lessons. */
const answer = (lessons: unknown[]) => answers.push(() => ok({ lessons }));
/** The id shown in the PILE section of the last call whose text contains `words`. */
const pileId = (i: SideCallInput, words: string) =>
  i.prompt.slice(i.prompt.lastIndexOf("PILE:")).split("\n").find((l) => l.startsWith("[") && l.includes(words))?.match(/^\[([^\]]+)\]/)?.[1] ?? "";

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  calls = [];
  answers = [];
  clock = new Date("2026-10-25T02:00:00Z");
  store.saveProfile({ name: "P", slug: "p", path: tempDir("ck-plain-"), baseBranch: "main", maxParallel: 1, createdAt: "" });
  learner = new Learner(store, bus, {
    sideCall: async (i) => {
      calls.push(i);
      const next = answers.shift();
      return next ? next(i) : { ok: false, error: "no answer queued" };
    },
    entries: (t) => sessions.get(t.id) ?? [],
    isRunning: () => false,
    now: () => clock,
  });
});

function ticket(title: string, said: string[], status: "review" | "done" = "done") {
  const t = store.createTicket("p", { title, body: "Add a link.", status });
  store.updateTicket("p", t.id, { sessionId: `s-${t.id}`, runCount: 1 });
  sessions.set(t.id, conversation(...said));
  return t.id;
}

const rulesFile = () => store.boardRulesPath("p");
const rules = () => (existsSync(rulesFile()) ? parseNotes(readFileSync(rulesFile(), "utf8")).map((r) => r.text) : []);

test("a correction on one ticket waits in Watching; the same one on a second ticket saves one general rule", async () => {
  const a = ticket("Signup form", ["No, links on forms go under the main button."]);
  answer([{ mistake: "Put the link above the button.", evidence: "links on forms go under the main button", rule: "Put new links on forms under the main button.", match: "", standing: "" }]);
  const [first] = await learner.scanTicket("p", a);
  expect(calls).toHaveLength(1);
  expect(calls[0].model).toBe("haiku");
  expect(calls[0].prompt).toContain("links on forms go under the main button");
  expect(calls[0].prompt).toContain("PILE:\n(empty)");
  expect(first).toMatchObject({ state: "watching", general: true, text: "Put new links on forms under the main button." });
  expect(rules()).toEqual([]);
  expect(learner.view("p")).toMatchObject({ saved: [], newCount: 0 });
  expect(learner.view("p").watching.map((c) => c.id)).toEqual([first.id]);

  // Read once: the same corrections aren't read again.
  await learner.scanTicket("p", a);
  expect(calls).toHaveLength(1);

  // An add-on of the same ticket is not a second ticket.
  const addOn = store.createTicket("p", { title: "Fix the link again", body: "", status: "done" });
  store.updateTicket("p", addOn.id, { addOnOf: a, sessionId: "x", runCount: 1 });
  sessions.set(addOn.id, conversation("Links still go under the button."));
  answers.push((i) => ok({ lessons: [{ mistake: "m", evidence: "under the button", rule: "Links go under the button.", match: pileId(i, "under the main button"), standing: "" }] }));
  await learner.scanTicket("p", addOn.id);
  expect(rules()).toEqual([]);

  // A second, unrelated ticket says the same thing: saved, in general words, once.
  const b = ticket("Invite dialog", ["Again: the link belongs under the main button, not above."]);
  answers.push((i) => ok({ lessons: [{ mistake: "m", evidence: "under the main button", rule: "Keep form links below the main button.", match: pileId(i, "under the main button"), standing: "" }] }));
  const [same] = await learner.scanTicket("p", b);
  expect(same.id).toBe(first.id);
  expect(same.state).toBe("saved");
  expect(rules()).toEqual(["Put new links on forms under the main button."]);
  const view = learner.view("p");
  expect(view.saved).toHaveLength(1);
  expect(view.saved[0]).toMatchObject({ kind: "saved", where: "Rule for this board", text: "Put new links on forms under the main button." });
  expect(new Set(view.saved[0].sources!.map((s) => s.key)).size).toBe(2);
  expect(view.newCount).toBe(1);
  expect(view.watching).toEqual([]);
  // Every run on the board gets it.
  expect(learnedRulesBlock(store, "p")).toContain("- Put new links on forms under the main button.");
  // Opening the view clears the count.
  await learner.markSeen("p");
  expect(learner.view("p").newCount).toBe(0);
});

test("'always' and 'never' in the user's own words save at once; a quote the user didn't type doesn't", async () => {
  const a = ticket("Release notes", ["Never put file paths in summaries."]);
  answer([{ mistake: "m", evidence: "Never put file paths in summaries.", rule: "Leave file paths out of summaries.", match: "", standing: "Never put file paths in summaries" }]);
  const [c] = await learner.scanTicket("p", a);
  expect(c.state).toBe("saved");
  expect(rules()).toEqual(["Leave file paths out of summaries."]);

  const b = ticket("Changelog", ["Use plain words here."]);
  answer([{ mistake: "m", evidence: "plain words", rule: "Use plain words in summaries.", match: "", standing: "always use plain words" }]);
  const [d] = await learner.scanTicket("p", b);
  expect(d.state).toBe("watching");
  expect(rules()).toEqual(["Leave file paths out of summaries."]);
});

test("undo puts the rules file back exactly; an undone lesson isn't saved again; redo saves it", async () => {
  writeFileSync(rulesFile(), serializeNotes("rules", "repo", []).replace(/^#.*\n/, "") + "- A rule the user kept. <!-- by you -->\n");
  const before = readFileSync(rulesFile(), "utf8");
  const a = ticket("A", ["Always run the tests before saying it works."]);
  answer([{ mistake: "m", evidence: "run the tests", rule: "Run the tests before saying it works.", match: "", standing: "Always run the tests" }]);
  const [c] = await learner.scanTicket("p", a);
  expect(rules()).toEqual(["Run the tests before saying it works.", "A rule the user kept."]);
  const change = learner.view("p").saved[0];
  await learner.undo(change.id);
  expect(readFileSync(rulesFile(), "utf8")).toBe(before);
  expect(learner.view("p").saved[0].undoneAt).toBeTruthy();
  expect(learner.readPile().candidates.find((x) => x.id === c.id)!.state).toBe("undone");
  await expect(learner.undo(change.id)).rejects.toThrow("already undone");

  // The same lesson again from another ticket: remembered as undone, not saved.
  const b = ticket("B", ["Run the tests first, please."]);
  answers.push((i) => ok({ lessons: [{ mistake: "m", evidence: "run the tests", rule: "Run the tests first.", match: pileId(i, "Run the tests"), standing: "" }] }));
  const [again] = await learner.scanTicket("p", b);
  expect(again.id).toBe(c.id);
  expect(again.state).toBe("undone");
  expect(readFileSync(rulesFile(), "utf8")).toBe(before);

  // Undo after the user changed the file meanwhile: only the lesson goes, their change stays.
  await learner.undo(change.id, true);
  expect(rules()).toEqual(["Run the tests before saying it works.", "A rule the user kept."]);
  writeFileSync(rulesFile(), readFileSync(rulesFile(), "utf8") + "- Another rule the user added. <!-- by you -->\n");
  await learner.undo(change.id);
  expect(rules()).toEqual(["A rule the user kept.", "Another rule the user added."]);
});

test("Save now and Drop on a lesson seen once", async () => {
  const a = ticket("A", ["Use the shared date helper."]);
  answer([{ mistake: "m", evidence: "shared date helper", rule: "Format dates with the shared date helper.", match: "", standing: "" }]);
  const [c] = await learner.scanTicket("p", a);
  await learner.drop(c.id);
  expect(learner.view("p").watching).toEqual([]);
  await learner.drop(c.id, true);
  expect(learner.view("p").watching.map((x) => x.id)).toEqual([c.id]);
  await learner.saveNow(c.id);
  expect(rules()).toEqual(["Format dates with the shared date helper."]);
  await expect(learner.saveNow(c.id)).rejects.toThrow("already saved");
});

test("huddle lessons go to the pile; the same lesson from a second huddle is saved as a note, for every role when roles differ", async () => {
  const host = store.createTicket("p", { title: "Voice notes", body: "", status: "in_progress" });
  answer([{ rule: "Run the suite on the base version before blaming a change.", match: "" }]);
  const [c] = await learner.addHuddleLessons("p", { id: "h_one", hostTicket: host.id }, { handle: "qa" }, "qa", [
    { text: "messaging-webhook has 4 failing suites; run them on base first", evidence: "#12", scope: "repo" },
  ]);
  expect(calls[0].system).toContain("helper AI agents");
  expect(calls[0].prompt).toContain("messaging-webhook");
  expect(c).toMatchObject({ kind: "huddle", state: "watching", text: "Run the suite on the base version before blaming a change." });
  expect(c.sources[0]).toMatchObject({ by: "qa", ticket: host.id, title: "Voice notes" });
  expect(store.readHuddleNotes("p", "qa", "repo")).toEqual([]);

  // Two agents of the same huddle count once.
  answers.push((i) => ok({ lessons: [{ rule: "Check the base first.", match: pileId(i, "base version") }] }));
  await learner.addHuddleLessons("p", { id: "h_one", hostTicket: host.id }, { handle: "qa-lead" }, "qa-lead", [{ text: "check base", evidence: "", scope: "repo" }]);
  expect(store.readHuddleNotes("p", "_all", "repo")).toEqual([]);

  answers.push((i) => ok({ lessons: [{ rule: "Compare with the base version first.", match: pileId(i, "base version") }] }));
  const [saved] = await learner.addHuddleLessons("p", { id: "h_two", hostTicket: host.id }, { handle: "reviewer" }, "reviewer", [{ text: "x", evidence: "", scope: "repo" }]);
  expect(saved.state).toBe("saved");
  expect(store.readHuddleNotes("p", "_all", "repo").map((x) => x.text)).toEqual(["Run the suite on the base version before blaming a change."]);
  expect(learner.view("p").saved[0].where).toBe("Note for every teammate");

  // A failed call still keeps the lesson, in the agent's words, not general yet.
  const [raw] = await learner.addHuddleLessons("p", { id: "h_three", hostTicket: host.id }, { handle: "qa" }, "qa", [{ text: "Mock Valkey as a Map", evidence: "", scope: "general" }]);
  expect(raw).toMatchObject({ state: "watching", general: false, text: "Mock Valkey as a Map" });
});

test("pile: lessons seen once expire after 60 days; repeated and saved ones stay; a cap keeps it small", () => {
  const pile = emptyPile();
  let i = 0;
  const src = (key: string, at: string) => ({ kind: "ticket" as const, slug: "p", id: key, title: key, by: "you", at, quote: "", key });
  const add = (text: string, key: string, at: string, match: string | null = null) =>
    addToPile(pile, { text, match }, { kind: "ticket", dest: { kind: "rules", slug: "p" }, source: src(key, at), newId: () => `c${++i}` });
  const old = add("Old lesson.", "t1", "2026-08-01T00:00:00Z");
  const twice = add("Twice.", "t2", "2026-08-01T00:00:00Z");
  add("Twice.", "t3", "2026-08-02T00:00:00Z", twice.id);
  const fresh = add("Fresh.", "t4", "2026-10-20T00:00:00Z");
  const now = new Date(Date.parse("2026-08-01T00:00:00Z") + (EXPIRE_DAYS + 1) * 86_400_000);
  expect(prune(pile, now).candidates.map((c) => c.id)).toEqual([twice.id, fresh.id]);
  expect(old.id).toBe("c1");
  // Cap: watching ones go first, oldest first.
  const capped = prune(pile, new Date("2026-08-02T00:00:00Z"), 2).candidates.map((c: Candidate) => c.id);
  expect(capped).toEqual([twice.id, fresh.id]);
});

test("helpers: new corrections, add-on chains, parsing", () => {
  const t = store.createTicket("p", { title: "T", body: "", status: "done" });
  const es = conversation("No, the other way.");
  const c = corrections(t, es, []);
  expect(newCorrections(c, [`msg:${es[2].uuid}`]).messages).toEqual([]);
  expect(ticketKey("p", { id: "c", addOnOf: "b" }, [{ id: "a", addOnOf: null }, { id: "b", addOnOf: "a" }])).toBe("ticket:p/a");
  expect(parseLearned("nope", [])).toBeNull();
  expect(parseLearned('{"lessons":[{"rule":"A.","match":"zz"},{"rule":"","match":""},{"rule":"B.","match":"c1"}]}', ["c1"]))
    .toEqual([{ text: "A.", match: null, standing: null, evidence: "", mistake: "" }, { text: "B.", match: "c1", standing: null, evidence: "", mistake: "" }]);
});

test("tidy steps: merge across files, rewrite, remove, never the user's own notes, found by identity", () => {
  const note = (text: string, by = "qa") => ({ text, by, date: "2026-10-10", huddle: null });
  const files = { qa: [note("Verify a hotfix is on master with merge-base (h_123)."), note("Mine.", "you")], "qa-lead": [note("Verify the hotfix is on master first.")], _all: [note("Stale #12 to #22 note.")] };
  const list: TidyNote[] = Object.entries(files).flatMap(([role, ns]) => ns.map((n) => ({ role, note: n })));
  const ops = parseTidy(JSON.stringify({ ops: [
    { op: "merge", ids: [1, 3], text: "Check a fix is on the main version before calling it live.", to: "_all", why: "Same note in two roles." },
    { op: "remove", id: 2, why: "x" },
    { op: "rewrite", id: 4, text: "Ask the judge for a final ruling after the rebuttal.", why: "General words." },
    { op: "remove", id: 9, why: "unknown" },
  ] }), list, ["qa", "qa-lead", "_all"])!;
  expect(ops.map((o) => o.op)).toEqual(["merge", "rewrite"]);
  let cur: Record<string, HuddleNote[]> = files;
  for (const op of ops) cur = applyTidyOp(cur, op, list, "2026-10-25");
  expect(cur.qa.map((n) => n.text)).toEqual(["Mine."]);
  expect(cur["qa-lead"]).toEqual([]);
  expect(cur._all.map((n) => n.text)).toEqual(["Check a fix is on the main version before calling it live.", "Ask the judge for a final ruling after the rebuttal."]);
});

test("the tidy pass rewrites the real files, logs each step, and Undo restores them exactly", async () => {
  const qa = store.huddleNotesPath("p", "qa", "general");
  store.writeHuddleNotes("p", "qa", "general", [
    { text: "Before blaming DLS-405, run base.", by: "qa", date: "2026-10-10", huddle: "h_a" },
    { text: "My own note.", by: "you", date: null, huddle: null },
  ]);
  store.writeHuddleNotes("p", "qa-lead", "general", [{ text: "Run the suite on base before blaming a change.", by: "qa-lead", date: "2026-10-11", huddle: "h_b" }]);
  const before = { qa: readFileSync(qa, "utf8"), lead: readFileSync(store.huddleNotesPath("p", "qa-lead", "general"), "utf8") };
  answers.push((i) => {
    expect(i.model).toBe("sonnet");
    expect(i.prompt).toContain("(qa) Before blaming DLS-405");
    return ok({ ops: [{ op: "merge", ids: [1, 3], text: "Run the suite on the base version before blaming a change.", to: "_all", why: "Same note in two roles." }] });
  });
  const steps = await learner.tidy();
  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatchObject({ kind: "merged", slug: null, where: "Note for every teammate, all boards", old: ["Before blaming DLS-405, run base.", "Run the suite on base before blaming a change."] });
  expect(store.readHuddleNotes("p", "qa", "general").map((x) => x.text)).toEqual(["My own note."]);
  expect(existsSync(store.huddleNotesPath("p", "qa-lead", "general"))).toBe(true);
  expect(store.readHuddleNotes("p", "_all", "general").map((x) => x.text)).toEqual(["Run the suite on the base version before blaming a change."]);
  expect(learner.view("p").cleaned).toHaveLength(1);
  expect(learner.readPile().tidyAt).toBe(clock.toISOString());
  // Not due again for a week.
  expect(await learner.tidyIfDue()).toEqual([]);

  await learner.undo(steps[0].id);
  expect(readFileSync(qa, "utf8")).toBe(before.qa);
  expect(readFileSync(store.huddleNotesPath("p", "qa-lead", "general"), "utf8")).toBe(before.lead);
  expect(existsSync(store.huddleNotesPath("p", "_all", "general"))).toBe(false);
});

test("undo out of order keeps notes with the same text: a removed duplicate comes back", async () => {
  const f = store.huddleNotesPath("p", "qa", "general");
  store.writeHuddleNotes("p", "qa", "general", [
    { text: "Rule A", by: "qa", date: "2026-10-01", huddle: null },
    { text: "Rule A", by: "qa-2", date: "2026-10-02", huddle: null },
    { text: "Rule C", by: "qa", date: "2026-10-01", huddle: null },
  ]);
  const orig = readFileSync(f, "utf8");
  answers.push(() => ok({ ops: [{ op: "remove", id: 2, why: "dup" }, { op: "rewrite", id: 3, text: "Rule C general", why: "x" }] }));
  const steps = await learner.tidy();
  expect(steps).toHaveLength(2);
  // Oldest first: the second step changed the file after the first.
  for (const s of steps) await learner.undo(s.id);
  expect(readFileSync(f, "utf8")).toBe(orig);
});

test("shiftNotes: counts notes with the same text", () => {
  const n = (text: string) => ({ text, by: "qa", date: null, huddle: null });
  const md = (...ts: string[]) => serializeNotes("qa", "general", ts.map(n));
  expect(shiftNotes([n("A"), n("B")], md("A", "B"), md("A", "A", "B")).map((x) => x.text)).toEqual(["A", "A", "B"]);
  expect(shiftNotes([n("A"), n("A"), n("B")], md("A", "A", "B"), md("A", "B")).map((x) => x.text)).toEqual(["A", "B"]);
  // A copy the user added meanwhile isn't added twice.
  expect(shiftNotes([n("A"), n("A"), n("B")], md("A", "B"), md("A", "A", "B")).map((x) => x.text)).toEqual(["A", "A", "B"]);
});

test("review fixes: a failed tidy retries, notes changed during the call are left alone, dropped and undone lessons stay out", async () => {
  store.writeHuddleNotes("p", "qa", "general", [{ text: "Note one (h_abc).", by: "qa", date: "2026-10-10", huddle: null }]);
  // Claude out of reach: no tidyAt, so the next hourly check tries again.
  answers.push(() => ({ ok: false, error: "offline" }));
  expect(await learner.tidy()).toEqual([]);
  expect(learner.readPile().tidyAt).toBeUndefined();
  // The user edits the notes while the call runs: nothing is written over their edit.
  answers.push(() => {
    store.writeHuddleNotes("p", "qa", "general", [{ text: "The user's new note.", by: "you", date: null, huddle: null }, { text: "Note one (h_abc).", by: "qa", date: "2026-10-10", huddle: null }]);
    return ok({ ops: [{ op: "remove", id: 1, why: "x" }] });
  });
  expect(await learner.tidy()).toEqual([]);
  expect(store.readHuddleNotes("p", "qa", "general").map((n) => n.text)).toEqual(["The user's new note.", "Note one (h_abc)."]);

  // Dropped: a later match keeps it dropped instead of saving it.
  const a = ticket("A", ["Keep commit messages short."]);
  answer([{ mistake: "m", evidence: "short", rule: "Keep commit messages short.", match: "", standing: "" }]);
  const [c] = await learner.scanTicket("p", a);
  await learner.drop(c.id);
  const b = ticket("B", ["Shorter commit messages, please."]);
  answers.push((i) => ok({ lessons: [{ mistake: "m", evidence: "short", rule: "Short commit messages.", match: pileId(i, "commit messages"), standing: "" }] }));
  const [again] = await learner.scanTicket("p", b);
  expect(again).toMatchObject({ id: c.id, state: "dropped" });
  expect(rules()).toEqual([]);
  // Not in general words: Save now is refused.
  const raw = addToPile(learner.readPile(), { text: "", match: null }, { kind: "ticket", dest: { kind: "rules", slug: "p" }, newId: () => "x", source: { kind: "ticket", slug: "p", id: "t", title: "T", by: "you", at: "2026-10-25T00:00:00Z", quote: "q", key: "k" } });
  expect(raw.general).toBe(false);
  // The cap never evicts lessons the user said no to.
  const pile = emptyPile();
  for (const [i, state] of (["undone", "dropped", "watching", "saved"] as const).entries()) {
    pile.candidates.push({ id: `c${i}`, kind: "ticket", text: "t", general: true, dest: { kind: "rules", slug: "p" }, sources: [], firstAt: "2026-10-01T00:00:00Z", lastAt: `2026-10-0${i + 1}T00:00:00Z`, state });
  }
  expect(prune(pile, new Date("2026-10-05T00:00:00Z"), 2).candidates.map((x) => x.state)).toEqual(["undone", "dropped"]);
});
