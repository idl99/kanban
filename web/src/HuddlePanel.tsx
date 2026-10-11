import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
  api, type Huddle, type HuddleLearning, type HuddleMessage, type HuddleMode, type HuddleParticipant, type HuddlePreset, type Level, type TeammateProposal, type Ticket,
} from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { draftKey, formKey } from "./drafts";
import {
  BIG_CONTEXT_TOKENS, contextText, dollars, handleColor, handleInitials, huddleCost, idleFor, isForYou, members, mentionCandidates, mentionQuery, participantActivity, sourceLabel, untaggedHint,
  type HuddleState,
} from "./huddle";
import { DEFAULT_MAX, draftError, RosterEditor, rosterDraft, startFromDraft, TemplatePicker, usePresets, useTemplates, type RosterDraft } from "./HuddleRoster";
import { applyTemplate, BRIEF_MAX, DEFAULT_BUDGET, POST_MAX } from "./huddleText";
import { CloseIcon, MoreIcon } from "./icons";
import { KeyHint } from "./KeyHint";
import { useLayer } from "./layers";
import { Select } from "./Select";
import { fullTime } from "./time";
import { useNow } from "./useNow";
import { HuddleRounds, roundLabel } from "./HuddleRounds";
import { SessionPanel } from "./HuddleSession";
import type { MenuItem } from "./HeaderMenu";
import { MoreSheet } from "./PhoneNav";
import { usePhone } from "./usePhone";
import { Markdown } from "./Transcript";
import { usePersistentState } from "./usePersistentState";
import type { HuddleSeed, TeamRequest } from "./Team";
import { TeammateProposalView } from "./TeammateCard";
import { savedText } from "./teammateText";

const clock = (iso: string) => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(undefined, sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
const money = (n: number) => `$${n.toFixed(2)}`;
const STATE_LABEL = { live: "● Live", stopped: "■ Stopped", closed: "Closed" } as const;
/** The brake banner's headline. */
const BRAKE_TEXT = {
  budget: (max: number) => `Huddle paused: ${dollars(max)} budget reached.`,
  messages: () => "Huddle paused: message limit reached.",
  loop: () => "Huddle paused: many messages went by without you.",
} as const;
const STOP_AGENTS_TIP = "Stops huddle agents only. The ticket's own run keeps going.";
/** What Resume adds when the budget is spent. */
const BUDGET_STEP = 10;

function Avatar({ handle, small }: { handle: string; small?: boolean }) {
  return <span className={`hd-av${small ? " small" : ""}`} style={{ background: handleColor(handle) }} aria-hidden>{handleInitials(handle)}</span>;
}

/** The Huddle tab: the ticket's huddle (feed, roster, findings, composer), or a roster editor to start one. */
export function HuddlePanel({ slug, ticket, tickets, state, onError, onOpenChat, onOpenTicket, onOpenTeam, onSelect, onOpenOutput, seed = null }: {
  slug: string;
  ticket: Ticket;
  tickets: Ticket[];
  state: HuddleState;
  /** Show another of the ticket's huddles (an earlier round, read-only); null: the current one. */
  onSelect: (id: string | null) => void;
  /** Show a file of the ticket's outputs (a huddle's summary). */
  onOpenOutput: (name: string) => void;
  /** The Team tab's Start huddle: a roster to fill in (a new huddle, or + Add agent on an open one); `n` changes per request. */
  seed?: { seed: HuddleSeed; n: number } | null;
  onError: (m: string) => void;
  /** The session viewer's link for @main (the ticket's own chat) and for invited tickets. */
  onOpenChat: () => void;
  onOpenTicket: (id: string) => void;
  /** Show a teammate in the dock's Team tab (a saved proposal's Open in Team). */
  onOpenTeam?: (r: TeamRequest) => void;
}) {
  // Starting a new huddle after the last one closed (the earlier rounds stay a click away).
  const [fresh, setFresh] = useState(false);
  const h = state.huddle;
  useEffect(() => setFresh(false), [h?.id]);
  // The current huddle is closed: Start huddle from the Team tab starts a new one.
  useEffect(() => {
    if (seed && state.latest?.status === "closed") setFresh(true);
  }, [seed?.n, state.latest?.id]);
  if (!state.loaded) return <div className="panel-scroll muted"><span className="spinner" /> Loading the huddle…</div>;
  if (state.error && !h) {
    return (
      <div className="panel-scroll">
        <div className="banner error inline" role="alert">Couldn't load the huddle: {state.error} <button className="link-btn" onClick={() => state.reload()}>Retry</button></div>
      </div>
    );
  }
  if (!h || fresh) {
    return <StartHuddle slug={slug} ticket={ticket} tickets={tickets} onError={onError} onBack={h ? () => setFresh(false) : undefined}
      onStarted={() => { onSelect(null); state.reload(); }} seed={seed} />;
  }
  return <HuddleRoom slug={slug} ticket={ticket} tickets={tickets} huddle={h} state={state} onError={onError} onNew={() => setFresh(true)}
    onOpenChat={onOpenChat} onOpenTicket={onOpenTicket} onOpenTeam={onOpenTeam} onSelect={onSelect} onOpenOutput={onOpenOutput} seed={seed} />;
}

/** No huddle yet: pick a roster and start one by hand. */
function StartHuddle({ slug, ticket, tickets, onError, onBack, onStarted, seed }: {
  slug: string;
  ticket: Ticket;
  tickets: Ticket[];
  onError: (m: string) => void;
  onBack?: () => void;
  onStarted: () => void;
  seed: { seed: HuddleSeed; n: number } | null;
}) {
  const presets = usePresets(slug);
  const templates = useTemplates(slug);
  const [draft, setDraft] = useState<RosterDraft>(() => rosterDraft(seed && "preset" in seed.seed ? [{ preset: seed.seed.preset }] : [{ preset: "reviewer" }, { preset: "qa" }]));
  // Start huddle from the Team tab: that teammate alone, or the template's roster and rules (once they load).
  const seeded = useRef(0);
  useEffect(() => {
    if (!seed || seeded.current === seed.n) return;
    if ("preset" in seed.seed) {
      seeded.current = seed.n;
      setDraft(rosterDraft([{ preset: seed.seed.preset }]));
      return;
    }
    if (!templates) return;
    seeded.current = seed.n;
    const name = seed.seed.template;
    const t = templates.find((x) => x.name === name);
    if (t) setDraft((d) => applyTemplate(d, t));
    else onError(`No template "${name}" on this board.`);
  }, [seed?.n, templates]);
  const [busy, setBusy] = useState(false);
  const err = draftError(draft);
  // Built-ins renamed or removed on this board: drop rows whose preset doesn't exist.
  useEffect(() => {
    if (!presets?.length) return;
    const names = new Set(presets.map((p) => p.name));
    setDraft((d) => ({ ...d, rows: d.rows.filter((r) => !r.preset || names.has(r.preset)) }));
  }, [presets]);
  const start = async () => {
    if (busy || err) return;
    setBusy(true);
    try {
      await startFromDraft(slug, ticket.id, draft);
      onStarted();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel-scroll panel-huddle-start">
      <div className="huddle-intro">
        <h3>Start a huddle</h3>
        <p className="muted">
          Helper Claude sessions (reviewers, QA, a lead…) work on this ticket with its own session, which joins as <b>@main</b> and coordinates.
          They talk in one room; you can read along and @tag anyone. Claude can also propose a roster from the chat.
        </p>
      </div>
      <div className="huddle-card">
        <div className="huddle-card-head"><span>🗣 New huddle</span><small>roster</small></div>
        <TemplatePicker templates={templates} draft={draft} setDraft={setDraft} disabled={busy} />
        <RosterEditor presets={presets} draft={draft} setDraft={setDraft} tickets={tickets} hostId={ticket.id} onEnter={start} disabled={busy} />
        <div className="huddle-card-actions">
          <span className="muted small">{err ?? "Agents start as soon as you press Start."}</span>
          <span className="spacer" />
          {onBack && <button className="btn small" onClick={onBack}>Back to the huddle</button>}
          <button className="btn primary small" onClick={start} disabled={busy || !!err || presets === null}>{busy ? "Starting…" : "Start huddle"}</button>
        </div>
      </div>
    </div>
  );
}

function HuddleRoom({ slug, ticket, tickets, huddle: h, state, onError, onNew, onOpenChat, onOpenTicket, onOpenTeam, onSelect, onOpenOutput, seed }: {
  slug: string;
  ticket: Ticket;
  tickets: Ticket[];
  huddle: Huddle;
  state: HuddleState;
  onError: (m: string) => void;
  onNew: () => void;
  onOpenChat: () => void;
  onOpenTicket: (id: string) => void;
  onOpenTeam?: (r: TeamRequest) => void;
  onSelect: (id: string | null) => void;
  onOpenOutput: (name: string) => void;
  seed: { seed: HuddleSeed; n: number } | null;
}) {
  const [confirm, setConfirm] = useState<"stop" | "close" | null>(null);
  // The participant whose session is open beside the feed; Message @handle pre-fills the composer (n: each press).
  const [viewing, setViewing] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ handle: string; n: number } | null>(null);
  // Phone (≤720px): one pane at a time under a one-line bar; the bar's actions sit in a ⋯ sheet (or its invite/rounds lists).
  const phone = usePhone();
  const [pane, setPane] = useState<"chat" | "people" | "findings">("chat");
  const [sheet, setSheet] = useState<"actions" | "invite" | "rounds" | null>(null);
  useEffect(() => setViewing(null), [h.id]);
  const viewable = members(h);
  const viewed = viewable.find((p) => p.handle === viewing) ?? null;
  const stepViewing = (delta: 1 | -1) => {
    const i = viewable.findIndex((p) => p.handle === viewing);
    const next = viewable[(i + delta + viewable.length) % viewable.length];
    if (next) setViewing(next.handle);
  };
  const [adding, setAdding] = useState(false);
  // Start huddle with @x from the Team tab while this huddle is open: add @x to it instead.
  const addSeed = seed && "preset" in seed.seed ? seed.seed.preset : null;
  useEffect(() => {
    if (!seed || h.status === "closed") return;
    if ("preset" in seed.seed) setAdding(true);
    else onError("This ticket already has an open huddle. Close it to start one from a template.");
  }, [seed?.n]);
  const log = useRef<HTMLDivElement>(null);
  const learnings = (h.learnings ?? []).filter((l) => l.status !== "discarded");
  const pending = learnings.filter((l) => l.status === "pending");
  // The learnings drawer: closed by default, open/closed remembered per huddle.
  const [learningsOpen, setLearningsOpen] = usePersistentState(formKey(slug, ticket.id, `huddle-learnings-${h.id}`), () => false, (v) => !v, (v) => typeof v === "boolean");
  const showLearnings = learningsOpen && learnings.length > 0;
  const now = useNow();
  const closed = h.status === "closed";
  const run = (p: Promise<unknown>) => p.catch((e) => onError((e as Error).message));
  const count = members(h).length;
  const spent = huddleCost(h);
  const max = h.maxCostUsd ?? DEFAULT_BUDGET;
  const overBudget = spent >= max;
  const brake = h.status === "stopped" && h.stopReason ? h.stopReason : null;
  const plainFirst = !!brake && brake !== "budget" && !overBudget;
  const quiet = h.status === "live" && !!h.quiet;
  // Messages that tag you (the pending learnings count in forYou too, but have their own section).
  const forYou = closed ? 0 : (h.forYou ?? 0) - (h.learningsPending ?? 0);
  const invitable = tickets.filter((t) => !h.participants.some((p) => p.ticketId === t.id));
  const handles = h.participants.map((p) => p.handle).concat("all");
  const resume = (add?: number) => run(api.huddleAction(slug, h.id, "resume", add));
  const openFindings = h.findings.filter((f) => f.status === "open").length;
  const spenders = members(h).filter((p) => (p.costUsd ?? 0) > 0).sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));

  // ↓ next for you: the next highlighted message below the top of the feed, else the first one.
  const jump = () => {
    const el = log.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + 8;
    const all = [...el.querySelectorAll<HTMLElement>(".for-you")];
    const next = all.find((m) => m.getBoundingClientRect().top > top) ?? all[0];
    next?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  // Two or more rounds: the bar's round picker (with + New huddle) replaces the New huddle button.
  const rounds = state.list.length > 1;
  const summary = h.summary ? <button className="link-btn" onClick={() => onOpenOutput(h.summary!)} title={`Open ${h.summary} in Outputs`}>summary</button> : null;

  const stateLabel = brake ? (
    <span className="huddle-state brake">■ Paused</span>
  ) : quiet ? (
    <span className="huddle-state quiet" title="Nobody is working, no tag is unanswered and no finding is open: the huddle may be done.">
      ● All quiet{h.idleSince && !phone ? ` · idle ${idleFor(h.idleSince, now)}` : ""}
    </span>
  ) : (
    <span className={`huddle-state ${h.status}`}>{STATE_LABEL[h.status]}</span>
  );
  const budget = (
    <span className="hd-budget" title="What the huddle spent so far: its agents' runs and @main's huddle replies. It stops at the budget. The agents' spend is also counted on the ticket card and its Usage tab (@main's replies already are).">
      ·
      <span className={`hd-meter${overBudget ? " over" : ""}`} aria-hidden><i style={{ width: `${Math.min(100, (spent / max) * 100)}%` }} /></span>
      <span className={overBudget ? "hd-over" : undefined}>{money(spent)} / {dollars(max)}</span>
      {!phone && <span className="hd-budget-note">also counted on the ticket card</span>}
    </span>
  );
  // The phone's ⋯ sheet: every bar action that applies now (a brake's Resume buttons stay in its banner).
  const actions: MenuItem[] = [];
  if (!closed) {
    if (count < h.maxParticipants) {
      actions.push({ label: "+ Add agent", onSelect: () => { setAdding(true); setPane("chat"); } });
      if (invitable.length) actions.push({ label: "+ Invite ticket", onSelect: () => setSheet("invite") });
    }
  }
  if (learnings.length) {
    actions.push({ label: "🎓 Learnings", onSelect: () => setLearningsOpen(true),
      badge: pending.length ? <span className="for-you-pill">{pending.length}</span> : <span className="hd-learn-done">✓ all reviewed</span> });
  }
  if (rounds) actions.push({ label: roundLabel(state.list, h), onSelect: () => setSheet("rounds"), badge: <span className="muted small">Rounds ›</span> });
  else if (closed) actions.push({ label: "New huddle", onSelect: onNew });
  if (h.summary) actions.push({ label: "Read the summary", onSelect: () => onOpenOutput(h.summary!) });
  if (!closed) {
    if (h.status === "stopped") {
      if (!brake) {
        if (!overBudget) actions.push({ label: "▶ Resume", onSelect: () => resume() });
        actions.push({ label: `▶ Resume +${money(BUDGET_STEP)}`, onSelect: () => resume(BUDGET_STEP) });
      }
    } else actions.push({ label: "■ Stop agents", danger: true, title: STOP_AGENTS_TIP, onSelect: () => setConfirm("stop") });
    actions.push({ label: "Close huddle", onSelect: () => setConfirm("close") });
  }
  const current = state.list[0];
  const roundItems: MenuItem[] = [
    ...state.list.map((x) => ({
      label: roundLabel(state.list, x), onSelect: () => onSelect(x.id === current?.id ? null : x.id),
      badge: <span className={`hd-round-pill ${x.status}`}>{STATE_LABEL[x.status]}</span>,
    })),
    ...(current?.status === "closed" ? [{ label: "+ New huddle", onSelect: onNew }] : []),
  ];

  return (
    <div className="huddle">
      {phone ? (
        <div className="huddle-bar">
          {stateLabel}
          <span>· {h.seq} msg{h.seq === 1 ? "" : "s"}</span>
          {budget}
          <span className="spacer" />
          {forYou > 0 && pane === "chat" && <button className="link-btn hd-jump" onClick={jump}>↓ for you</button>}
          <button className="btn ghost hd-more" onClick={() => setSheet("actions")} aria-label="Huddle actions" aria-haspopup="menu">
            <MoreIcon size={18} />{pending.length > 0 && <span className="pn-dot" />}
          </button>
        </div>
      ) : (
      <div className="huddle-bar">
        {rounds && <HuddleRounds list={state.list} shown={h} onPick={onSelect} onNew={onNew} onSummary={(x) => onOpenOutput(x.summary!)} />}
        {stateLabel}
        <span title={fullTime(h.createdAt)}>started {clock(h.createdAt)}</span>
        <span>· {h.seq} message{h.seq === 1 ? "" : "s"}</span>
        {budget}
        {forYou > 0 && <button className="link-btn hd-jump" onClick={jump} title={`${forYou} ${forYou === 1 ? "message tags" : "messages tag"} you`}>↓ next for you</button>}
        <span className="spacer" />
        {learnings.length > 0 && (
          <button className={`btn small hd-learn-btn${pending.length ? " pending" : ""}`} aria-expanded={showLearnings} onClick={() => setLearningsOpen(!showLearnings)}
            title={pending.length ? `${pending.length} proposal${pending.length === 1 ? "" : "s"} from agents to review (lessons, teammates)` : "Everything is reviewed"}>
            <span aria-hidden>🎓</span> Learnings
            {pending.length ? <span className="for-you-pill">{pending.length}</span> : <span className="hd-learn-done">✓ all reviewed</span>}
          </button>
        )}
        {closed ? (
          <>
            {h.closedAt && <span title={fullTime(h.closedAt)}>closed {clock(h.closedAt)} · read-only{summary && <> · {summary}</>}</span>}
            {!rounds && <button className="btn small" onClick={onNew}>New huddle</button>}
          </>
        ) : (
          <>
            <button className="btn small" onClick={() => setAdding((a) => !a)} disabled={count >= h.maxParticipants}
              title={count >= h.maxParticipants ? `The huddle is full (${h.maxParticipants})` : undefined}>+ Add agent</button>
            {invitable.length > 0 && count < h.maxParticipants && (
              <Select ariaLabel="Invite a ticket" className="roster-add bar" value={"" as string} renderValue={() => "+ Invite ticket"} menuMaxHeight={260}
                options={invitable.map((t) => ({ value: t.id, label: t.title, hint: t.id }))}
                onChange={(id) => run(api.inviteToHuddle(slug, h.id, id))} />
            )}
            {h.status === "stopped" ? (
              // A brake's Resume buttons are in its banner.
              !brake && (
                <>
                  {!overBudget && <button className="btn small" onClick={() => resume()}>▶ Resume</button>}
                  <button className="btn small" title={`Resume and raise the budget to ${money(max + BUDGET_STEP)}`}
                    onClick={() => resume(BUDGET_STEP)}>▶ Resume +{money(BUDGET_STEP)}</button>
                </>
              )
            ) : (
              <button className="btn small hd-danger" onClick={() => setConfirm("stop")} title={STOP_AGENTS_TIP}>■ Stop agents</button>
            )}
            <button className={`btn small${h.closeRequest || quiet ? " primary" : ""}`} onClick={() => setConfirm("close")}
              title={h.closeRequest ? `@${h.closeRequest.by} asks to close: ${h.closeRequest.reason}` : undefined}>Close huddle</button>
          </>
        )}
      </div>
      )}
      {sheet === "actions" && <MoreSheet label="Huddle actions" items={actions} onClose={() => setSheet(null)}
        footer={closed && h.closedAt ? `Closed ${clock(h.closedAt)} · read-only` : `Started ${clock(h.createdAt)}`} />}
      {sheet === "invite" && <MoreSheet label="Invite a ticket" onClose={() => setSheet(null)}
        items={invitable.map((t) => ({ label: t.title, badge: <span className="muted small">{t.id}</span>, onSelect: () => run(api.inviteToHuddle(slug, h.id, t.id)) }))} />}
      {sheet === "rounds" && <MoreSheet label="Huddles of this ticket" items={roundItems} onClose={() => setSheet(null)}
        footer={current && current.status !== "closed" ? "Only one huddle runs at a time: close the current one to start a new round." : null} />}
      {brake && (
        <div className="hd-banner brake" role="alert">
          <span aria-hidden>⛔</span>
          <span>
            <b>{BRAKE_TEXT[brake](max)}</b> No agent will wake until you act.
            {spenders.length > 0 && <> Spent: {spenders.slice(0, 3).map((p) => `${p.handle} ${money(p.costUsd ?? 0)}`).join(" · ")}{spenders.length > 3 ? " · …" : ""}</>}
          </span>
          <span className="spacer" />
          {/* Out of budget: adding budget is the way on. Any other brake: plain Resume is. */}
          {plainFirst && <button className="btn small primary" onClick={() => resume()}>Resume</button>}
          <button className={`btn small${plainFirst ? "" : " primary"}`} onClick={() => resume(BUDGET_STEP)} title={`Resume and raise the budget to ${money(max + BUDGET_STEP)}`}>
            Resume (+{dollars(BUDGET_STEP)} budget)
          </button>
          {!plainFirst && <button className="btn small" onClick={() => resume()} disabled={overBudget} title={overBudget ? "The budget is spent: add budget to resume" : undefined}>Resume</button>}
          <button className="btn small" onClick={() => setConfirm("close")}>Close</button>
        </div>
      )}
      {quiet && !h.closeRequest && (
        <div className="hd-banner quiet">
          <span aria-hidden>✓</span>
          <span><b>All quiet:</b> nobody working, no open tags, 0 open findings. Check the result, then close.</span>
          <span className="spacer" />
          <button className="btn small primary" onClick={() => setConfirm("close")}>Close huddle</button>
        </div>
      )}
      {h.closeRequest && !closed && (
        <div className="huddle-close-ask">
          <b>@{h.closeRequest.by}</b> asks to close the huddle: {h.closeRequest.reason}.{" "}
          {h.summary ? <>Read the <button className="link-btn" onClick={() => onOpenOutput(h.summary!)}>summary</button> in the ticket's outputs.</> : "The summary is in the ticket's outputs."}
        </div>
      )}
      {adding && !closed && <AddAgent key={seed?.n} slug={slug} huddle={h} preset={addSeed ?? undefined} onDone={() => setAdding(false)} onError={onError} />}
      {phone && (
        <div className="hd-seg" role="tablist" aria-label="Huddle view">
          {([["chat", "Chat", forYou], ["people", "People", count], ["findings", "Findings", openFindings]] as const).map(([k, label, n]) => (
            <button key={k} role="tab" aria-selected={pane === k} className={pane === k ? "on" : undefined} onClick={() => setPane(k)}>
              {label}{k === "chat" ? n > 0 && <span className="for-you-pill">{n}</span> : <span className="hd-seg-n">{n}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="huddle-body">
        {(!phone || pane === "chat") && <div className="huddle-feed">
          <Feed huddle={h} state={state} handles={handles} scroller={log} onSeen={(seq) => run(api.huddleSeen(slug, h.id, seq))} />
          <Composer slug={slug} ticket={ticket} huddle={h} onError={onError} prefill={prefill} onPrefilled={() => setPrefill(null)} onOpenOutput={onOpenOutput} />
        </div>}
        {viewed && (
          <SessionPanel slug={slug} huddle={h} participant={viewed} onClose={() => setViewing(null)} onStep={stepViewing}
            onMessage={(handle) => {
              setPrefill((x) => ({ handle, n: (x?.n ?? 0) + 1 }));
              if (phone) { setViewing(null); setPane("chat"); }
            }} onOpenChat={onOpenChat} onOpenTicket={onOpenTicket} />
        )}
        {(!phone || pane !== "chat") && (
          <aside className="huddle-side">
            {(!phone || pane === "people") && (
              <>
                <Brief slug={slug} huddle={h} handles={handles} onError={onError} />
                <Roster slug={slug} huddle={h} onError={onError} viewing={viewing} onView={(handle) => setViewing((v) => (v === handle ? null : handle))} />
              </>
            )}
            {(!phone || pane === "findings") && <Findings slug={slug} huddle={h} handles={handles} onError={onError} />}
          </aside>
        )}
        {showLearnings && <Learnings slug={slug} huddle={h} onClose={() => setLearningsOpen(false)} onError={onError} onOpenTeam={onOpenTeam} />}
      </div>
      {confirm === "stop" && (
        <ConfirmDialog title="Stop agents?" confirmLabel="Stop agents" busyLabel="Stopping…" onCancel={() => setConfirm(null)}
          onConfirm={async () => { await api.huddleAction(slug, h.id, "stop"); setConfirm(null); }}>
          <p>{STOP_AGENTS_TIP} The huddle agents' runs and @main's huddle replies stop now; nobody is woken until you resume the huddle.</p>
        </ConfirmDialog>
      )}
      {confirm === "close" && (
        <ConfirmDialog title="Close the huddle?" confirmLabel="Close huddle" busyLabel="Closing…" onCancel={() => setConfirm(null)}
          onConfirm={async () => { await api.huddleAction(slug, h.id, "close"); setConfirm(null); }}>
          <p>The huddle's runs stop and it becomes read-only; its history stays here. The ticket's own run keeps going. Clean agent worktrees are removed.</p>
          {pending.length > 0 && (
            <div className="hd-close-learnings">
              <p>
                <b>{pending.length} learning{pending.length === 1 ? "" : "s"} still to review.</b> They stay here after closing, but agents of these roles
                won't get them until you save them:
              </p>
              <ul>{pending.map((l) => <li key={l.id}><span className="muted">@{l.from}:</span> {l.text}</li>)}</ul>
              <button className="btn small primary" onClick={() => {
                setConfirm(null);
                setLearningsOpen(true);
              }}>Review them first</button>
            </div>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

/** A preset name from a role label, as the daemon makes it ("UX critic" -> "ux-critic"). */
const presetName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
const ALL_ROLES = "_all";

/** Where a learning can go: its own role first (or every role for an ad-hoc agent), a new role from an ad-hoc one, other roles. */
function targetOptions(l: HuddleLearning, presets: HuddlePreset[]): { value: string; label: string }[] {
  const roles = presets.filter((p) => p.name !== "main");
  const own = l.preset ? roles.find((p) => p.name === l.preset) : undefined;
  const fresh = !l.preset && presetName(l.role) && !roles.some((p) => p.name === presetName(l.role));
  return [
    ...(own ? [{ value: own.name, label: `${own.role} (this role)` }] : []),
    { value: ALL_ROLES, label: "All roles" },
    ...(fresh ? [{ value: "new", label: `+ New role "${l.role}"` }] : []),
    ...roles.filter((p) => p !== own).map((p) => ({ value: p.name, label: p.role })),
  ];
}

/**
 * Learnings to review, in a drawer over the feed: lessons agents proposed when they turned done. Nothing is saved until
 * the user picks a scope and where it goes and presses Save; saved ones go into every future agent of that role's instructions.
 */
function Learnings({ slug, huddle: h, onClose, onError, onOpenTeam }: {
  slug: string; huddle: Huddle; onClose: () => void; onError: (m: string) => void; onOpenTeam?: (r: TeamRequest) => void;
}) {
  // Reloaded when a proposed teammate is saved, so the other cards see it.
  const saved = (h.learnings ?? []).filter((l) => l.teammate && l.status === "saved").length;
  const presets = usePresets(slug, saved);
  // Esc closes the drawer, but not while editing a lesson (its textarea's Esc cancels the edit).
  useLayer(onClose, { skipInInputs: true });
  const shown = (h.learnings ?? []).filter((l) => l.status !== "discarded");
  const pending = shown.filter((l) => l.status === "pending");
  const adhoc = pending.some((l) => !l.preset && !l.teammate);
  const lessons = pending.some((l) => !l.teammate);
  return (
    <section className="hd-learnings" aria-label="Learnings to review">
      <div className="hd-learnings-head">
        <span aria-hidden>🎓</span> {pending.length ? "Learnings to review" : "Learnings: all reviewed"}
        {pending.length > 0 && <span className="for-you-pill">{pending.length}</span>}
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Close learnings" title="Close (Esc)"><CloseIcon size={12} /><KeyHint keys="Esc" /></button>
      </div>
      <div className="hd-learnings-sub muted small">
        {!pending.length ? "Every lesson and teammate proposed in this huddle is saved or discarded."
          : lessons ? "Proposed by agents when they turned done · nothing is saved until you choose." : "Proposed by agents · nothing is saved until you choose."}
      </div>
      <div className="hd-learnings-list">
        {shown.map((l) => l.teammate
          ? <TeammateLearning key={l.id} slug={slug} huddle={h} l={l} teammate={l.teammate} presets={presets} onError={onError} onOpenTeam={onOpenTeam} />
          : <Learning key={l.id} slug={slug} huddle={h} l={l} presets={presets ?? []} onError={onError} />)}
      </div>
      {adhoc && <div className="hd-learnings-foot muted small">Ad-hoc roles disappear with the huddle unless you save a lesson as a new role. Close huddle asks about learnings still pending.</div>}
    </section>
  );
}

/** A teammate an agent proposed (propose_teammate): saved for all boards (scope general) or this board (repo), as in a chat card. */
function TeammateLearning({ slug, huddle: h, l, teammate, presets, onError, onOpenTeam }: {
  slug: string; huddle: Huddle; l: HuddleLearning; teammate: TeammateProposal; presets: HuddlePreset[] | null; onError: (m: string) => void;
  onOpenTeam?: (r: TeamRequest) => void;
}) {
  const [busy, setBusy] = useState(false);
  const act = async (p: Promise<unknown>) => {
    setBusy(true);
    try {
      await p;
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const scope = (s: Level) => (s === "global" ? "general" as const : "repo" as const);
  return (
    <div className={`hd-learning ${l.status}`}>
      <div className="hd-learning-who"><b>@{l.from}</b> · {l.role}</div>
      <div className="hd-learning-main">
        {l.status === "saved" ? (
          <div className="proposal teammate-card applied">
            <span className="proposal-tag">Teammate saved</span>
            <div className="proposal-actions">
              <span className="badge ok">{savedText(l.target, l.scope === "general" ? "global" : "board")}</span>
              {onOpenTeam && <button className="btn small ghost" onClick={() => onOpenTeam({ action: "open", name: l.target })}>Open in Team</button>}
            </div>
          </div>
        ) : (
          <TeammateProposalView proposal={teammate} presets={presets} busy={busy} initialScope={l.scope === "general" ? "global" : "board"} dismissLabel="Discard"
            onScope={(s) => act(api.editLearning(slug, h.id, l.id, { scope: scope(s) }))}
            onSave={(s) => act(api.saveLearning(slug, h.id, l.id, { scope: scope(s) }))}
            onDismiss={() => act(api.discardLearning(slug, h.id, l.id))} />
        )}
      </div>
    </div>
  );
}

function Learning({ slug, huddle: h, l, presets, onError }: { slug: string; huddle: Huddle; l: HuddleLearning; presets: HuddlePreset[]; onError: (m: string) => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (p: Promise<unknown>) => {
    setBusy(true);
    try {
      await p;
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const roleLabel = (name: string) => (name === ALL_ROLES ? "All roles" : presets.find((p) => p.name === name)?.role ?? name);
  const where = l.scope === "general" ? "all repos" : `${slug} notes`;
  const options = targetOptions(l, presets);
  const target = options.some((o) => o.value === l.target) ? l.target : options[0]?.value ?? ALL_ROLES;
  const save = async () => {
    const text = edit?.trim();
    if (await act(api.saveLearning(slug, h.id, l.id, { ...(text && text !== l.text ? { text } : {}), target }))) setEdit(null);
  };
  return (
    <div className={`hd-learning ${l.status}`}>
      <div className="hd-learning-who">
        <b>@{l.from}</b> · {l.role}{!l.preset && <span className="hd-adhoc">ad-hoc</span>}
      </div>
      <div className="hd-learning-main">
        {edit !== null ? (
          <textarea rows={2} value={edit} maxLength={400} disabled={busy} autoFocus aria-label="Lesson"
            onChange={(e) => setEdit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.stopPropagation(); setEdit(null); }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const text = edit.trim();
                if (text && text !== l.text) act(api.editLearning(slug, h.id, l.id, { text })).then((ok) => ok && setEdit(null));
                else setEdit(null);
              }
            }} />
        ) : (
          <div className="hd-learning-rule">{l.text}</div>
        )}
        {l.evidence && <div className="hd-learning-ev">Evidence: {l.evidence}</div>}
        <div className="hd-learning-row">
          Scope
          <span className="hd-scope" role="radiogroup" aria-label="Scope">
            {(["general", "repo"] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={l.scope === s} className={l.scope === s ? "on" : undefined}
                disabled={busy || l.status !== "pending"} title={s === "general" ? "Every repo" : `Only the ${slug} board`}
                onClick={() => l.scope !== s && act(api.editLearning(slug, h.id, l.id, { scope: s }))}>
                {s === "general" ? "General" : "This repo"}
              </button>
            ))}
          </span>
          {l.status === "pending" && (
            <>
              Save to
              <Select ariaLabel="Save to" className="roster-select hd-save-to" value={target} options={options} menuMaxHeight={240}
                onChange={(v) => v !== l.target && act(api.editLearning(slug, h.id, l.id, { target: v }))} />
            </>
          )}
        </div>
      </div>
      <div className="hd-learning-acts">
        {l.status === "saved" ? (
          <span className="hd-learning-saved">✓ {l.newRole ? `Saved as new role "${l.role}"` : `Saved to ${roleLabel(l.target)}`} · {where}</span>
        ) : edit !== null ? (
          <>
            <button className="btn small" onClick={() => setEdit(null)} disabled={busy}>Cancel</button>
            <button className="btn small ok" onClick={save} disabled={busy || !edit.trim()}>Save</button>
          </>
        ) : (
          <>
            <button className="btn small" onClick={() => setEdit(l.text)} disabled={busy}>Edit</button>
            <button className="btn small" onClick={() => act(api.discardLearning(slug, h.id, l.id))} disabled={busy}>Discard</button>
            <button className="btn small ok" onClick={save} disabled={busy}>Save</button>
          </>
        )}
      </div>
    </div>
  );
}

/** The message feed: system lines, messages with @mention chips, finding highlights. Sticks to the bottom while you're there. */
function Feed({ huddle: h, state, handles, scroller, onSeen }: {
  huddle: Huddle; state: HuddleState; handles: string[]; scroller: RefObject<HTMLDivElement>; onSeen: (seq: number) => void;
}) {
  const stick = useRef(true);
  const keep = useRef<number | null>(null);
  const sent = useRef(0);
  const [loading, setLoading] = useState(false);
  const byHandle = new Map(h.participants.map((p) => [p.handle, p]));
  const last = state.messages.at(-1)?.seq;

  // Viewing the latest message (at the bottom, in a visible window) counts as seeing what tagged you: "for you" clears.
  const seen = () => {
    if (h.status === "closed" || !(h.forYou ?? 0) || !last || last <= (h.forYouSince ?? 0) || last <= sent.current) return;
    if (!stick.current || document.visibilityState !== "visible") return;
    sent.current = last;
    onSeen(last);
  };
  useEffect(seen);
  useEffect(() => {
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keep.current !== null) {
      el.scrollTop = el.scrollHeight - keep.current;
      keep.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [last, state.messages.length]);

  const earlier = async () => {
    const el = scroller.current;
    setLoading(true);
    keep.current = el ? el.scrollHeight - el.scrollTop : null;
    try {
      await state.loadEarlier();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="huddle-log" ref={scroller} aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        seen();
      }}>
      {state.hasMore && <button className="btn ghost small load-earlier" onClick={earlier} disabled={loading}>{loading ? "Loading…" : "Load earlier"}</button>}
      {!state.messages.length && <div className="hd-sys">No messages yet.</div>}
      {state.messages.map((m) => (
        <Message key={m.seq} m={m} p={byHandle.get(m.from)} handles={handles} forYou={h.status !== "closed" && isForYou(m, h.forYouSince ?? 0)} />
      ))}
    </div>
  );
}

/** forYou: it tags the user since their last post, action or view of the latest message (highlighted, and a stop for "next for you"). */
function Message({ m, p, handles, forYou }: { m: HuddleMessage; p: HuddleParticipant | undefined; handles: string[]; forYou: boolean }) {
  if (m.kind === "system") {
    return <div className={`hd-sys${forYou ? " for-you" : ""}`} title={fullTime(m.ts)}><MentionText text={m.text} handles={handles} /></div>;
  }
  const mine = m.from === "you";
  return (
    <div className={`hd-msg${mine ? " mine" : ""}${forYou ? " for-you" : ""}`}>
      <Avatar handle={m.from} />
      <div className="hd-msg-body">
        <div className="hd-msg-head">
          <b>@{m.from}</b>
          {p && p.kind !== "human" && <span className="muted">{p.role}</span>}
          <time className="muted" dateTime={m.ts} title={[fullTime(m.ts), sourceLabel(m.source)].filter(Boolean).join(" · ")}>· {clock(m.ts)}</time>
          {p?.mode === "monitor" && p.kind !== "human" && <span className="hd-mode monitor">monitor</span>}
          {forYou && <span className="hd-for-you">· for you</span>}
        </div>
        {m.kind === "finding" ? (
          <div className="hd-finding"><span className="hd-finding-tag">⚠ Finding</span><Markdown text={m.text} handles={handles} /></div>
        ) : (
          <Markdown text={m.text} handles={handles} />
        )}
      </div>
    </div>
  );
}

/** Plain text with @mention chips (system lines). */
function MentionText({ text, handles }: { text: string; handles: string[] }) {
  const known = new Set(handles);
  const parts = text.split(/(@[a-z0-9][a-z0-9_-]*)/gi);
  return <>{parts.map((s, i) => {
    const h = s.slice(1).toLowerCase();
    return i % 2 && known.has(h) ? <span key={i} className={`at-chip${h === "you" ? " me" : ""}`}>{s}</span> : <Fragment key={i}>{s}</Fragment>;
  })}</>;
}

/** The user's message box, with @ autocomplete (@main, @all, handles). */
function Composer({ slug, ticket, huddle: h, onError, prefill, onPrefilled, onOpenOutput }: {
  slug: string; ticket: Ticket; huddle: Huddle; onError: (m: string) => void; prefill: { handle: string; n: number } | null;
  /** The prefill is applied: cleared, so a remount (the phone's Chat pane) doesn't apply it again. */
  onPrefilled: () => void;
  onOpenOutput: (name: string) => void;
}) {
  const [draft, setDraft] = usePersistentState(draftKey(slug, `${ticket.id}.huddle`), () => "", (v) => !v.trim(), (v) => typeof v === "string");
  const [sending, setSending] = useState(false);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closedPopup, setClosedPopup] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const closed = h.status === "closed";
  const q = mentionQuery(draft, caret);
  const options = q ? mentionCandidates(h).filter((c) => c.handle.startsWith(q.query)) : [];
  const open = !!q && options.length > 0 && !closedPopup;
  const tooLong = draft.trim().length > POST_MAX;
  const hint = tooLong ? `${draft.trim().length} / ${POST_MAX} characters: too long to post. Shorten it or split it.` : h.status === "live" ? untaggedHint(draft, h) : null;
  useEffect(() => setActive(0), [q?.query, q?.start]);
  // Message @handle (session viewer): the draft starts with the tag, and the box gets the focus.
  useEffect(() => {
    if (!prefill) return;
    const tag = `@${prefill.handle} `;
    const next = draft.startsWith(tag) ? draft : tag + draft.replace(/^\s+/, "");
    setDraft(next);
    onPrefilled();
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
      setCaret(next.length);
    });
  }, [prefill?.n]);

  const pick = (handle: string) => {
    if (!q) return;
    const next = `${draft.slice(0, q.start)}@${handle} ${draft.slice(caret)}`;
    const at = q.start + handle.length + 2;
    setDraft(next);
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(at, at);
      setCaret(at);
    });
  };
  const send = async () => {
    const text = draft.trim();
    if (!text || sending || closed || tooLong) return;
    setSending(true);
    try {
      await api.postHuddle(slug, h.id, text);
      setDraft("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(options[Math.min(active, options.length - 1)].handle);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setClosedPopup(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  if (closed) {
    return (
      <div className="huddle-closed muted small">
        This huddle is closed: the history stays, read-only.
        {h.summary && <> <button className="link-btn" onClick={() => onOpenOutput(h.summary!)} title={`Open ${h.summary} in Outputs`}>Read its summary</button></>}
      </div>
    );
  }
  return (
    <div className="composer huddle-composer">
      {open && (
        <div className="hd-pop" role="listbox" aria-label="Mention">
          {options.map((o, i) => (
            <div key={o.handle} role="option" aria-selected={i === active} className={i === active ? "on" : undefined}
              onMouseDown={(e) => { e.preventDefault(); pick(o.handle); }} onMouseEnter={() => setActive(i)}>
              <b>@{o.handle}</b> <span className="muted">· {o.label}</span>
            </div>
          ))}
        </div>
      )}
      <textarea ref={ref} rows={2} value={draft} disabled={sending}
        placeholder={h.status === "stopped" ? "The huddle is stopped: nobody wakes until you resume it…" : "Message the huddle: @main, @all or @handle to wake someone…"}
        onChange={(e) => { setDraft(e.target.value); setCaret(e.target.selectionStart); setClosedPopup(false); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onBlur={() => setClosedPopup(true)} onFocus={() => setClosedPopup(false)}
        onKeyDown={onKeyDown} aria-label="Message the huddle" />
      <div className="composer-foot">
        {hint ? (
          <span className="small composer-hint hd-untagged" role="status">{hint}</span>
        ) : (
          <span className="muted small composer-hint">
            You post as <b>@you</b>. Tagged participants wake; monitors read everything.
            <span className="composer-keys"> Enter to send · Shift+Enter for a new line</span>
          </span>
        )}
        <span className="composer-actions">
          <button className="btn primary small" disabled={!draft.trim() || sending || tooLong} onClick={send}>{sending ? "Sending…" : "Send"}<KeyHint keys="↵" /></button>
        </span>
      </div>
    </div>
  );
}

const MODE_OPTIONS = [
  { value: "tagged" as const, label: "tagged", hint: "wakes when @tagged" },
  { value: "monitor" as const, label: "monitor ($)", hint: "reads every message: costs more" },
];

/** The pinned brief: goal and decisions, at the head of every digest the agents get. The user, leads and @main edit it. */
function Brief({ slug, huddle: h, handles, onError }: { slug: string; huddle: Huddle; handles: string[]; onError: (m: string) => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const closed = h.status === "closed";
  useEffect(() => setEdit(null), [h.id]);
  if (closed && !h.brief) return null;
  const save = async () => {
    if (edit === null || busy) return;
    setBusy(true);
    try {
      await api.setHuddleBrief(slug, h.id, edit);
      setEdit(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="hd-brief">
      <h3>
        Brief
        {!closed && edit === null && <button className="link-btn hd-brief-edit" onClick={() => setEdit(h.brief?.text ?? "")}>{h.brief ? "Edit" : "+ Add"}</button>}
      </h3>
      {edit !== null ? (
        <>
          <textarea rows={6} value={edit} maxLength={BRIEF_MAX} disabled={busy} autoFocus aria-label="Pinned brief"
            placeholder="Goal, decisions so far, constraints. Every agent reads this first." onChange={(e) => setEdit(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEdit(null); } }} />
          <div className="hd-brief-actions">
            <span className="muted small">{edit.length}/{BRIEF_MAX}</span>
            <span className="spacer" />
            <button className="btn small" onClick={() => setEdit(null)} disabled={busy}>Cancel</button>
            <button className="btn small primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </>
      ) : h.brief ? (
        <div className="hd-brief-text" title={`Last changed by @${h.brief.by} · ${fullTime(h.brief.at)}`}>
          <Markdown text={h.brief.text} handles={handles} />
        </div>
      ) : (
        <div className="muted small">The goal and the decisions so far. It heads every digest the agents get.</div>
      )}
    </section>
  );
}

/** Participants: status (restart the failed and stopped), mode, what each spent; the cap counter. */
/** Clicking a participant opens its session beside the feed (onView); `viewing` is the one open. */
function Roster({ slug, huddle: h, onError, viewing, onView }: {
  slug: string; huddle: Huddle; onError: (m: string) => void; viewing: string | null; onView: (handle: string) => void;
}) {
  const closed = h.status === "closed";
  const ps = [...h.participants.filter((p) => p.kind !== "human"), ...h.participants.filter((p) => p.kind === "human")];
  const fail = (e: Error) => onError(e.message);
  const setMode = (p: HuddleParticipant, mode: HuddleMode) => p.mode !== mode && api.setHuddleMode(slug, h.id, p.handle, mode).catch(fail);
  return (
    <section>
      <h3>Participants <span className="hd-cap">{members(h).length}/{h.maxParticipants}</span></h3>
      {ps.map((p) => {
        const human = p.kind === "human";
        const st = ["working", "failed", "stopped", "done", "blocked"].includes(p.status) ? p.status : "idle";
        const restartable = !closed && !human && (p.status === "failed" || p.status === "stopped");
        // An agent mid-turn: its cost climbs with every step until the turn's result settles it.
        const climbing = p.kind === "agent" && p.status === "working" && !closed;
        const activity = human ? "human" : climbing ? `${p.lastActivity || "thinking…"} (cost rises while it works)` : participantActivity(p, closed);
        const big = (p.contextTokens ?? 0) >= BIG_CONTEXT_TOKENS;
        // Long statuses wrap to two lines; the tooltip has all of it.
        const detail = [...new Set([participantActivity(p, closed), p.error, p.statusReason, p.lastActivity].filter((x): x is string => !!x))].join("\n");
        return (
          <div key={p.handle} className={`hd-p${human ? "" : " viewable"}${viewing === p.handle ? " sel" : ""}`}>
            <Avatar handle={p.handle} small />
            <div className="hd-p-main">
              {!human && (
                <button className="hd-p-open" onClick={() => onView(p.handle)} aria-pressed={viewing === p.handle}
                  aria-label={`${viewing === p.handle ? "Close" : "Open"} @${p.handle}'s session`} title={`@${p.handle}'s session (read-only)`} />
              )}
              <div className="hd-p-name" title={p.role && p.role !== p.handle ? `@${p.handle} · ${p.role}` : `@${p.handle}`}>
                <b>@{p.handle}</b>
                {p.handle === "main" && <span className="pill lead">coordinator</span>}
                {p.lead && p.handle !== "main" && !human && <span className="pill lead">lead</span>}
              </div>
              <div className={`hd-p-st ${st}`}>
                {!human && <span className={`hd-dot ${st}`} />}
                <span className="hd-p-st-text" title={human ? undefined : detail}>{activity}</span>
                {restartable && (
                  <button className="link-btn hd-redo" title={h.status === "live" ? `Restart @${p.handle}: it wakes now with what it hasn't read` : `Restart @${p.handle} when the huddle resumes`}
                    onClick={() => api.restartHuddleParticipant(slug, h.id, p.handle).catch(fail)}>restart</button>
                )}
              </div>
            </div>
            {!human && (
              <span className="hd-p-actions">
                {closed ? (
                  <span className={`hd-mode ${p.mode}`}>{p.mode}</span>
                ) : (
                  <Select ariaLabel={`@${p.handle} mode`} className="roster-select hd-mode-select" value={p.mode} options={MODE_OPTIONS}
                    onChange={(v) => setMode(p, v)} />
                )}
                {!closed && p.status !== "stopped" && (
                  <button className="icon-btn tiny hd-p-stop" aria-label={`Stop @${p.handle}`} title={`Stop @${p.handle}`}
                    onClick={() => api.stopHuddleParticipant(slug, h.id, p.handle).catch(fail)}><CloseIcon size={10} /></button>
                )}
              </span>
            )}
            {!human && !!p.contextTokens && (
              <span className={`hd-ctx${big ? " big" : ""}`}
                title={`Conversation size Claude re-reads every step. Bigger = each step costs more.${big ? " This one is large." : ""}`}>
                {contextText(p.contextTokens)}
              </span>
            )}
            <span className="hd-p-cost" title={human ? undefined : `What @${p.handle} spent in this huddle${p.liveCostUsd
              ? `, with ≈${money(p.liveCostUsd)} for the turn it is in now. That part is a live estimate: every step re-reads the whole conversation, so it climbs while @${p.handle} works and settles when the turn ends`
              : ""}`}>
              {human ? "" : money((p.costUsd ?? 0) + (p.liveCostUsd ?? 0))}
            </span>
          </div>
        );
      })}
    </section>
  );
}

/** The pinned findings checklist; the user can pin and resolve too. */
function Findings({ slug, huddle: h, handles, onError }: { slug: string; huddle: Huddle; handles: string[]; onError: (m: string) => void }) {
  const [text, setText] = useState("");
  const closed = h.status === "closed";
  const by = [...new Set(h.findings.map((f) => f.by))];
  const open = h.findings.filter((f) => f.status === "open").length;
  const add = async () => {
    if (!text.trim()) return;
    try {
      await api.huddleFindings(slug, h.id, "add", { text: text.trim() });
      setText("");
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <section>
      <h3>Findings{h.findings.length > 0 && <span className="hd-cap">{open} open</span>}</h3>
      {by.length > 0 && <div className="hd-pinned muted small">pinned by {by.map((b) => `@${b}`).join(", ")}</div>}
      {!h.findings.length && <div className="muted small">Nothing pinned yet. Leads and @main pin what needs fixing here.</div>}
      {h.findings.map((f) => (
        <label key={f.id} className={`hd-chk${f.status === "resolved" ? " done" : ""}`} title={f.resolvedBy ? `resolved by @${f.resolvedBy}` : `pinned by @${f.by}`}>
          <input type="checkbox" checked={f.status === "resolved"} disabled={closed || f.status === "resolved"}
            onChange={() => api.huddleFindings(slug, h.id, "resolve", { id: f.id }).catch((e) => onError(e.message))} />
          <span><MentionText text={f.text} handles={handles} /></span>
        </label>
      ))}
      {!closed && (
        <input className="hd-add-finding" value={text} placeholder="Pin a finding…" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }} />
      )}
    </section>
  );
}

/** + Add agent: one roster line added to the live huddle. */
function AddAgent({ slug, huddle: h, preset = "qa", onDone, onError }: { slug: string; huddle: Huddle; preset?: string; onDone: () => void; onError: (m: string) => void }) {
  const presets = usePresets(slug);
  const [draft, setDraft] = useState<RosterDraft>(() => rosterDraft([{ preset }]));
  const [busy, setBusy] = useState(false);
  const room = h.maxParticipants - members(h).length;
  const size = draft.rows.reduce((n, r) => n + (r.count ?? 1), 0);
  const err = !draft.rows.length ? "Pick a role." : draft.rows.some((r) => !r.preset && !r.role?.trim()) ? "Name the custom role."
    : size > room ? `Room for ${room} more (max ${h.maxParticipants}).` : null;
  const add = async () => {
    if (busy || err) return;
    setBusy(true);
    try {
      for (const { key: _k, ...e } of draft.rows) await api.addHuddleParticipants(slug, h.id, { ...e, focus: e.focus?.trim() || undefined });
      onDone();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="huddle-add">
      <RosterEditor presets={presets} draft={draft} setDraft={setDraft} tickets={[]} hostId={h.hostTicket} max={DEFAULT_MAX} onEnter={add} disabled={busy} hideMain />
      <div className="huddle-card-actions">
        <span className="muted small">{err ?? (h.status === "live" ? "They start right away." : "They start when you resume the huddle.")}</span>
        <span className="spacer" />
        <button className="btn small" onClick={onDone}>Cancel</button>
        <button className="btn primary small" onClick={add} disabled={busy || !!err}>{busy ? "Adding…" : "Add"}</button>
      </div>
    </div>
  );
}
