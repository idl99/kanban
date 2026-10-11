import { expect, test } from "bun:test";
import { attentionFor, byWaitingAge, type HostHuddle, huddleBusy, lastChange, snoozeKey, userWaitReason, withSnooze } from "../src/server/attention";
import type { SessionSummary } from "../src/server/session";
import type { Ticket } from "../src/server/types";

const T = (p: Partial<Ticket>): Ticket => ({
  id: "t", title: "T", status: "planning", order: 1, sessionId: "s", worktree: null, branch: null, prUrl: null,
  outcome: null, lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: "", updatedAt: "", body: "b", ...p,
});
const S = (p: Partial<SessionSummary>): SessionSummary => ({
  title: null, lastMessage: null, artifacts: [], updatedAt: "", openQuestions: 0, pendingProposal: null, pendingNewTickets: [], pendingTeammates: [], ...p,
});

test("running tickets never need the user", () => {
  expect(attentionFor(T({ outcome: "failed" }), S({ openQuestions: 3 }), true)).toBeNull();
});

test("failures and blocks come first", () => {
  expect(attentionFor(T({ outcome: "failed" }), null, false)).toMatchObject({ kind: "failed", label: "Run failed" });
  expect(attentionFor(T({ outcome: "blocked" }), S({ openQuestions: 2 }), false)!.kind).toBe("blocked");
  expect(attentionFor(T({ status: "review", outcome: "blocked", capHit: { capUsd: 0.05, at: "" } }), null, false))
    .toMatchObject({ kind: "blocked", label: "Stopped at $0.05 cap" });
});

test("open questions", () => {
  expect(attentionFor(T({}), S({ openQuestions: 5 }), false)).toMatchObject({ kind: "questions", label: "Answer 5 questions" });
  expect(attentionFor(T({}), S({ openQuestions: 1 }), false)!.label).toBe("Answer 1 question");
  expect(attentionFor(T({ outcome: "needs_input" }), null, false)!.kind).toBe("questions");
});

test("unapplied proposal, but not once applied", () => {
  const prop = { title: "New", description: "D" };
  expect(attentionFor(T({}), S({ pendingProposal: prop }), false)).toMatchObject({ kind: "proposal", label: "Review proposal" });
  expect(attentionFor(T({ title: "New", body: "D" }), S({ pendingProposal: prop }), false)).toBeNull();
});

test("review column and Claude replies in planning", () => {
  expect(attentionFor(T({ status: "review", outcome: "done" }), null, false)).toMatchObject({ kind: "review", label: "Ready for review" });
  const replied = S({ lastMessage: { role: "assistant", text: "hi", at: "" } });
  expect(attentionFor(T({}), replied, false)).toMatchObject({ kind: "reply", label: "Claude replied" });
  // Cut off by a restart: not a reply yet.
  expect(attentionFor(T({ interrupted: { at: "", mode: "refine", partial: "Half" } }), replied, false)).toBeNull();
  expect(attentionFor(T({ status: "backlog" }), replied, false)).toBeNull();
  expect(attentionFor(T({ status: "done" }), replied, false)).toBeNull();
  // A quiet reply to a huddle digest or another ticket isn't one for the user.
  expect(attentionFor(T({}), S({ lastMessage: { role: "assistant", text: "hi", at: "", peerReply: true } }), false)).toBeNull();
  expect(attentionFor(T({}), S({ lastMessage: { role: "user", text: "hi", at: "" } }), false)).toBeNull();
});

test("done and backlog tickets never need the user", () => {
  const prop = { title: "New", description: "D" };
  for (const status of ["done", "backlog"] as const) {
    expect(attentionFor(T({ status }), S({ openQuestions: 2 }), false)).toBeNull();
    expect(attentionFor(T({ status, outcome: "failed" }), null, false)).toBeNull();
    expect(attentionFor(T({ status, outcome: "blocked" }), null, false)).toBeNull();
    expect(attentionFor(T({ status, outcome: "needs_input" }), null, false)).toBeNull();
    expect(attentionFor(T({ status }), S({ pendingProposal: prop }), false)).toBeNull();
  }
  expect(attentionFor(T({ status: "review" }), S({ openQuestions: 2 }), false)!.kind).toBe("questions");
});

test("proposed new tickets need attention until each one exists", () => {
  const s = S({ pendingNewTickets: [{ title: "A", description: "" }, { title: "B", description: "" }] });
  expect(attentionFor(T({}), s, false)).toMatchObject({ kind: "proposal", label: "Review proposed tickets" });
  expect(attentionFor(T({}), s, false, { createdTitles: new Set(["A"]) })!.kind).toBe("proposal");
  expect(attentionFor(T({}), s, false, { createdTitles: new Set(["A", "B"]) })).toBeNull();
});

test("a stuck plan needs the user, unless the ticket is done or every child is finished", () => {
  const plan = { state: "stuck" as const, maxConcurrent: 2, wakeups: 1, startedAt: "", originalCount: 2, reason: "x" };
  expect(attentionFor(T({ status: "review", plan }), null, false)).toMatchObject({ kind: "blocked", label: "Plan stuck" });
  expect(attentionFor(T({ status: "done", plan }), null, false)).toBeNull();
  expect(attentionFor(T({ status: "review", outcome: "done", plan }), null, false, { planComplete: true })).toMatchObject({ kind: "review", label: "Ready for review" });
});

test("userWaitReason: plan children waiting on the user", () => {
  expect(userWaitReason(T({ status: "backlog" }), null)).toBeNull();
  expect(userWaitReason(T({ status: "planning" }), null)).toBe("in Planning");
  expect(userWaitReason(T({ status: "backlog" }), S({ openQuestions: 2 }))).toBe("2 questions for you");
  expect(userWaitReason(T({ status: "review", outcome: "needs_input" }), null)).toBe("has questions for you");
  expect(userWaitReason(T({ status: "backlog" }), S({ pendingProposal: { title: "New", description: "d" } }))).toBe("proposal to apply");
  // Applied already: the ticket matches the proposal.
  expect(userWaitReason(T({ status: "backlog", title: "New", body: "d" }), S({ pendingProposal: { title: "New", description: "d" } }))).toBeNull();
  expect(userWaitReason(T({ status: "done" }), S({ openQuestions: 1 }))).toBeNull();
});

test("an unanswered teammate card asks for a review; saved or dismissed ones don't", () => {
  const s = S({ pendingTeammates: ["toolu_a", "toolu_b"] });
  expect(attentionFor(T({}), s, false)).toMatchObject({ kind: "proposal", label: "Review proposed teammate" });
  expect(attentionFor(T({ teammateCards: { toolu_a: { state: "saved", at: "" } } }), s, false)?.kind).toBe("proposal");
  expect(attentionFor(T({ teammateCards: { toolu_a: { state: "saved", at: "" }, toolu_b: { state: "dismissed", at: "" } } }), s, false)).toBeNull();
  expect(attentionFor(T({ status: "review" }), S({ pendingTeammates: ["toolu_a"] }), false)?.kind).toBe("proposal");
  expect(attentionFor(T({}), s, true)).toBeNull();
});

const H = (p: Partial<HostHuddle>): HostHuddle => ({ working: 0, queued: false, tagged: 0, learnings: 0, closeRequest: false, since: null, ...p });

test("a working huddle on the ticket: not blocked, failed or your turn, and it doesn't need the user", () => {
  const busy = H({ working: 3 });
  expect(huddleBusy(busy)).toBe(true);
  expect(attentionFor(T({ status: "review", outcome: "blocked" }), null, false, { huddle: busy })).toBeNull();
  expect(attentionFor(T({ status: "review", outcome: "failed" }), null, false, { huddle: busy })).toBeNull();
  expect(attentionFor(T({ status: "review", outcome: "done" }), null, false, { huddle: busy })).toBeNull();
  // A wake on its way counts as working too.
  expect(attentionFor(T({ status: "review", outcome: "blocked" }), null, false, { huddle: H({ queued: true }) })).toBeNull();
  // An idle huddle doesn't hide the ticket's own state.
  expect(attentionFor(T({ status: "review", outcome: "blocked" }), null, false, { huddle: H({}) })!.kind).toBe("blocked");
});

test("the huddle needs the user when it tags @you, asks to close or has learnings to review", () => {
  const t = T({ status: "review", outcome: "blocked" });
  expect(attentionFor(t, null, false, { huddle: H({ working: 2, tagged: 1, since: "2026-10-10T08:00:00Z" }) }))
    .toEqual({ kind: "huddle", label: "Huddle: 1 for you", since: "2026-10-10T08:00:00Z" });
  expect(attentionFor(t, null, false, { huddle: H({ working: 2, closeRequest: true, tagged: 1 }) })!.label).toBe("Huddle asks to close");
  expect(attentionFor(t, null, false, { huddle: H({ learnings: 2 }) })!.label).toBe("Review 2 learnings");
  // Still nothing while the ticket's own session is replying, and never on Done.
  expect(attentionFor(t, null, true, { huddle: H({ tagged: 1 }) })).toBeNull();
  expect(attentionFor(T({ status: "done" }), null, false, { huddle: H({ tagged: 1 }) })).toBeNull();
});

test("since: when the ticket started waiting", () => {
  const t = T({ status: "review", outcome: "done", lastRunAt: "2026-10-10T01:00:00Z", updatedAt: "2026-10-10T05:00:00Z" });
  const s = S({ updatedAt: "2026-10-10T03:00:00Z", lastMessage: { role: "assistant", text: "done", at: "2026-10-10T02:00:00Z" } });
  expect(attentionFor(t, s, false)!.since).toBe("2026-10-10T02:00:00Z");
  expect(lastChange(t, S({ updatedAt: "2026-10-10T03:00:00Z" }))).toBe("2026-10-10T03:00:00Z");
  expect(lastChange(t, null)).toBe("2026-10-10T01:00:00Z");
  expect(lastChange(T({ updatedAt: "2026-10-10T05:00:00Z" }), null)).toBe("2026-10-10T05:00:00Z");
  // A huddle ask waits since its oldest tag, else since the ticket's last change.
  expect(attentionFor(t, s, false, { huddle: H({ tagged: 1 }) })!.since).toBe("2026-10-10T02:00:00Z");
});

test("the Inbox lists the oldest wait first", () => {
  const rows = [{ attention: { since: "2026-10-10T09:00:00Z" } }, { attention: { since: "2026-10-09T05:00:00Z" } }, { attention: { since: "2026-10-10T08:48:00Z" } }];
  expect(rows.sort(byWaitingAge).map((r) => r.attention.since)).toEqual(["2026-10-09T05:00:00Z", "2026-10-10T08:48:00Z", "2026-10-10T09:00:00Z"]);
});

test("a snooze hides what the ticket waits for until it ends", () => {
  const now = Date.parse("2026-10-11T10:00:00Z");
  const s = S({ openQuestions: 1, lastMessage: { role: "assistant", text: "?", at: "2026-10-11T09:00:00Z" } });
  const t = T({ status: "review" });
  const a = attentionFor(t, s, false)!;
  const snoozed = T({ status: "review", snooze: { until: "2026-10-12T10:00:00Z", key: snoozeKey(t, s, a) } });
  expect(withSnooze(snoozed, s, a, now)).toEqual({ attention: null, snoozed: { attention: a, until: "2026-10-12T10:00:00Z" } });
  // Time's up: it needs the user again.
  expect(withSnooze(snoozed, s, a, Date.parse("2026-10-12T10:00:01Z"))).toEqual({ attention: a, snoozed: null });
  // Saving the snooze bumps updatedAt; that alone doesn't end it.
  expect(withSnooze({ ...snoozed, updatedAt: "2026-10-11T10:00:00Z" }, s, a, now).attention).toBeNull();
});

test("a state change ends the snooze", () => {
  const now = Date.parse("2026-10-11T10:00:00Z");
  const s = S({ openQuestions: 1, lastMessage: { role: "assistant", text: "?", at: "2026-10-11T09:00:00Z" } });
  const t = T({});
  const a = attentionFor(t, s, false)!;
  const snoozed = T({ snooze: { until: "2026-10-12T10:00:00Z", key: snoozeKey(t, s, a) } });
  // A new question: new label.
  const s2 = { ...s, openQuestions: 2 };
  expect(withSnooze(snoozed, s2, attentionFor(snoozed, s2, false), now).attention).toMatchObject({ label: "Answer 2 questions" });
  // Claude wrote again.
  const s3 = { ...s, lastMessage: { role: "assistant" as const, text: "and?", at: "2026-10-11T09:30:00Z" } };
  expect(withSnooze(snoozed, s3, attentionFor(snoozed, s3, false), now).attention).not.toBeNull();
  // Another run failed.
  const failed = { ...snoozed, outcome: "failed" as const, lastRunAt: "2026-10-11T09:45:00Z" };
  expect(withSnooze(failed, s, attentionFor(failed, s, false), now).attention).toMatchObject({ kind: "failed" });
  // Nothing to wait for: nothing snoozed either.
  expect(withSnooze(snoozed, s, null, now)).toEqual({ attention: null, snoozed: null });
});

test("a new huddle ask ends the snooze, even with the same label", () => {
  const now = Date.parse("2026-10-11T10:00:00Z");
  const h = (since: string): HostHuddle => ({ working: 0, queued: false, tagged: 1, learnings: 0, closeRequest: false, since });
  const t = T({ status: "review" });
  const a = attentionFor(t, null, false, { huddle: h("2026-10-11T08:00:00Z") })!;
  expect(a.label).toBe("Huddle: 1 for you");
  const snoozed = T({ status: "review", snooze: { until: "2026-10-12T10:00:00Z", key: snoozeKey(t, null, a) } });
  expect(withSnooze(snoozed, null, a, now).attention).toBeNull();
  // The user read that tag; a new one came in later: same label, new since.
  const again = attentionFor(snoozed, null, false, { huddle: h("2026-10-11T09:30:00Z") })!;
  expect(withSnooze(snoozed, null, again, now).attention).toEqual(again);
});

test("a new huddle ask ends the snooze while an older one is still open", () => {
  const now = Date.parse("2026-10-11T10:00:00Z");
  const close = H({ closeRequest: true, since: "2026-10-11T08:00:00Z", latest: "2026-10-11T08:00:00Z" });
  const t = T({ status: "review" });
  const a = attentionFor(t, null, false, { huddle: close })!;
  const snoozed = T({ status: "review", snooze: { until: "2026-10-12T10:00:00Z", key: snoozeKey(t, null, a, close) } });
  expect(withSnooze(snoozed, null, a, now, close).attention).toBeNull();
  // A tag for you arrives later: same label ("Huddle asks to close"), same since, newer latest.
  const tagged = { ...close, tagged: 1, latest: "2026-10-11T09:30:00Z" };
  const again = attentionFor(snoozed, null, false, { huddle: tagged })!;
  expect(again.label).toBe(a.label);
  expect(withSnooze(snoozed, null, again, now, tagged).attention).toEqual(again);
});
