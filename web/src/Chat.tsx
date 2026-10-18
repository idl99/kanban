import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  api, NotStarted, subscribe, type Huddle, type Level, type NewTicketDraft, type OutputFile, type QueuedMessage, type SessionEntry, type TeammateProposal, type Ticket,
} from "./api";
import { HuddleCard } from "./HuddleCard";
import { HuddleDigest } from "./HuddleDigest";
import { usePresets } from "./HuddleRoster";
import type { TeamRequest } from "./Team";
import { TeammateCard } from "./TeammateCard";
import { autoGrow } from "./autoGrow";
import { branchTicket } from "./branch";
import { BranchCard } from "./BranchCard";
import { DeleteCard } from "./DeleteCard";
import { AgentRows } from "./AgentRow";
import { ToolRows } from "./ToolRows";
import { ArrowDownIcon, BranchIcon, CloseIcon, FileCodeIcon, FileTextIcon } from "./icons";
import { useImagePaste } from "./imagePaste";
import { AttachmentChips } from "./AttachmentChips";
import { ImagePickButton } from "./ImagePickButton";
import { NewTicketsCard } from "./NewTicketsCard";
import { KeyHint } from "./KeyHint";
import { addOnFor, addOnState } from "./addOn";
import { ProposalCard, type AddOn } from "./ProposalCard";
import { QuestionsForm } from "./QuestionsForm";
import { RecoveryBanner } from "./RecoveryBanner";
import { SetupRow } from "./SetupRow";
import { HelpCardView, HelpPending, type HelpState } from "./HelpMenu";
import { useSimpler } from "./Simpler";
import { simplifiable } from "./simplifyText";
import { useSnippetPicker } from "./SnippetPicker";
import { useSlashCommands, useSlashPicker } from "./SlashPicker";
import { commandNote, messageCommand, type SlashCommand } from "./slashText";
import { filesByReply } from "./fileCards";

import { handoff as handoffOf, liveView, saved, type Handoff } from "./liveReply";
import { heldByReply, unsentNow, type Pending } from "./pendingBubbles";
import { baseName, copyFile, dirName, downloadFile } from "./share";
import { draftKey, formKey } from "./drafts";
import { fullTime, timeAgo } from "./time";
import { useNow } from "./useNow";
import { canStartFromProposal } from "./keynav";
import { toast } from "./toast";
import { Markdown } from "./Transcript";
import { usePersistentState } from "./usePersistentState";
import { usePhone } from "./usePhone";
import { enterSends } from "./enterSends";

/** File cards shown under one reply; the rest are in the Outputs tab. */
const MAX_FILE_CARDS = 8;

/** m:ss (h:mm:ss past an hour) since `iso`. */
function clock(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  const mm = String(Math.floor((s % 3600) / 60)), ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/** Claude ended its turn to wait for background tasks; the run stays open and it resumes when they finish. */
function WaitingCard({ tasks }: { tasks: NonNullable<Ticket["waitingOn"]> }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="waiting-card" aria-live="polite">
      <div className="waiting-title"><span className="spinner" /> Waiting for {tasks.length === 1 ? "1 background task" : `${tasks.length} background tasks`}</div>
      <ul>
        {tasks.map((t) => (
          <li key={t.id}><span>{t.description}</span><span className="waiting-time" title={`Started ${fullTime(t.startedAt)}`}>{clock(t.startedAt, now)}</span></li>
        ))}
      </ul>
      <div className="waiting-note">Claude continues automatically when they finish.</div>
    </div>
  );
}

/** A message the user sent: a slash command shows as a chip with what runs it, anything else as markdown. */
function UserText({ text, commands, command }: { text: string; commands: SlashCommand[] | null; command?: string }) {
  const c = command ? commands?.find((x) => x.name === command) ?? null : messageCommand(text, commands);
  if (!command && !c) return <Markdown text={text} />;
  const name = command ?? c!.name;
  const args = text.trim().slice(name.length + 1).trim();
  return (
    <>
      <div className="cmd-line"><span className="cmd-chip">/{name}</span>{args && <span className="cmd-args">{args}</span>}</div>
      <div className="cmd-note">{commandNote(c)}</div>
    </>
  );
}

/** tools: a run of tool calls folded into one line; agents: a run of subagent rows. */
type Block = { kind: "entry"; e: SessionEntry; index: number } | { kind: "tools"; items: SessionEntry[] } | { kind: "agents"; items: SessionEntry[] };

/** Copied history of a branched ticket: entries from before the branch point (at = the branch time). */
const before = (e: SessionEntry, at: string | undefined) => !!at && !!e.at && e.at < at;

/** Tool calls (and subagents) in a row fold into one block; a branch point (splitAt) starts a new one. */
function group(entries: SessionEntry[], splitAt?: string): Block[] {
  const out: Block[] = [];
  entries.forEach((e, index) => {
    const prev = out.at(-1);
    if (e.kind === "tool" || e.kind === "agent") {
      const kind: "tools" | "agents" = e.kind === "tool" ? "tools" : "agents";
      if (prev?.kind === kind && before(prev.items[0], splitAt) === before(e, splitAt)) prev.items.push(e);
      else out.push({ kind, items: [e] });
    } else out.push({ kind: "entry", e, index });
  });
  return out;
}

const HANDOFF_RETRY_MS = 500;
const HANDOFF_MAX_MS = 5000;

const UNREADABLE = { questions: "questions", proposal: "ticket proposal", tickets: "proposed tickets" } as const;

/** What the Resend button sends: the same content again, through the matching tool. */
const RESEND = {
  questions: "The board couldn't read your questions. Please resend them with the ask_questions tool.",
  proposal: "The board couldn't read your ticket proposal. Please resend it with the propose_ticket tool.",
  tickets: "The board couldn't read your proposed tickets. Please resend them with the propose_tickets tool.",
} as const;

const REFINE = (s: Ticket["status"]) => s === "backlog" || s === "planning";

function kb(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Image links reach the session as local file paths, so compare by file name.
const norm = (s: string) => s.trim().replace(/\S*\/attachments\/([0-9a-f]{32}\.\w+)/g, "$1");
/** Whether a message the user sent is in the session file yet. */
const delivered = (entries: SessionEntry[], text: string) => entries.some((e) => e.role === "user" && norm(e.text) === norm(text));

/**
 * The ticket's single conversation with Claude, like the terminal: everything in the session
 * (terminal chat, board runs, messages typed here) in one timeline, plus a box to send more.
 */
/** Stop Claude with instant feedback: "Stopping…" from the click until the run is gone. */
export function useStop(slug: string, ticket: Ticket, working: boolean, onError: (m: string) => void) {
  const [clicked, setClicked] = useState(false);
  useEffect(() => {
    if (!working) setClicked(false);
  }, [working]);
  const stopping = working && (clicked || ticket.lastActivity === "Stopping…");
  const stop = () => {
    setClicked(true);
    api.stop(slug, ticket.id).catch((e) => {
      setClicked(false);
      onError(e.message);
    });
  };
  return { stopping, stop };
}

/** A queued peer message that carries huddle messages (see the server's huddleMainPrompt). */
const HUDDLE_TAG = /<ckanban-context[^>]* huddle="/;

export function Chat({ slug, ticket, tickets, onOpenTicket, onOpenOutput, onError, onPendingProposal, huddle = null, onOpenHuddle, onOpenTeam, help }: {
  slug: string;
  ticket: Ticket;
  /** The board's tickets, to tell which proposed new tickets already exist. */
  tickets: Ticket[];
  onOpenTicket: (id: string) => void;
  /** Show a file of the ticket's outputs folder (path relative to it) in the Outputs tab. */
  onOpenOutput?: (name: string) => void;
  onError: (m: string) => void;
  /** The newest proposal card not applied yet, as its Apply action (null when none): ⌘⇧Enter in the panel applies it. */
  /** The newest unapplied proposal's apply; start: also move the ticket to Ready. */
  onPendingProposal?: (apply: ((start: boolean) => Promise<void>) | null) => void;
  /** The ticket's huddle, to tell whether a proposed one was started. */
  huddle?: Huddle | null;
  onOpenHuddle?: () => void;
  /** Open the dock's Team tab: a proposed teammate's editor (Edit first) or a saved one (Open in Team). */
  onOpenTeam?: (r: TeamRequest) => void;
  /** "Help me understand" answers, shown as cards in the timeline by time. */
  help?: HelpState;
}) {
  const [page, setPage] = useState<{ entries: SessionEntry[]; start: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Scrolled up: offer a jump back down; "fresh" = something new arrived meanwhile.
  const [jump, setJump] = useState<{ fresh: boolean } | null>(null);
  const [showWarnDetails, setShowWarnDetails] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const phone = usePhone();
  useNow();
  // Sent messages not yet in the session file (the server's queue covers ones Claude hasn't read).
  // steer: sent while Claude was working, so it waits for the server queue instead of joining the timeline.
  const [pending, setPending] = useState<Pending[]>([]);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const queued = ticket.queued ?? [];
  // Unsent text survives closing the drawer, switching tickets and reloads.
  const [draft, setDraft] = usePersistentState(draftKey(slug, ticket.id), () => "", (v) => !v.trim(), (v) => typeof v === "string");
  const images = useImagePaste(setDraft);
  const snippets = useSnippetPicker({ slug, ref: composer, setValue: setDraft });
  const commands = useSlashCommands(slug, ticket.id);
  const simpler = useSimpler(slug, ticket.id);
  const slash = useSlashPicker({ commands, ref: composer, setValue: setDraft });
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Text Claude is writing right now (from the run's partial-message stream); not yet in the session file.
  const [live, setLive] = useState("");
  // Replies that finished streaming but aren't in the loaded conversation yet.
  const [handoff, setHandoff] = useState<Handoff[]>([]);
  const entriesRef = useRef<SessionEntry[]>([]);
  // loadTail calls overlap (draft, activity, session watcher): a slower, older response must not win.
  const tailSeq = useRef(0);
  const tailApplied = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const keepOffset = useRef<number | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = !!ticket.running;
  const { stopping, stop } = useStop(slug, ticket, running, onError);
  const refine = REFINE(ticket.status);

  // Resolves to the loaded tail (null when a newer load won or there is no session).
  const loadTail = useCallback(async (): Promise<SessionEntry[] | null> => {
    if (!ticket.sessionId) {
      setPage({ entries: [], start: 0 });
      return null;
    }
    const seq = ++tailSeq.current;
    const r = await api.conversation(slug, ticket.id);
    if (seq < tailApplied.current) return null;
    tailApplied.current = seq;
    setPage((prev) => {
      if (!prev || r.start <= prev.start) return { entries: r.entries, start: r.start };
      const idx = prev.entries.findIndex((e) => e.uuid === r.entries[0]?.uuid);
      return idx >= 0 ? { entries: [...prev.entries.slice(0, idx), ...r.entries], start: prev.start } : { entries: r.entries, start: r.start };
    });
    return r.entries;
  }, [slug, ticket.id, ticket.sessionId]);

  const reload = useCallback(() => {
    setLoadError(null);
    loadTail().catch((e) => {
      setLoadError(e.message);
      setPage((p) => p ?? { entries: [], start: 0 });
    });
  }, [loadTail]);
  useEffect(() => {
    setPage(null);
    setHandoff([]);
    reload();
  }, [reload]);
  useLayoutEffect(() => autoGrow(composer.current), [draft, phone]);

  // Live updates: session file changes (terminal) and run activity (board) both refresh the tail.
  useEffect(() => subscribe((e) => {
    if (e.type === "draft" && e.profile === slug && e.id === ticket.id) {
      if (e.text) setLive(e.text);
      else if (e.final) {
        // Message finished: show all of it until the saved copy is loaded, then swap without a gap.
        const h = handoffOf(e.final, entriesRef.current.length);
        setHandoff((hs) => [...hs, h]);
        setLive("");
        loadTail().catch(() => {});
      } else loadTail().catch(() => {}).finally(() => setLive(""));
      return;
    }
    const mine = (e.type === "session.updated" || e.type === "activity") && e.profile === slug && e.id === ticket.id;
    if (!mine || refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      loadTail().catch(() => {});
    }, 700);
  }), [slug, ticket.id, loadTail]);

  // A run just finished: pick up the final message even if no more events arrive. A reply's own message that never
  // reached the session (Stop before Claude read it) can't arrive any more: drop its bubble so it doesn't stick below
  // later messages. Messages sent after this point are left alone.
  useEffect(() => {
    if (running) return;
    const before = pendingRef.current.filter((p) => !p.steer);
    loadTail()
      .then((tail) => {
        if (!tail) return;
        const stale = before.filter((p) => !delivered(tail, p.text));
        if (stale.length) setPending((ps) => ps.filter((p) => !stale.includes(p)));
      })
      .catch(() => {})
      .finally(() => setLive(""));
  }, [running]);

  // A message Claude hasn't received yet (not sent after Stop, or waiting for a slot or a restart): the user can
  // still edit or discard it. With Claude running it was handed over at once.
  const editable = (q: QueuedMessage) => q.state === "unsent" || (!q.peer && !running);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const discarded = useRef(new Set<string>());
  const cancelEdit = () => {
    setEditing(null);
    composer.current?.focus();
  };
  const saveEdit = async () => {
    if (!editing?.text.trim()) return;
    try {
      await api.editQueued(slug, ticket.id, editing.id, editing.text.trim());
      cancelEdit();
    } catch (e: any) {
      onError(e.message);
    }
  };
  const discard = (msgId: string) => {
    discarded.current.add(msgId);
    api.discardQueued(slug, ticket.id, msgId).catch((e) => {
      discarded.current.delete(msgId);
      onError(e.message);
    });
  };

  // Claude read a queued message: keep its bubble until the session file shows it, so it doesn't blink out.
  const prevQueued = useRef(queued);
  useEffect(() => {
    // Peer messages show up in the session as another ticket's message, not as the user's bubble.
    const read = prevQueued.current.filter((q) => q.state === "queued" && !q.peer && !discarded.current.has(q.id) && !queued.some((n) => n.id === q.id)).map((q) => q.text);
    prevQueued.current = queued;
    // The reply's own message already has its plain bubble.
    if (read.length) setPending((ps) => [...ps, ...read.filter((text) => !ps.some((p) => !p.steer && p.text === text)).map((text) => ({ text, steer: false }))]);
    const unsent = unsentNow(pendingRef.current, queued);
    if (unsent.length) setPending((ps) => ps.filter((p) => !unsent.includes(p)));
  }, [ticket.queued]);

  const entries = page?.entries ?? [];
  entriesRef.current = entries;
  // Finished replies still waiting for their saved copy; filtered here so both never show at once.
  const waitingHandoff = useMemo(() => handoff.filter((h) => !saved(entries, h)), [handoff, entries]);
  useEffect(() => {
    if (waitingHandoff.length !== handoff.length) setHandoff(waitingHandoff);
  }, [waitingHandoff, handoff]);
  // The saved copy can lag the stream (transcript written after stdout): poll briefly, then give up.
  const handingOff = handoff.length > 0;
  useEffect(() => {
    if (!handingOff) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setHandoff((hs) => (hs.some((h) => now - h.at >= HANDOFF_MAX_MS) ? hs.filter((h) => now - h.at < HANDOFF_MAX_MS) : hs));
      loadTail().catch(() => {});
    }, HANDOFF_RETRY_MS);
    return () => clearInterval(timer);
  }, [handingOff, loadTail]);
  // Output files for the cards under replies; refreshed whenever the conversation is.
  const [files, setFiles] = useState<OutputFile[]>([]);
  useEffect(() => {
    if (page) api.outputs(slug, ticket.id).then(setFiles).catch(() => {});
  }, [slug, ticket.id, page, running]);
  const cards = useMemo(() => filesByReply(entries, files), [entries, files]);
  // Drop optimistic bubbles once the session file contains the message.
  useEffect(() => {
    if (pending.some((p) => delivered(entries, p.text))) setPending((ps) => ps.filter((p) => !delivered(entries, p.text)));
  }, [entries, pending]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keepOffset.current !== null) {
      el.scrollTop = el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    } else if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    else setJump((j) => (j ? { fresh: true } : j));
  }, [page, pending, running, live, waitingHandoff, help?.cards.length, help?.failed]);
  // Asking for help scrolls down to where its card appears.
  const helpBusy = help?.busy.length ?? 0;
  const helpBusyBefore = useRef(helpBusy);
  useEffect(() => {
    if (helpBusy > helpBusyBefore.current) toBottom();
    helpBusyBefore.current = helpBusy;
  }, [helpBusy]);

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setJump(null);
  };

  const send = async (text: string) => {
    // A command goes as `/name args`, the way the server queues it and the session shows it.
    const t = messageCommand(text, commands) ? text.trim().replace(/^(\S+)\s+/, "$1 ") : text.trim();
    if (!t || stopping || images.uploading) return;
    images.clearError();
    stickToBottom.current = true;
    const steer = running;
    setPending((ps) => [...ps, { text: t, steer }]);
    setDraft("");
    try {
      const r = await api.chat(slug, ticket.id, t);
      // Steering or waiting for a slot: the server queue now shows it. A reply it started keeps its plain bubble while the
      // board holds it until Claude reads it. /clear and /model: the board ran them, nothing reaches the session.
      if ((r.queued?.some((q) => q.text === t) && (steer || !r.running)) || messageCommand(t, commands)?.source === "board") setPending((ps) => ps.filter((p) => p.text !== t));
    } catch (e: any) {
      setPending((ps) => ps.filter((p) => p.text !== t));
      setDraft(t);
      onError(e.message);
    }
  };

  const loadEarlier = async () => {
    if (!page || page.start === 0) return;
    setLoadingEarlier(true);
    try {
      const r = await api.conversation(slug, ticket.id, page.start);
      keepOffset.current = scroller.current ? scroller.current.scrollHeight - scroller.current.scrollTop : null;
      setPage((prev) => ({ entries: [...r.entries, ...(prev?.entries ?? [])], start: r.start }));
    } finally {
      setLoadingEarlier(false);
    }
  };

  // A reply still on its way to the session file counts too, so the form doesn't offer "Send answers" again.
  const replying = pending.some((p) => !p.steer);
  const answeredAfter = (index: number) => replying || entries.slice(index + 1).some((e) => e.role === "user" && e.kind === "text" && !e.peer);
  const isApplied = (p: { title: string; description: string; important?: true }) =>
    (!p.title || p.title === ticket.title) && (!p.description || p.description.trim() === ticket.body.trim()) && (!p.important || !!ticket.important);

  const empty = page !== null && !loadError && entries.length === 0 && !pending.length && !queued.length && !running;

  const childFor = (d: { title: string }) => tickets.find((t) => t.parentId === ticket.id && t.title === d.title);
  const createChild = async (d: NewTicketDraft) => {
    try {
      return await api.createTicket(slug, {
        title: d.title, body: d.description, status: "backlog", mode: "interview", parentId: ticket.id,
        ...(d.key ? { planKey: d.key } : {}), ...(d.dependsOn?.length ? { dependsOn: d.dependsOn } : {}),
        ...(d.needs?.length ? { needs: d.needs } : {}), ...(d.tags?.length ? { tags: d.tags } : {}), ...(d.important ? { important: true } : {}),
      });
    } catch (err: any) {
      onError(err.message);
      return null;
    }
  };

  // Proposals applied with "Apply & start work" here, so their card says the ticket moved on.
  const [startedProposals, setStartedProposals] = useState<ReadonlySet<string>>(new Set());
  const canStart = canStartFromProposal({ status: ticket.status, working: ticket.status === "in_progress" || running });
  const applyProposal = async (p: { title: string; description: string; important?: true }, start?: { uuid: string }) => {
    const before = { title: ticket.title, body: ticket.body, important: !!ticket.important };
    try {
      // One update, so the ticket never sits in Ready with the old text.
      await api.updateTicket(slug, ticket.id, {
        ...(p.title ? { title: p.title } : {}),
        ...(p.description ? { body: p.description } : {}),
        ...(p.important ? { important: true } : {}),
        ...(start ? { status: "ready" as const } : {}),
      });
      // No Undo once it starts: Claude may already be working from the new text.
      if (start) {
        setStartedProposals((s) => new Set(s).add(start.uuid));
        return void toast("Applied to the ticket and moved to Ready", { tone: "ok" });
      }
      toast("Applied to the ticket", {
        tone: "ok",
        action: {
          label: "Undo",
          run: () => api.updateTicket(slug, ticket.id, before).catch((err) => toast(`Undo failed: ${err.message}`, { tone: "error" })),
        },
      });
    } catch (err: any) {
      // Start was cancelled (a huddle works on the ticket): still apply the text, without starting.
      if (start && err instanceof NotStarted) return applyProposal(p);
      onError(err.message);
    }
  };

  // Teammate cards: the board's teammates tell a new one from a change; reloaded after each save.
  const [presetsVersion, setPresetsVersion] = useState(0);
  const presets = usePresets(slug, presetsVersion);
  const saveTeammate = async (uuid: string, p: TeammateProposal, scope: Level) => {
    try {
      const { why: _w, ...fields } = p;
      const saved = await api.saveHuddlePreset(slug, fields, scope);
      await api.answerTeammateCard(slug, ticket.id, uuid, { state: "saved", name: saved.name, scope });
      setPresetsVersion((n) => n + 1);
    } catch (err: any) {
      onError(err.message);
    }
  };
  const dismissTeammate = (uuid: string) => api.answerTeammateCard(slug, ticket.id, uuid, { state: "dismissed" }).then(() => {}, (err) => onError(err.message));

  // A ticket that already ran: proposals become linked add-on tickets, so this one keeps its title and description.
  const onState = addOnState(ticket);
  const createAddOn = async (p: { title: string; description: string; important?: true }, start: boolean) => {
    try {
      const f = await api.addOnTicket(slug, ticket.id, { title: p.title, body: p.description, start, ...(p.important ? { important: true } : {}) });
      toast(start ? "Add-on ticket created and moved to Ready" : "Add-on ticket created in Backlog", {
        tone: "ok", action: { label: "Open", run: () => onOpenTicket(f.id) },
      });
    } catch (err: any) {
      onError(err.message);
    }
  };
  const addOnOf = (p: { title: string; description: string; important?: true }): AddOn | undefined => onState === undefined ? undefined : {
    state: onState, created: addOnFor(tickets, ticket.id, p.title), onCreate: (start) => createAddOn(p, start), onOpen: onOpenTicket,
  };

  const pendingProposal = entries.findLast((e) => e.proposal && !isApplied(e.proposal) && !(onState !== undefined && addOnFor(tickets, ticket.id, e.proposal.title)));
  const applyPendingRef = useRef((_start: boolean) => Promise.resolve());
  applyPendingRef.current = (start) => (!pendingProposal?.proposal ? Promise.resolve()
    // ⌘⇧Enter on an add-on card: create it and start work.
    : onState !== undefined ? createAddOn(pendingProposal.proposal, true)
    : applyProposal(pendingProposal.proposal, start && canStart ? { uuid: pendingProposal.uuid } : undefined));
  useEffect(() => {
    onPendingProposal?.(pendingProposal ? (start) => applyPendingRef.current(start) : null);
  }, [pendingProposal?.uuid]);
  useEffect(() => () => onPendingProposal?.(null), []);

  /** One block of the conversation; old = copied history of a branched ticket (shown dimmed). */
  const renderBlock = (b: Block, old: boolean) => {
    const el = renderEntry(b, old);
    if (b.kind !== "entry" || !b.e.setup) return el;
    // The setup Claude asked for (`ckanban ticket setup`): just the row.
    if (b.e.kind === "board" && !b.e.text) return <SetupRow key={b.e.uuid} setup={b.e.setup} old={old} />;
    return <Fragment key={b.e.uuid}><SetupRow setup={b.e.setup} old={old} />{el}</Fragment>;
  };
  const renderEntry = (b: Block, old: boolean) => {
          if (b.kind === "agents") return <AgentRows key={b.items[0].uuid} slug={slug} ticketId={ticket.id} items={b.items} old={old} />;
          if (b.kind === "tools") {
            return (
              <details key={b.items[0].uuid} className={`conv-tools${old ? " inherited" : ""}`}>
                <summary>{b.items.length === 1 ? b.items[0].text : `${b.items.length} tool calls · ${b.items.at(-1)!.text}`}</summary>
                <ToolRows slug={slug} ticketId={ticket.id} live={running && !old}
                  items={b.items.map((t) => ({ key: t.uuid, label: t.text, toolUseId: t.toolUseId, error: t.error }))} />
              </details>
            );
          }
          const e = b.e;
          if (e.kind === "board") {
            return <div key={e.uuid} className={`chat-note${old ? " inherited" : ""}`}>{e.text}{e.at && <span title={fullTime(e.at)}> · {timeAgo(e.at)}</span>}</div>;
          }
          if (e.huddleId) {
            return (
              <HuddleDigest key={e.uuid} text={e.text} old={old} onOpen={onOpenHuddle}
                meta={e.at && <time className="muted small" dateTime={e.at} title={fullTime(e.at)}>{timeAgo(e.at)}</time>} />
            );
          }
          return (
            <div key={e.uuid} className={`conv-msg ${e.role}${e.commandOutput ? " command-output" : ""}${old ? " inherited" : ""}`}>
              <div className="conv-head">
                <b>{e.role === "user" ? "You" : e.commandOutput ? "Claude Code" : "Claude"}</b>
                {e.at && <time className="muted small" dateTime={e.at} title={fullTime(e.at)}>{timeAgo(e.at)}</time>}
              </div>
              {e.text && (e.role === "user"
                ? <UserText text={e.text} commands={commands} command={e.command} />
                : <Markdown text={simpler.textFor(e.uuid) ?? e.text.replace(/^.*CKANBAN_RESULT:.*$/m, "").trim()} />)}
              {simplifiable(e) && simpler.link(e.uuid)}
              {e.questions && (
                <QuestionsForm questions={e.questions} answered={answeredAfter(b.index)} disabled={running} onSubmit={send}
                  onPreview={onOpenOutput && ((m) => onOpenOutput(`mockups/${m}`))}
                  storageKey={formKey(slug, ticket.id, e.uuid)} />
              )}
              {e.proposal && (
                <ProposalCard proposal={e.proposal} applied={isApplied(e.proposal)} started={startedProposals.has(e.uuid)}
                  onApply={() => applyProposal(e.proposal!)}
                  onApplyStart={canStart ? () => applyProposal(e.proposal!, { uuid: e.uuid }) : undefined}
                  keyHint={e === pendingProposal} addOn={addOnOf(e.proposal)} />
              )}
              {e.newTickets && (
                <NewTicketsCard drafts={e.newTickets} created={childFor} onCreate={createChild} onOpen={onOpenTicket} />
              )}
              {e.branch && (
                <BranchCard reason={e.branch.reason} here={old} running={running} onOpen={onOpenTicket}
                  branch={tickets.find((t) => t.branchedFrom === ticket.id && !!t.branchPoint && t.branchPoint.at > e.at)}
                  onBranch={() => branchTicket(slug, ticket, onOpenTicket).then(() => {}, (err) => onError(err.message))} />
              )}
              {e.deletion && (
                <DeleteCard slug={slug} ticket={ticket} tickets={tickets} uuid={e.uuid} ids={e.deletion.ids} reason={e.deletion.reason} onError={onError} />
              )}
              {e.teammate && (
                <TeammateCard proposal={e.teammate} presets={presets} answered={ticket.teammateCards?.[e.uuid]}
                  onSave={(scope) => saveTeammate(e.uuid, e.teammate!, scope)}
                  onEdit={onOpenTeam && ((scope, draft, isNew) => onOpenTeam({ action: "edit", draft, isNew, scope, card: { ticketId: ticket.id, uuid: e.uuid } }))}
                  onDismiss={() => dismissTeammate(e.uuid)}
                  onOpenTeam={onOpenTeam && ((name) => onOpenTeam({ action: "open", name }))} />
              )}
              {e.huddle && (
                <HuddleCard slug={slug} ticket={ticket} tickets={tickets} uuid={e.uuid} at={e.at} roster={e.huddle.roster} reason={e.huddle.reason} template={e.huddle.template} maxCostUsd={e.huddle.maxCostUsd}
                  huddle={huddle} old={old} onOpen={() => onOpenHuddle?.()} onError={onError} />
              )}
              {e.mockups && (
                <div className="chat-mockups">
                  {e.mockups.map((m) => (
                    <button key={m} className="chat-mockup" onClick={() => onOpenOutput?.(`mockups/${m}`)} title="Preview in the Outputs tab">
                      <FileCodeIcon size={13} /> Mockup <b>{m}</b>
                    </button>
                  ))}
                </div>
              )}
              {e.role === "assistant" && cards.get(e.uuid)?.slice(0, MAX_FILE_CARDS).map((f) => (
                <div key={f.name} className="chat-file">
                  <FileTextIcon size={14} />
                  <b title={f.name}>{dirName(f.name) && <span className="chat-file-dir">{dirName(f.name)}</span>}{baseName(f.name)}</b>
                  <span className="muted small">{kb(f.size)}</span>
                  <span className="chat-file-actions">
                    <button className="btn small view" onClick={() => onOpenOutput?.(f.name)}>View</button>
                    {ticket.canCopyFile && <button className="btn small" onClick={() => copyFile(slug, ticket.id, f.name)}>Copy file</button>}
                    <button className="btn small" onClick={() => downloadFile(slug, ticket.id, f.name)}>Download</button>
                  </span>
                </div>
              ))}
              {e.role === "assistant" && (cards.get(e.uuid)?.length ?? 0) > MAX_FILE_CARDS && (
                <button className="link-btn small" onClick={() => onOpenOutput?.(cards.get(e.uuid)![MAX_FILE_CARDS].name)}>
                  +{cards.get(e.uuid)!.length - MAX_FILE_CARDS} more files in the Outputs tab
                </button>
              )}
              {e.unreadable && (
                <div className="chat-unreadable" role="status">
                  <span>Couldn't read Claude's {UNREADABLE[e.unreadable]}.</span>
                  {!answeredAfter(b.index) && (
                    <button className="btn small" disabled={running} onClick={() => send(RESEND[e.unreadable!])}>Resend</button>
                  )}
                </div>
              )}
              {e.moved === "planning" && (
                <div className="chat-moved">
                  Moved to <b>Planning</b>: this was a planning request, so nothing was changed. Answer or refine here, then
                  drag the card to In Progress when you want Claude to do it.
                </div>
              )}
            </div>
          );
  };

  // A branched ticket: a divider marks where the copied conversation ends.
  const bp = ticket.branchPoint ?? undefined;
  const branchedFrom = ticket.branchedFrom ? tickets.find((t) => t.id === ticket.branchedFrom) : undefined;
  const blocks = group(entries, bp?.at);
  // Divider before the first block after the branch point (after all of them while nothing new was said yet).
  const firstNew = bp ? blocks.findIndex((b) => !before(b.kind === "entry" ? b.e : b.items[0], bp.at)) : -1;
  const dividerAt = !bp || page === null || page.start > 0 && firstNew === 0 ? -1 : firstNew < 0 ? blocks.length : firstNew;
  // Help cards go before the first block that came after them (after them all when nothing did); older ones than the
  // loaded page wait for "Load earlier".
  const helpAt = new Map<number, HelpState["cards"]>();
  for (const c of help?.cards ?? []) {
    if (page && page.start > 0 && entries.length && c.at < entries[0].at) continue;
    let i = blocks.findIndex((b) => (b.kind === "entry" ? b.e : b.items[0]).at > c.at);
    if (i < 0) i = blocks.length;
    helpAt.set(i, [...(helpAt.get(i) ?? []), c]);
  }
  const divider = bp && (
    <div key={`branch-${bp.at}`} className="branch-divider" role="separator">
      <BranchIcon size={12} /> branched from {branchedFrom
        ? <button className="link-btn" onClick={() => onOpenTicket(branchedFrom.id)}>{branchedFrom.title}</button>
        : bp.sourceTitle} · <time dateTime={bp.at} title={fullTime(bp.at)}>{new Date(bp.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</time>
    </div>
  );

  return (
    <div className="chat">
      <div className="chat-log" ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          stickToBottom.current = gap < 60;
          if (gap < 60) setJump(null);
          else if (gap > 240) setJump((j) => j ?? { fresh: false });
        }}>
        {page === null && <div className="muted"><span className="spinner" /> Loading the conversation…</div>}
        {loadError && (
          <div className="banner error inline load-error" role="alert">
            Couldn't load the conversation: {loadError}{" "}
            <button className="link-btn" onClick={reload}>Retry</button>
          </div>
        )}
        {page && page.start > 0 && (
          <button className="btn ghost small load-earlier" onClick={loadEarlier} disabled={loadingEarlier}>
            {loadingEarlier ? "Loading…" : `Load earlier (${page.start} more)`}
          </button>
        )}
        {empty && (
          <div className="chat-empty">
            {ticket.status === "backlog" ? (
              <>
                <p><b>Parked.</b> Move it to Planning when you want Claude to help shape it: it will ask a few questions, then propose a clear title and description.</p>
                <button className="btn" onClick={() => api.updateTicket(slug, ticket.id, { status: "planning" }).catch((e) => onError(e.message))}>
                  Move to Planning
                </button>
              </>
            ) : ticket.status === "planning" ? (
              <>
                {/* Only shown if the automatic start didn't happen (e.g. session was open in a terminal). */}
                <p><b>Shape this ticket with Claude.</b> Describe your idea below, or let Claude start the interview.</p>
                <button className="btn" onClick={() => send("Help me refine this ticket. Interview me about what's unclear, then propose an improved title and description.")}>
                  Start the interview
                </button>
              </>
            ) : (
              <p className="muted">No conversation yet. Move the card to In Progress to let Claude work on it, or send a message.</p>
            )}
          </div>
        )}
        {blocks.map((b, i) => {
          const first = b.kind === "entry" ? b.e : b.items[0];
          return (
            <Fragment key={first.uuid}>
              {helpAt.get(i)?.map((c) => <HelpCardView key={c.id} card={c} help={help} onOpenTicket={onOpenTicket} />)}
              {i === dividerAt && divider}{renderBlock(b, before(first, bp?.at))}
            </Fragment>
          );
        })}
        {dividerAt === blocks.length && divider}
        {helpAt.get(blocks.length)?.map((c) => <HelpCardView key={c.id} card={c} help={help} onOpenTicket={onOpenTicket} />)}
        {help && <HelpPending help={help} />}
        {/* Replies sent while Claude wasn't working are part of the timeline: plain bubbles, before Claude's reply. */}
        {pending.filter((p) => !p.steer).map((p, i) => (
          <div key={i} className="conv-msg user">
            <UserText text={p.text} commands={commands} />
          </div>
        ))}
        {ticket.interrupted?.partial && (
          <div className="conv-msg assistant interrupted">
            <div className="conv-head"><b>Claude</b><span className="muted small">interrupted by a board restart; {running ? "continuing below…" : "resumes when the board is back"}</span></div>
            <Markdown text={ticket.interrupted.partial} />
          </div>
        )}
        {waitingHandoff.map((h) => (
          <div key={h.at} className="conv-msg assistant live">
            <div className="conv-head"><b>Claude</b></div>
            {liveView(h.text).text && <Markdown text={liveView(h.text).text} />}
            {liveView(h.text).preparing && <div className="chat-typing"><span className="spinner" /> {liveView(h.text).preparing}</div>}
          </div>
        ))}
        {live && (
          <div className="conv-msg assistant live" aria-live="polite">
            <div className="conv-head"><b>Claude</b><span className="muted small">writing…</span></div>
            {liveView(live).text && <Markdown text={liveView(live).text} />}
            {liveView(live).preparing && <div className="chat-typing"><span className="spinner" /> {liveView(live).preparing}</div>}
          </div>
        )}
        {running && !live && !!ticket.waitingOn?.length && <WaitingCard tasks={ticket.waitingOn} />}
        {running && !live && !ticket.waitingOn?.length && (
          <div className="chat-typing"><span className="spinner" /> {ticket.lastActivity && ticket.lastActivity !== "Starting…" ? ticket.lastActivity : "Claude is working…"}</div>
        )}
        {pending.filter((p) => p.steer && !queued.some((q) => q.text === p.text)).map((p, i) => (
          <div key={i} className="conv-msg user pending">
            <div className="conv-head"><b>You</b><span className="muted small">sending…</span></div>
            <UserText text={p.text} commands={commands} />
          </div>
        ))}
        {queued.filter((q) => q.peer && HUDDLE_TAG.test(q.text)).map((q) => (
          <HuddleDigest key={q.id} text={q.text.split("<ckanban-context")[0].trim()} pending onOpen={onOpenHuddle}
            meta={<span className="muted small">{q.state === "queued" ? "queued · Claude reads this at its next step" : "not sent · Claude was stopped before reading it"}</span>}>
            {q.state === "unsent" && (
              <div className="queued-actions">
                <button className="btn primary small" disabled={stopping}
                  onClick={() => api.sendQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Send</button>
                <button className="btn ghost small"
                  onClick={() => api.discardQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Discard</button>
              </div>
            )}
          </HuddleDigest>
        ))}
        {queued.filter((q) => q.peer && !HUDDLE_TAG.test(q.text)).map((q) => (
          <div key={q.id} className="conv-msg peer in pending">
            <div className="conv-head">
              <b>From the board</b>
              <span className="muted small">{q.state === "queued" ? "queued · Claude reads this at its next step" : "not sent · Claude was stopped before reading it"}</span>
            </div>
            <Markdown text={q.text.split("<ckanban-context")[0].trim()} />
            {q.state === "unsent" && (
              <div className="queued-actions">
                <button className="btn primary small" disabled={stopping}
                  onClick={() => api.sendQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Send</button>
                <button className="btn ghost small"
                  onClick={() => api.discardQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Discard</button>
              </div>
            )}
          </div>
        ))}
        {queued.filter((q) => !q.peer && !heldByReply(q, pending)).map((q) => (
          <div key={q.id} className={`conv-msg user pending${editable(q) ? " unsent" : ""}${editing?.id === q.id && editable(q) ? " editing" : ""}`}>
            <div className="conv-head">
              <b>You</b>
              <span className="muted small">{q.state === "unsent" ? "not sent · Claude was stopped before reading it"
                : running ? (q.slash ? "queued · runs after Claude's current turn" : "sent · Claude reads it at its next step")
                : ticket.slotWait ? "queued · starts when a run slot is free" : "queued · starts when the board is back"}</span>
            </div>
            {editing?.id === q.id && editable(q) ? (
              <>
                <textarea className="queued-edit" rows={3} autoFocus value={editing.text}
                  onChange={(e) => setEditing({ id: q.id, text: e.target.value })}
                  onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      cancelEdit();
                    } else if (enterSends(e)) {
                      e.preventDefault();
                      saveEdit();
                    }
                  }} />
                <div className="queued-actions">
                  <button className="btn primary small" disabled={!editing.text.trim()} onClick={saveEdit}>Save<KeyHint keys="↵" /></button>
                  <button className="btn ghost small" onClick={cancelEdit}>Cancel<KeyHint keys="Esc" /></button>
                </div>
              </>
            ) : (
              <>
                <UserText text={q.text} commands={commands} />
                {editable(q) && (
                  <div className="queued-actions">
                    <button className="btn small" onClick={() => setEditing({ id: q.id, text: q.text })}>Edit</button>
                    {q.state === "unsent" && (
                      <button className="btn primary small" disabled={stopping}
                        onClick={() => api.sendQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Send</button>
                    )}
                    <button className="btn ghost small" onClick={() => discard(q.id)}>Discard</button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        {!running && ticket.recovery && <RecoveryBanner slug={slug} ticket={ticket} onError={onError} />}
        {!running && !ticket.recovery && ticket.error && !ticket.error.startsWith("corrupt") && (
          <div className="banner error inline"><pre>{ticket.error}</pre></div>
        )}
        {ticket.notice && (
          <div className="banner info inline notice" role="status">
            <span>{ticket.notice}</span>
            <button className="icon-btn" aria-label="Dismiss" title="Dismiss"
              onClick={() => api.updateTicket(slug, ticket.id, { notice: null }).catch((e) => onError(e.message))}><CloseIcon size={12} /></button>
          </div>
        )}
        {/* Sticky inside the log, so it floats just above the composer. */}
        {jump && (
          <button className={`jump-latest${jump.fresh ? " fresh" : ""}`} onClick={toBottom}>
            <ArrowDownIcon size={12} /> {jump.fresh ? "New messages" : "Jump to latest"}
          </button>
        )}
      </div>

      {ticket.terminalOpen && !running && (
        <div className="composer-warn">
          Also open in your terminal: type in one place at a time.{" "}
          <button className="link-btn small" aria-expanded={showWarnDetails} onClick={() => setShowWarnDetails((v) => !v)}>
            {showWarnDetails ? "Less" : "Why?"}
          </button>
          {showWarnDetails && (
            <div className="composer-warn-more">
              Sending here works, but if you type in both places at once the two conversations can get mixed up.
            </div>
          )}
        </div>
      )}
      <div className="composer">
        <textarea ref={composer} rows={phone ? 1 : 2} value={draft} disabled={stopping} className={images.dragOver ? "drop-target" : undefined} {...images.handlers}
          placeholder={phone
            ? running ? "Steer Claude…" : refine ? "Describe your idea…" : "Ask Claude…"
            : running ? "Steer Claude: it reads this at its next step, no restart…" : refine ? "Describe your idea or answer Claude…" : "Ask Claude to change or continue something…"}
          onChange={(e) => setDraft(e.target.value)}
          onSelect={() => { snippets.handlers.onSelect(); slash.handlers.onSelect(); }}
          onBlur={() => { snippets.handlers.onBlur(); slash.handlers.onBlur(); }}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e)) return;
            if (snippets.onKeyDown(e)) return;
            // ↑ in an empty composer fixes the last message Claude hasn't received yet.
            const last = queued.filter((q) => !q.peer && editable(q)).at(-1);
            if (e.key === "ArrowUp" && !draft && last && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              setEditing({ id: last.id, text: last.text });
              return;
            }
            if (enterSends(e)) {
              e.preventDefault();
              send(draft);
            }
          }} />
        {snippets.popup}
        {slash.popup}
        <AttachmentChips text={draft} images={images} />
        {images.error && <div className="form-error">{images.error}</div>}
        <div className="composer-foot">
          <span className="muted small composer-hint">
            {refine ? "Refine mode: Claude won't change files." : "Claude acts on your message."}
            <span className="composer-keys"> Enter to send · Shift+Enter for a new line{queued.some((q) => !q.peer && editable(q)) && " · ↑ to edit your queued message"}</span>
          </span>
          <span className="composer-actions">
            <ImagePickButton images={images} target={composer} disabled={stopping} />
            {running && <button className="btn danger small" disabled={stopping} onClick={stop}>{stopping ? "Stopping…" : "Stop"}</button>}
            <button className="btn primary small" disabled={!draft.trim() || stopping || images.uploading} onClick={() => send(draft)}>{images.uploading ? "Uploading…" : "Send"}<KeyHint keys="↵" /></button>
          </span>
        </div>
      </div>
    </div>
  );
}
