import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, COLUMNS, safeHref, startWorkTarget, subscribe, type ClaudeSession, type Job, type Profile, type Status, type Ticket } from "./api";
import { outcomeBadge } from "./Card";
import { JobChip } from "./Jobs";
import { CapActions } from "./CapActions";
import { capLabel, capWait } from "./capText";
import { LimitActions } from "./LimitActions";
import { StallActions, stallWait } from "./StallActions";
import { limitHint, limitLabel, limitWait } from "./limitText";
import { branchTicket } from "./branch";
import { BugReportDialog } from "./BugReportDialog";
import { Changes, useTicketDiff } from "./Changes";
import { HelpMenu, useHelp } from "./HelpMenu";
import { Chat, useStop } from "./Chat";
import { ConfirmDialog } from "./ConfirmDialog";
import { DescriptionEditor, useDescriptionCommands } from "./DescriptionEditor";
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronUpIcon, CloseIcon, ExternalIcon, FileTextIcon, LinkIcon, SparkIcon } from "./icons";
import { useImagePaste } from "./imagePaste";
import { useFocusTrap, useLayer } from "./layers";
import { drawerTabs, isStopKey, isTyping, nextStep, panelStep, stepTab, type DrawerTab } from "./keynav";
import { KeyHint } from "./KeyHint";
import { MOD } from "./Shortcuts";
import { complete, PlanFinished, planFinished, PlanPanel, PlanSummary } from "./PlanPanel";
import { Outputs } from "./Outputs";
import { PrBox } from "./PrBox";
import { Select } from "./Select";
import { useShareNotices } from "./share";
import { SessionPicker, sessionLabel } from "./SessionPicker";
import { TicketMenu } from "./TicketMenu";
import { missingPctReason, UsagePanel, usageChipText, useTicketUsage } from "./UsagePanel";
import { approxPct } from "./usage";
import { Markdown } from "./Transcript";
import { NeedsField } from "./Needs";
import { TagEditor } from "./Tags";
import { RunSettings } from "./RunSettings";
import { boardTags } from "./tagText";
import { useHuddle, members } from "./huddle";
import { HuddlePanel } from "./HuddlePanel";
import type { HuddleSeed, TeamRequest } from "./Team";
import { StarToggle } from "./StarToggle";
import { usePhone } from "./usePhone";
import { useShrinkHeader } from "./useShrinkHeader";
import { toast } from "./toast";
import { FollowUpChip } from "./FollowUpChip";
import { FileLinksProvider } from "./FileViewer";

// v2: widths saved under the old 80% default are dropped once so the new default shows.
const WIDTH_KEY = "ckanban.panelWidth.v2";
const MIN_WIDTH = 640;

/** Backdrop left visible beside the panel, so clicking it can always close the panel. */
const BACKDROP_MIN = 64;
/** Artifact and share link chips in the header; the rest are behind "+N more" (the Outputs tab). */
const LINK_CHIPS = 3;

const defaultWidth = () => Math.round(Math.min(1120, window.innerWidth * 0.72));

/** Until the user resizes the panel, the Changes tab opens it this wide (clamped to the window): file list plus diff. */
const CHANGES_WIDTH = 1280;

/** Chat room for the default width: a comfortable reading column plus side padding. Dragging can go wider. */
const CHAT_ROOM = 800;

function clampWidth(w: number): number {
  const vw = window.innerWidth;
  // Narrow windows can't fit the minimum width plus the strip: the panel goes full width there.
  const max = vw >= MIN_WIDTH + BACKDROP_MIN ? vw - BACKDROP_MIN : vw;
  return Math.round(Math.min(Math.max(w, Math.min(MIN_WIDTH, max)), max));
}

const SIDE_KEY = "ckanban.sidebarWidth";
const SIDE_DEFAULT = 340;
const SIDE_MIN = 260;
/** The chat column always keeps at least this much room. */
const CHAT_MIN = 420;

const clampSide = (w: number, bodyWidth: number) =>
  Math.round(Math.max(SIDE_MIN, Math.min(w, bodyWidth ? bodyWidth - CHAT_MIN : w)));

/**
 * Drag the line between the details sidebar and the chat; double-click resets to 340px.
 * The preference persists per browser and is clamped to the panel's current width when shown.
 */
function useSidebarWidth(bodyRef: React.RefObject<HTMLDivElement | null>) {
  const [pref, setPref] = useState(() => {
    try {
      return Number(localStorage.getItem(SIDE_KEY)) || SIDE_DEFAULT;
    } catch {
      return SIDE_DEFAULT;
    }
  });
  const [bodyWidth, setBodyWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const width = clampSide(pref, bodyWidth);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBodyWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const persist = (w: number) => {
    try {
      localStorage.setItem(SIDE_KEY, String(w));
    } catch {}
  };
  const set = (w: number) => {
    const c = clampSide(w, bodyRef.current?.clientWidth ?? 0);
    setPref(c);
    return c;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const left = bodyRef.current?.getBoundingClientRect().left ?? 0;
    if (dragging) set(e.clientX - left);
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    persist(widthRef.current);
  };
  const reset = () => persist(set(SIDE_DEFAULT));
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 120 : 40;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      persist(set(widthRef.current + (e.key === "ArrowRight" ? step : -step)));
    }
  };
  return { width, pref, dragging, handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick: reset, onKeyDown } };
}

/** The width the user dragged to, or null when they never resized (or reset). */
function savedWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    if (v) return v;
  } catch {}
  return null;
}

/**
 * Drag the panel's left edge to resize, up to the window minus the backdrop strip; double-click resets.
 * Width persists per browser. Until the user resizes, the default is min(1120px, 72%) but no wider than
 * `fit` (sidebar + chat reading room), so the panel doesn't open with empty space beside the chat.
 */
function usePanelWidth(fit: number) {
  const [pref, setPref] = useState(savedWidth);
  const [dragging, setDragging] = useState(false);
  // Re-render on window resize; the width is clamped to the window on every render.
  const [, setVw] = useState(window.innerWidth);
  const width = clampWidth(pref ?? Math.min(defaultWidth(), fit));
  const widthRef = useRef(width);
  widthRef.current = width;

  const persist = (w: number) => {
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {}
  };
  const set = (w: number) => {
    const c = clampWidth(w);
    setPref(c);
    return c;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging) set(window.innerWidth - e.clientX);
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    persist(widthRef.current);
  };
  const reset = () => {
    setPref(null);
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {}
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 120 : 40;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      persist(set(widthRef.current + (e.key === "ArrowLeft" ? step : -step)));
    }
  };
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return { width, custom: pref !== null, dragging, handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick: reset, onKeyDown } };
}

/** Ticket view: details on the left, the chat with Claude filling the right side. */
export function TicketDrawer({ profile, ticket, tickets, onOpenTicket, onClose, nav, slideIn = true, tabRequest, huddleSeed, onOpenTeam, jobs = [], onOpenJobs, moveTo }: {
  profile: Profile;
  ticket: Ticket;
  /** The board's tickets, for the planner/child links. */
  tickets: Ticket[];
  onOpenTicket: (id: string) => void;
  onClose: () => void;
  /** The other boards, and the move of this ticket to one (true when it moved): "Move to board" in the ticket menu. */
  moveTo?: { boards: { slug: string; name: string }[]; onMove: (id: string, board: { slug: string; name: string }) => Promise<boolean> };
  /** The previous/next visible ticket in board order (null at the ends or when this one isn't on the board view). */
  nav?: { prev: string | null; next: string | null; go: (id: string) => void };
  /** Slide in when opened; off when stepping from the neighbouring ticket. */
  slideIn?: boolean;
  /** Show this tab (e.g. a card's huddle badge); `n` changes for each new request. */
  tabRequest?: { tab: "huddle"; n: number; huddleId?: string } | null;
  /** The Team tab's Start huddle: fill this roster in on the Huddle tab; `n` changes for each new request. */
  huddleSeed?: { seed: HuddleSeed; n: number } | null;
  /** Open the dock's Team tab on a teammate or a proposal to edit (teammate cards). */
  onOpenTeam?: (r: TeamRequest) => void;
  /** The board's one-time scheduled jobs: this ticket's chip. */
  jobs?: Job[];
  /** The chip was clicked: open Schedules → Upcoming for this ticket. */
  onOpenJobs?: (ticketId: string) => void;
}) {
  // Errors from actions in this ticket show here, next to what failed, not in the page's top strip.
  const [panelError, setPanelError] = useState<string | null>(null);
  const onError = (msg: string) => setPanelError(msg);
  const slug = profile.slug;
  const parent = ticket.parentId ? tickets.find((t) => t.id === ticket.parentId) : undefined;
  const children = tickets.filter((t) => t.parentId === ticket.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const branchedFrom = ticket.branchedFrom ? tickets.find((t) => t.id === ticket.branchedFrom) : undefined;
  const branches = tickets.filter((t) => t.branchedFrom === ticket.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const addOnOf = ticket.addOnOf ? tickets.find((t) => t.id === ticket.addOnOf) : undefined;
  const addOns = tickets.filter((t) => t.addOnOf === ticket.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const siblings = ticket.parentId ? tickets.filter((t) => t.parentId === ticket.parentId && t.id !== ticket.id) : [];
  const deps = (ticket.dependsOn ?? []).map((ref) => siblings.find((s) => s.id === ref || s.planKey === ref) ?? ref);
  const [title, setTitle] = useState(ticket.title);
  const [body, setBody] = useState(ticket.body);
  const [editing, setEditing] = useState(false);
  const images = useImagePaste(setBody);
  const descCommands = useDescriptionCommands(slug, ticket.id);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  // Body the current edit started from; the server rejects the save if the file changed meanwhile.
  const [baseBody, setBaseBody] = useState(ticket.body);
  const phone = usePhone();
  const [tabPick, setTab] = useState<DrawerTab>(tabRequest?.tab ?? "chat");
  // The huddle round picked in the Huddle tab (null: the default one); kept while the drawer stays on this ticket.
  const [huddlePick, setHuddlePick] = useState<string | null>(tabRequest?.huddleId ?? null);
  useEffect(() => {
    if (!tabRequest) return;
    setTab(tabRequest.tab);
    // A card badge or Start huddle shows the current round; a dock row its own.
    setHuddlePick(tabRequest.huddleId ?? null);
  }, [tabRequest?.n]);
  // Opening the ticket tells a follow-up's Claude the user looked (the server writes it at most every 5 minutes).
  useEffect(() => {
    api.markSeen(slug, ticket.id).catch(() => {});
  }, [slug, ticket.id]);
  const huddleState = useHuddle(slug, ticket.id, huddlePick);
  const huddle = huddleState.latest;
  // The Plan tab exists only while the ticket has children; Changes while it has a worktree, or it ran in the board's
  // folder itself: its changes since the first run there, or (no version history) why they can't be shown.
  const inFolder = !ticket.worktree && !ticket.workdir && !ticket.branch && (ticket.runCount > 0 || !!ticket.sessionStarted || !!ticket.baseSha);
  // The tabs shown, in order ([ and ] step through them); opening one refreshes what it shows, like a click.
  const tabs = drawerTabs({ phone, plan: children.length > 0, changes: !!(ticket.worktree || inFolder) });
  const tab = tabs.includes(tabPick) ? tabPick : "chat";
  const diffState = useTicketDiff(slug, ticket);
  const help = useHelp(slug, ticket, !!diffState.diff?.files.length);
  const [outputCount, setOutputCount] = useState(0);
  const ticketUsage = useTicketUsage(slug, ticket.id);
  const openTab = (t: typeof tabPick) => {
    if (t === "changes") diffState.reload();
    else if (t === "outputs") setOutputFocus(null);
    else if (t === "usage") ticketUsage.reload();
    setTab(t);
  };
  const usage = ticketUsage.usage;
  const hasUsage = !!usage?.runs.length;
  useShareNotices(ticket);
  // A file to show when the Outputs tab opens (a mockup clicked in the chat).
  const [outputFocus, setOutputFocus] = useState<string | null>(null);
  const [titleSave, setTitleSave] = useState<"saving" | "saved" | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const isTopLayer = useLayer(onClose, { skipInInputs: true });
  useFocusTrap(panelRef, true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reportingBug, setReportingBug] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmBranch, setConfirmBranch] = useState(false);
  // "Move to board…": the dialog, and the board picked in it.
  const [moveBoard, setMoveBoard] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [picking, setPicking] = useState(false);
  const [linked, setLinked] = useState<ClaudeSession | null>(null);
  const [detailsOpen, setDetailsOpenState] = useState(() => {
    try {
      return localStorage.getItem("ckanban.detailsOpen") !== "0";
    } catch {
      return true;
    }
  });
  // Phones open on the chat full screen; the details live in the Ticket tab there instead of a sidebar.
  const setDetailsOpen = (fn: (v: boolean) => boolean) => {
    if (phone) return setTab((t) => (t === "ticket" ? "chat" : "ticket"));
    setDetailsOpenState((v) => {
      const next = fn(v);
      try {
        localStorage.setItem("ckanban.detailsOpen", next ? "1" : "0");
      } catch {}
      return next;
    });
  };
  const detailsShown = !phone && detailsOpen;
  useEffect(() => {
    // ⌘\ / Ctrl+\ toggles the details column, like a sidebar.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setDetailsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phone]);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const revertTitle = useRef(false);
  // Leaving for the neighbouring ticket: keep a title edit, and don't drop an unsaved description edit.
  const step = (id: string | null | undefined) => {
    if (!id || !nav || editing || confirmDelete || confirmStart || confirmBranch || moveBoard !== null || confirmStop || picking || reportingBug) return;
    if (title !== ticket.title) saveTitle();
    nav.go(id);
  };
  // Latest prev/next for the key handler below, which is bound once.
  const stepRef = useRef((_to: "prev" | "next") => {});
  stepRef.current = (to) => step(nav?.[to]);
  // Plain-key shortcuts (↑↓ J K, E) only when the panel itself has the keyboard: not typing, no menu, popup or dialog above it.
  const panelKeys = (e: KeyboardEvent) => !e.isComposing && !e.defaultPrevented && !isTyping(e) && isTopLayer() && !document.querySelector(".overlay");
  const panelKeysRef = useRef(panelKeys);
  panelKeysRef.current = panelKeys;
  useEffect(() => {
    // Alt+↑ / Alt+↓ open the previous / next ticket, also while typing; plain ↑/↓ and K/J when not typing.
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      let dir: "prev" | "next" | null = null;
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) dir = e.key === "ArrowUp" ? "prev" : "next";
      else if (panelKeysRef.current(e)) dir = panelStep(e);
      if (!dir) return;
      e.preventDefault();
      stepRef.current(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const working = ticket.status === "in_progress" || !!ticket.running;
  const att = working ? null : ticket.attention ?? null;
  const { stopping, stop } = useStop(slug, ticket, working, (m) => setPanelError(m));
  const bodyRef = useRef<HTMLDivElement>(null);
  const side = useSidebarWidth(bodyRef);
  // Scrolling the chat or huddle feed down shrinks the header to one line; scrolling up brings it back.
  const slim = useShrinkHeader(bodyRef, tab === "chat" || tab === "huddle", tab);
  // Opens fitted to the sidebar plus the chat's reading column; dragging can make it wider.
  const panel = usePanelWidth((detailsShown ? side.pref : 0) + CHAT_ROOM);
  const { dragging, handle } = panel;
  const width = (tab === "changes" || tab === "huddle") && !panel.custom ? clampWidth(CHANGES_WIDTH) : panel.width;
  const [descScrolled, setDescScrolled] = useState(false);
  // The tab bar scrolls sideways on narrow screens: fade its right edge while tabs are hidden there,
  // and keep the open tab in view.
  const tabsRef = useRef<HTMLElement>(null);
  const [tabsMore, setTabsMore] = useState(false);
  const checkTabs = () => {
    const el = tabsRef.current;
    setTabsMore(!!el && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(checkTabs);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = tabsRef.current;
    const on = el?.querySelector<HTMLElement>("button.active");
    if (el && on) {
      const r = on.getBoundingClientRect();
      const n = el.getBoundingClientRect();
      if (r.left < n.left || r.right > n.right) el.scrollLeft += r.left - n.left - (n.width - r.width) / 2;
    }
    checkTabs();
  }, [tab, tabs.length]);

  const links = (ticket.links ?? []).filter((l) => safeHref(l.url));
  const loadOutputs = () => api.outputs(slug, ticket.id).then((o) => setOutputCount(o.length)).catch(() => {});

  useEffect(() => {
    loadOutputs();
    api.ticket(slug, ticket.id).then((t) => { setBody(t.body); setBaseBody(t.body); setTitle(t.title); }).catch(() => {});
  }, [slug, ticket.id]);

  useEffect(() => {
    if (!ticket.workdir || !ticket.sessionId) return setLinked(null);
    api.sessions(slug).then((ss) => setLinked(ss.find((s) => s.id === ticket.sessionId) ?? null)).catch(() => {});
  }, [slug, ticket.sessionId, ticket.workdir, ticket.status]);

  useEffect(() => subscribe((e) => {
    if (e.type === "ticket.updated" && e.profile === slug && e.ticket.id === ticket.id) loadOutputs();
  }), [slug, ticket.id]);

  useEffect(() => {
    if (!editing) {
      setBody(ticket.body);
      setBaseBody(ticket.body);
    }
  }, [ticket.body]);
  useEffect(() => {
    if (document.activeElement !== titleRef.current) setTitle(ticket.title);
  }, [ticket.title]);
  // The title box grows to fit the whole title; it re-measures when the text or the panel's width changes.
  const growTitle = () => {
    const el = titleRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)}px`;
  };
  useLayoutEffect(growTitle, [title, width, detailsShown, phone]);
  useEffect(() => {
    window.addEventListener("resize", growTitle);
    return () => window.removeEventListener("resize", growTitle);
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e: any) {
      onError(e.message);
    }
  };
  const saveTitle = async () => {
    if (!title.trim()) return setTitle(ticket.title);
    if (title === ticket.title) return;
    setTitleSave("saving");
    try {
      await api.updateTicket(slug, ticket.id, { title: title.trim() });
      setTitleSave("saved");
      setTimeout(() => setTitleSave((s) => (s === "saved" ? null : s)), 1600);
    } catch (e: any) {
      setTitleSave(null);
      onError(`Title not saved: ${e.message}`);
    }
  };
  const startEdit = async () => {
    try {
      const fresh = await api.ticket(slug, ticket.id);
      setBody(fresh.body);
      setBaseBody(fresh.body);
    } catch {}
    setEditing(true);
  };
  const saveBody = () => {
    if (images.uploading) return;
    if (body === baseBody) return setEditing(false);
    api.updateTicket(slug, ticket.id, { body, expectedBody: baseBody })
      .then((t) => { setBaseBody(t.body); setEditing(false); })
      .catch((e) => onError(e.message));
  };
  // Marked Done: on to the next ticket of the column the drawer walks, or back to the board after its last one,
  // at once rather than after the save, so a close in the meantime can't be undone by a late jump.
  // The drawer may be gone when the save fails, so the error goes to the board's toast.
  const setStatus = (status: Status) => {
    if (status !== "done" || ticket.status === "done") return act(() => api.updateTicket(slug, ticket.id, { status }));
    const title = ticket.title;
    api.updateTicket(slug, ticket.id, { status }).catch((e) => toast(<>Couldn't mark <b>{title}</b> done: {e.message}</>, { tone: "error" }));
    if (nav?.next) step(nav.next);
    else if (!editing) onClose();
  };
  const col = COLUMNS.find((c) => c.id === ticket.status);
  const startTarget = startWorkTarget(ticket);
  const startWork = () => (startTarget === "planning" ? setStatus("planning") : setConfirmStart(true));
  // The chat's newest unapplied proposal (Chat reports it), so ⌘⇧Enter can apply it and start work in one go.
  const applyProposalRef = useRef<((start: boolean) => Promise<void>) | null>(null);
  const [proposalPending, setProposalPending] = useState(false);
  const onPendingProposal = useCallback((apply: ((start: boolean) => Promise<void>) | null) => {
    applyProposalRef.current = apply;
    setProposalPending(!!apply);
  }, []);
  // Every child of its plan is done: Move to Done replaces Start work.
  const finished = planFinished(children);
  const addMoreTickets = () => {
    setTab("chat");
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  };
  const next = nextStep({ status: ticket.status, working, proposalPending, planFinished: finished });
  const nextStepRef = useRef(() => {});
  nextStepRef.current = () => {
    if (next === "apply" || next === "apply-start") applyProposalRef.current?.(next === "apply-start");
    else if (next === "start") startWork();
    else if (next === "done") setStatus("done");
  };
  useEffect(() => {
    // ⌘⇧Enter / Ctrl+Shift+Enter: the ticket's next step (apply proposal & start work, Start work, Mark done), also while typing.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !e.shiftKey || !(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
      if (document.querySelector(".overlay")) return;
      e.preventDefault();
      nextStepRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // E: edit the description; R: Refine with Claude (Backlog); S: star; M: move to a column; [ ]: previous / next tab.
  // Only when the panel has the keyboard.
  const letterRef = useRef<(k: string) => boolean>(() => false);
  letterRef.current = (k) => {
    if (k === "e" && !editing) {
      if (phone) setTab("ticket");
      return startEdit(), true;
    }
    if (k === "r" && !working && !editing && ticket.status === "backlog") return setStatus("planning"), true;
    if (k === "s") return toggleStar(), true;
    if (k === "m") return openStatusPicker(), true;
    if (k === "[" || k === "]") {
      const to = stepTab<typeof tabPick>(tabs, tab, k === "]" ? 1 : -1);
      if (to) openTab(to);
      return !!to;
    }
    return false;
  };
  // ⌘. / Ctrl+.: Stop Claude, after a confirm; also while typing.
  const stopKeyRef = useRef(() => {});
  stopKeyRef.current = () => { if (working && !stopping) setConfirmStop(true); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isStopKey(e) || document.querySelector(".overlay")) return;
      e.preventDefault();
      stopKeyRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !panelKeysRef.current(e)) return;
      if (letterRef.current(e.key.toLowerCase())) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const toggleStar = () => {
    api.updateTicket(slug, ticket.id, { important: !ticket.important }).catch((e) => onError(`Important not saved: ${e.message}`));
  };
  // M: open the Status picker (the header's Move picker on a phone with the details hidden), showing the details first if needed.
  const openStatusPicker = () => {
    const sel = phone && !detailsShown ? ".phone-move" : ".status-select";
    const open = () => {
      const trigger = panelRef.current?.querySelector<HTMLButtonElement>(`${sel} .select-trigger`);
      trigger?.focus();
      trigger?.click();
    };
    if (!detailsShown && !phone) {
      setDetailsOpen(() => true);
      requestAnimationFrame(open);
    } else open();
  };
  const cancelEdit = () => { setBody(baseBody); setEditing(false); images.clearError(); };

  const usageTitle = !usage ? "" : usage.totals.pctCurrentWindow === null ? missingPctReason(usage)
    : "This ticket's ≈ share of the current 5h plan window, and its API-equivalent cost";
  // On a phone the run cost joins the column's help line when it is the only result chip.
  const usageInline = phone && !!col && hasUsage && !links.length && outputCount === 0;
  // Status, actions, links and the description: a sidebar on wider screens, the Ticket tab on phones.
  const details = (
    <div className="panel-details">
      <div className="details-pinned">
        {/* Phones move the ticket with the header's picker, which shows the column. */}
        {!phone && (
          <div className="field-row">
            <span className="field-key">Status</span>
            <Select className="status-select" ariaLabel="Status" value={ticket.status} onChange={(s) => setStatus(s as Status)}
              options={COLUMNS.map((c) => ({ value: c.id, label: c.label, hint: c.hint, disabled: c.id === "in_progress" && !working }))} />
          </div>
        )}
        {col && (
          <p className="field-help">
            {col.claude && <SparkIcon className="icon spark" />}{col.hint}
            {usageInline && <> · <button className="link-btn usage-inline" onClick={() => setTab("usage")} title={usageTitle}>{usageChipText(usage!)}</button></>}
          </p>
        )}

        <div className="action-stack">
          {working && <button className="btn danger" disabled={stopping} onClick={stop} title={`Stop Claude (${MOD}.)`}>{stopping ? "Stopping…" : "Stop Claude"}<KeyHint keys="⌘." /></button>}
          {finished && <PlanFinished ticket={ticket} total={children.length} onMoveToDone={() => setStatus("done")} onAddMore={addMoreTickets} />}
          {!working && !finished && (ticket.status === "backlog" || ticket.status === "planning") && (
            <button className={`btn ${att?.kind === "questions" || att?.kind === "proposal" ? "" : "primary"}`}
              onClick={startWork} title={`${startTarget === "planning" ? "Claude interviews you first" : "Claude works on its own"} (${proposalPending ? `${MOD}⇧Enter applies the proposal and starts` : `${MOD}⇧Enter`})`}>
              Start work{!proposalPending && <KeyHint keys="⌘⇧↵" />}
            </button>
          )}
          {!working && ticket.status === "backlog" && (
            <button className="btn" onClick={() => setStatus("planning")} title="Move to Planning: Claude interviews you (R)">
              Refine with Claude<KeyHint keys={startTarget === "planning" && !proposalPending ? "⌘⇧↵ · R" : "R"} />
            </button>
          )}
          {ticket.status === "review" && !finished && (
            <button className={`btn ${ticket.prUrl ? "" : "primary"}`} onClick={() => setStatus("done")} title={`Mark done (${MOD}⇧Enter)`}>Mark done{!working && <KeyHint keys={proposalPending ? "⌘⇧↵ after Apply" : "⌘⇧↵"} />}</button>
          )}
          {ticket.source?.url && (
            <a className="btn icon-label" href={safeHref(ticket.source.url)} target="_blank" rel="noreferrer" title={ticket.source.label}>
              Open in {ticket.source.provider} <ExternalIcon size={12} />
            </a>
          )}
          {ticket.prUrl && ticket.status !== "review" && (
            <a className="btn icon-label" href={safeHref(ticket.prUrl)} target="_blank" rel="noreferrer">Open PR #{ticket.prUrl.split("/").pop()} <ExternalIcon size={12} /></a>
          )}
        </div>
        {ticket.prUrl && ticket.status === "review" && <PrBox profile={profile} ticket={ticket as Ticket & { prUrl: string }} onError={onError} />}

        {ticket.parentId && (
          <div className="field-row">
            <span className="field-key" title="The planner ticket whose plan runs this one (it proposed or adopted it)">From</span>
            {parent ? (
              <button className="link-btn ticket-link" onClick={() => onOpenTicket(parent.id)}>{parent.title}</button>
            ) : (
              <span className="muted small">Planner ticket was deleted</span>
            )}
          </div>
        )}
        {ticket.branchedFrom && (
          <div className="field-row">
            <span className="field-key" title="This ticket started as a copy of that one's conversation and code">Branched from</span>
            {branchedFrom ? (
              <button className="link-btn ticket-link" onClick={() => onOpenTicket(branchedFrom.id)}>{branchedFrom.title}</button>
            ) : (
              <span className="muted small">Source ticket was deleted</span>
            )}
          </div>
        )}
        {branches.length > 0 && (
          <div className="field-row">
            <span className="field-key" title="Tickets branched from this one">Branches</span>
            <span className="dep-list">
              {branches.map((b) => <button key={b.id} className="link-btn ticket-link" onClick={() => onOpenTicket(b.id)}>{b.title}</button>)}
            </span>
          </div>
        )}
        {(ticket.followUp || ticket.followUpStopped) && (
          <div className="field-row">
            <span className="field-key" title="Claude comes back to this ticket by itself at that time">Follow-up</span>
            <span><FollowUpChip slug={slug} ticket={ticket} onError={onError} /></span>
          </div>
        )}
        {ticket.addOnOf && (
          <div className="field-row">
            <span className="field-key" title="This ticket is a new requirement on that one, which keeps its own title and description">Add-on to</span>
            {addOnOf ? (
              <span>
                <button className="link-btn ticket-link" onClick={() => onOpenTicket(addOnOf.id)}>{addOnOf.title}</button>
                <span className="muted small"> ({COLUMNS.find((c) => c.id === addOnOf.status)?.label ?? addOnOf.status})</span>
              </span>
            ) : (
              <span className="muted small">Original ticket was deleted</span>
            )}
          </div>
        )}
        {addOns.length > 0 && (
          <div className="field-row">
            <span className="field-key" title="New requirements on this ticket, each in its own ticket">Add-ons</span>
            <span className="dep-list">
              {addOns.map((f) => <button key={f.id} className="link-btn ticket-link" onClick={() => onOpenTicket(f.id)}>{f.title}</button>)}
            </span>
          </div>
        )}
        {deps.length > 0 && (
          <div className="field-row">
            <span className="field-key" title="A running plan starts this ticket once these are done">Waits for</span>
            <span className="dep-list">
              {deps.map((d) => typeof d === "string"
                ? <span key={d} className="muted small">{d} (missing)</span>
                : <button key={d.id} className="link-btn ticket-link" onClick={() => onOpenTicket(d.id)}>{d.title}</button>)}
            </span>
          </div>
        )}

        {/* Rarely set by hand (plans and update_ticket set it), so only shown once the ticket has needs. */}
        {!!ticket.needs?.length && <NeedsField slug={slug} ticket={ticket} onError={onError} />}

        {children.length > 0 && <PlanSummary ticket={ticket} children={children} onOpen={() => setTab("plan")} />}

        {(!!links.length || outputCount > 0 || (hasUsage && !usageInline)) && (
          <div className="result-chips" aria-label="Results">
            {usage && hasUsage && !usageInline && (
              <button className="result-chip usage-chip" onClick={() => setTab("usage")} title={usageTitle}>
                {usageChipText(usage)}
              </button>
            )}
            {outputCount > 0 && (
              <button className="result-chip" onClick={() => setTab("outputs")}><FileTextIcon size={13} /> {outputCount} output file{outputCount > 1 ? "s" : ""}</button>
            )}
            {links.slice(0, LINK_CHIPS).map((l) => (
              <a key={l.url} className="result-chip" href={safeHref(l.url)} target="_blank" rel="noreferrer"
                title={l.source === "share" ? `Share link: ${l.url}` : l.url}>
                {l.source === "share" ? <LinkIcon size={12} /> : <ExternalIcon size={12} />} {l.label}
              </a>
            ))}
            {links.length > LINK_CHIPS && (
              <button className="result-chip" onClick={() => { setOutputFocus(null); setTab("outputs"); }} title="All links are in the Outputs tab">
                +{links.length - LINK_CHIPS} more
              </button>
            )}
          </div>
        )}
      </div>

      <section className={`details-desc ${descScrolled && !editing ? "scrolled" : ""}`}>
        <div className="section-head">
          <h4>Description</h4>
          {!editing && <button className="btn ghost small" onClick={startEdit} title="Edit the description (E)">Edit<KeyHint keys="E" /></button>}
        </div>
        {editing ? (
          <div className="desc-edit">
            <DescriptionEditor slug={slug} ticketId={ticket.id} value={body} setValue={setBody} images={images} inputRef={bodyInput} autoFocus fill
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey) saveBody();
                else if (e.key === "Escape" && !e.nativeEvent.isComposing) { e.preventDefault(); cancelEdit(); }
              }} />
            <div className="form-actions">
              <button className="btn ghost" onClick={cancelEdit} title="Cancel (Esc)">Cancel<KeyHint keys="Esc" /></button>
              <button className="btn primary" disabled={images.uploading} onClick={saveBody} title={`Save (${MOD}Enter)`}>{images.uploading ? "Uploading…" : "Save"}<KeyHint keys="⌘↵" /></button>
            </div>
          </div>
        ) : (
          <div className="desc-scroll" onScroll={(e) => setDescScrolled(e.currentTarget.scrollTop > 0)}>
            {body.trim() ? (
              <div className="body-view" onDoubleClick={startEdit}><Markdown text={body} commands={descCommands} /></div>
            ) : (
              <div className="muted small">No description yet. {ticket.status === "planning" ? "Claude can propose one in the chat." : ""}</div>
            )}
          </div>
        )}
      </section>
    </div>
  );
  return (
    <FileLinksProvider slug={slug} ticketId={ticket.id} panel={panelRef}>
    <div className="drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={panelRef} className={`panel ${dragging ? "resizing" : ""} ${slideIn ? "" : "no-slide"}${slim ? " head-slim" : ""}`} role="dialog" aria-modal="true" aria-label={ticket.title} style={{ width }} tabIndex={-1}>
        <div className="drawer-resize" role="separator" aria-orientation="vertical" aria-label="Resize panel" tabIndex={0}
          title="Drag to resize · double-click to reset" {...handle} />

        <header className="panel-head">
          {phone && <button className="icon-btn phone-back" onClick={onClose} aria-label="Back to the board"><ChevronLeftIcon size={22} /></button>}
          {!phone && <button className={`icon-btn sidebar-toggle ${detailsShown ? "on" : ""}`} onClick={() => setDetailsOpen((v) => !v)}
            aria-label={detailsShown ? "Hide details" : "Show details"} aria-pressed={detailsShown}
            title={`${detailsShown ? "Hide" : "Show"} details (⌘\\)`}>
            <KeyHint keys="⌘\" />
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
              <rect x="2" y="3" width="14" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <line x1="7" y1="3.5" x2="7" y2="14.5" stroke="currentColor" strokeWidth="1.5" />
              {detailsShown && <rect x="2.75" y="3.75" width="3.5" height="10.5" rx="1.5" fill="currentColor" opacity="0.35" />}
            </svg>
          </button>}
          <StarToggle on={!!ticket.important} onChange={toggleStar} keyHint="S" />
          {/* The shrunk header's one line: the title, cut short (the full one is in .panel-top). */}
          <span className="head-title" aria-hidden={!slim}>{ticket.title}</span>
          {att && (
            <span className={`your-turn inline att-${att.kind}`} title={att.kind === "limit" ? limitLabel(ticket) : att.label}>
              <span className="yt-dot" aria-hidden /><span className="yt-label">Your turn</span><span className="yt-why">{att.kind === "limit" ? limitLabel(ticket) : att.label}</span>
            </span>
          )}
          {!att && !ticket.huddleBusy && outcomeBadge(ticket)}
          <span className="save-state" aria-live="polite">
            {titleSave === "saving" && <span className="muted small">Saving…</span>}
            {titleSave === "saved" && <span className="saved small"><CheckIcon size={12} /> Saved</span>}
          </span>
          <span className="head-spacer" />
          <JobChip jobs={jobs} ticketId={ticket.id} onOpen={onOpenJobs} />
          <HelpMenu help={help} phone={phone} onAsk={(kind) => { setTab("chat"); void help.ask(kind); }} />
          {nav && (
            <span className="ticket-nav">
              <button className="icon-btn" disabled={!nav.prev || editing} onClick={() => step(nav.prev)} aria-label="Previous ticket"
                title={editing ? "Save or cancel the description first" : "Previous ticket (↑ or K)"}><ChevronUpIcon size={16} /></button>
              <button className="icon-btn" disabled={!nav.next || editing} onClick={() => step(nav.next)} aria-label="Next ticket"
                title={editing ? "Save or cancel the description first" : "Next ticket (↓ or J)"}><ChevronDownIcon size={16} /></button>
              <KeyHint keys="↑↓ J K" />
            </span>
          )}
          {phone && (
            <Select className="phone-move" ariaLabel="Move to column" value={ticket.status} onChange={(s) => setStatus(s as Status)} renderValue={(o) => o?.label ?? "Move"}
              menuMaxHeight={Infinity} // all columns fit on a phone screen; only scroll when the screen is too short
              options={COLUMNS.map((c) => ({ value: c.id, label: c.label, hint: c.hint, disabled: c.id === "in_progress" && !working }))} />
          )}
          <TicketMenu ticket={ticket} working={working} live={!!(ticket.terminalOpen || linked?.live)}
            linkedLabel={ticket.workdir && ticket.sessionId ? (linked ? sessionLabel(linked) : ticket.sessionId.slice(0, 8)) : null}
            boardCap={profile.runCapUsd ?? null}
            onCap={(usd) => api.updateTicket(slug, ticket.id, { runCapUsd: usd })}
            onBranch={() => setConfirmBranch(true)}
            onMoveToBoard={moveTo?.boards.length ? () => setMoveBoard(moveTo.boards[0].slug) : undefined}
            onPickSession={() => setPicking(true)}
            onUnlink={() => act(() => api.linkSession(slug, ticket.id, null))}
            onCheckPr={() => act(() => api.checkPr(slug, ticket.id))}
            onReportBug={() => setReportingBug(true)}
            onDelete={() => setConfirmDelete(true)} />
          {!phone && <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)"><CloseIcon /><KeyHint keys="Esc" /></button>}
        </header>
        {/* Title and tags fold away while the header is shrunk. */}
        <div className="panel-top" aria-hidden={slim || undefined}><div className="panel-top-in">
        {/* The whole title, wrapping to as many lines as it needs, under the buttons. */}
        <div className="panel-title">
          <textarea ref={titleRef} className="title-input" rows={1} value={title} aria-label="Title"
            onChange={(e) => setTitle(e.target.value.replace(/\s*\n\s*/g, " "))}
            // Esc's blur runs with this render's title, so it is told to skip the save.
            onBlur={() => { if (revertTitle.current) revertTitle.current = false; else saveTitle(); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur(); }
              else if (e.key === "Escape") { revertTitle.current = true; setTitle(ticket.title); e.currentTarget.blur(); }
            }} />
        </div>
        {/* Tags, model and effort share one row. */}
        <div className="panel-meta">
          <TagEditor tags={ticket.tags ?? []} suggested={ticket.suggestedTags ?? []} known={boardTags(tickets)}
            onChange={(tags) => api.updateTicket(slug, ticket.id, { tags }).catch((e) => onError(`Tags not saved: ${e.message}`))}
            onSuggested={(suggestedTags) => api.updateTicket(slug, ticket.id, { suggestedTags }).catch((e) => onError(`Tags not saved: ${e.message}`))} />
          <RunSettings profile={profile} ticket={ticket} onError={onError} />
        </div>
        </div></div>

        <div ref={bodyRef} className={`panel-body ${detailsShown ? "" : "details-closed"} ${side.dragging ? "resizing" : ""}`}
          style={{ "--side-w": `${side.width}px` } as React.CSSProperties}>
          {!phone && details}

          {detailsShown && (
            <div className="sidebar-resize" role="separator" aria-orientation="vertical" aria-label="Resize details"
              aria-valuenow={side.width} tabIndex={0} title="Drag to resize · double-click to reset" {...side.handle} />
          )}

          <div className="panel-main">
            {panelError && (
              <div className="banner error inline panel-error" role="alert">
                <span>{panelError}</span>
                <button className="icon-btn" aria-label="Dismiss" onClick={() => setPanelError(null)}><CloseIcon /></button>
              </div>
            )}
            {limitWait(ticket) && (
              <div className="banner warn inline limit-banner" role="status">
                <div className="limit-text">
                  <strong>{limitLabel(ticket)}</strong>
                  <span>{limitHint(ticket)}</span>
                  {ticket.limit?.message && <span className="muted small">{ticket.limit.message}</span>}
                </div>
                <LimitActions slug={slug} ticket={ticket} onError={onError} small />
              </div>
            )}
            {capWait(ticket) && (
              <div className="banner warn inline limit-banner" role="status">
                <div className="limit-text">
                  <strong>{capLabel(ticket)}</strong>
                  <span>The run spent its budget before it finished. Continue it in the same session with more, or change the cap in ⋯.</span>
                </div>
                <CapActions slug={slug} ticket={ticket} onError={onError} small />
              </div>
            )}
            {stallWait(ticket) && (
              <div className="banner warn inline limit-banner" role="status">
                <div className="limit-text">
                  <strong>Stalled · no output for {ticket.stalled!.minutes} min</strong>
                  <span>A tool call may be stuck, or it's just a long step. Nothing is killed unless you choose to.</span>
                </div>
                <StallActions slug={slug} ticket={ticket} onError={onError} small />
              </div>
            )}
            <nav ref={tabsRef} className={`tabs${tabsMore ? " more-right" : ""}`} role="tablist" aria-label="Ticket" onScroll={checkTabs}>
              {phone && (
                <button role="tab" aria-selected={tab === "ticket"} className={tab === "ticket" ? "active" : ""} onClick={() => setTab("ticket")}>Ticket</button>
              )}
              <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
                Chat {working && <span className="dot" />}
              </button>
              {children.length > 0 && (
                <button role="tab" aria-selected={tab === "plan"} className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>
                  Plan<span className={`tab-count ${ticket.plan?.state === "stuck" ? "warn" : children.every(complete) ? "ok" : ""}`}>
                    {children.filter(complete).length}/{children.length}
                  </span>
                </button>
              )}
              <button role="tab" aria-selected={tab === "huddle"} className={tab === "huddle" ? "active" : ""} onClick={() => setTab("huddle")}>
                Huddle{huddle && huddle.status !== "closed" && <span className={`tab-count${huddle.status === "live" ? " ok" : ""}`}>{members(huddle).length}</span>}
                {huddle && huddle.status !== "closed" && !!huddle.forYou && (
                  <span className="for-you-pill" title={`${huddle.forYou} ${huddle.forYou === 1 ? "message tags" : "messages tag"} you`}>{huddle.forYou}</span>
                )}
                {huddle?.status === "live" && huddle.participants.some((p) => p.status === "working") && <span className="dot" />}
              </button>
              {(ticket.worktree || inFolder) && (
                <button role="tab" aria-selected={tab === "changes"} className={tab === "changes" ? "active" : ""} onClick={() => openTab("changes")}>
                  Changes{!!diffState.diff?.files.length && <span className="tab-count">{diffState.diff.files.length}</span>}
                </button>
              )}
              <button role="tab" aria-selected={tab === "outputs"} className={tab === "outputs" ? "active" : ""} onClick={() => openTab("outputs")}>
                Outputs{outputCount + links.length > 0 && <span className="tab-count">{outputCount + links.length}</span>}
              </button>
              <button role="tab" aria-selected={tab === "usage"} className={tab === "usage" ? "active" : ""} onClick={() => openTab("usage")}>
                Usage{usage && hasUsage && usage.totals.pctCurrentWindow !== null && <span className="tab-count">{approxPct(usage.totals.pctCurrentWindow).replace(" ", "")}</span>}
              </button>
            </nav>
            {tab === "ticket" ? (
              <div className={`panel-ticket ${editing ? "editing" : ""}`}>{details}</div>
            ) : tab === "plan" ? (
              <div className="panel-scroll panel-plan">
                <PlanPanel slug={slug} ticket={ticket} children={children} onOpenTicket={onOpenTicket} onError={onError}
                  onMoveToDone={() => setStatus("done")} onAddMore={addMoreTickets} />
              </div>
            ) : tab === "huddle" ? (
              <HuddlePanel slug={slug} ticket={ticket} tickets={tickets} state={huddleState} onError={onError} seed={huddleSeed ?? null} onSelect={setHuddlePick}
                onOpenOutput={(name) => { setOutputFocus(name); setTab("outputs"); }}
                onOpenChat={() => setTab("chat")} onOpenTicket={onOpenTicket} onOpenTeam={onOpenTeam} />
            ) : tab === "changes" ? (
              <Changes slug={slug} ticket={ticket} state={diffState} onSent={() => setTab("chat")} onError={onError} />
            ) : tab === "usage" ? (
              <div className="panel-scroll panel-usage"><UsagePanel usage={usage} error={ticketUsage.error} /></div>
            ) : tab === "outputs" ? (
              <div className="panel-scroll panel-outputs"><Outputs slug={slug} ticket={ticket} onCount={setOutputCount} focus={outputFocus} /></div>
            ) : (
              <Chat slug={slug} ticket={ticket} tickets={tickets} onOpenTicket={onOpenTicket} onError={onError} onPendingProposal={onPendingProposal}
                huddle={huddle} onOpenHuddle={() => setTab("huddle")} onOpenTeam={onOpenTeam} help={help}
                onOpenOutput={(name) => { setOutputFocus(name); setTab("outputs"); }} />
            )}
          </div>
        </div>

        {picking && (
          <SessionPicker slug={slug} folder={profile.path} currentTicketId={ticket.id} onClose={() => setPicking(false)}
            onPick={(s) => act(async () => { await api.linkSession(slug, ticket.id, s.id); setPicking(false); })} />
        )}
        {ticket.error?.startsWith("corrupt") && <div className="banner error inline"><pre>{ticket.error}</pre></div>}
        {confirmStart && (
          <ConfirmDialog title="Start work?" confirmLabel="Start work" busyLabel="Starting…" tone="primary"
            onCancel={() => setConfirmStart(false)}
            onConfirm={async () => { await api.updateTicket(slug, ticket.id, { status: "ready" }); setConfirmStart(false); }}>
            <p>Claude will work on this on its own. When working: <b>{ticket.mode === "interview" ? "Interview me first" : "Just do it"}</b>.</p>
          </ConfirmDialog>
        )}
        {confirmStop && (
          <ConfirmDialog title="Stop Claude?" confirmLabel="Stop Claude" busyLabel="Stopping…"
            onCancel={() => setConfirmStop(false)}
            onConfirm={() => { if (working) stop(); setConfirmStop(false); }}>
            <p>Claude stops working on this ticket now. You can start it again later.</p>
          </ConfirmDialog>
        )}
        {confirmBranch && (
          <ConfirmDialog title="Branch this ticket?" confirmLabel="Branch ticket" busyLabel="Branching…" tone="primary"
            onCancel={() => setConfirmBranch(false)}
            onConfirm={async () => { await branchTicket(slug, ticket, onOpenTicket); setConfirmBranch(false); }}>
            <p>Creates <b>Branch: {ticket.title}</b> in Planning with a copy of this conversation{ticket.branch ? <>, on its own branch off <code>{ticket.branch}</code> (committed work only)</> : ""}. Then take it in another direction; this ticket stays as it is.</p>
          </ConfirmDialog>
        )}
        {moveBoard !== null && moveTo && (
          <ConfirmDialog title="Move to another board?" confirmLabel="Move ticket" busyLabel="Moving…" tone="primary"
            onCancel={() => setMoveBoard(null)}
            onConfirm={async () => {
              const target = moveTo.boards.find((b) => b.slug === moveBoard);
              if (target && await moveTo.onMove(ticket.id, target)) onClose();
              else setMoveBoard(null);
            }}>
            <p>Sends <b>{ticket.title}</b> to the Backlog of another board. Only the title, description and tags come along; chat and comments stay behind, and it leaves this board.</p>
            <Select ariaLabel="Board to move to" value={moveBoard} onChange={setMoveBoard}
              options={moveTo.boards.map((b) => ({ value: b.slug, label: b.name }))} />
          </ConfirmDialog>
        )}
        {reportingBug && (
          <BugReportDialog ticket={{ profile: slug, id: ticket.id, title: ticket.title }} onClose={() => setReportingBug(false)} />
        )}
        {confirmDelete && (
          <ConfirmDialog title={`Delete "${ticket.title}"?`} confirmLabel="Delete ticket" busyLabel="Deleting…" onCancel={() => setConfirmDelete(false)}
            onConfirm={async () => { await api.deleteTicket(slug, ticket.id); onClose(); }}>
            <p>Removes the ticket and its board history.{working ? " Claude will be stopped." : ""}</p>
            {ticket.worktree && <p className="muted">Its worktree is removed if it has no uncommitted changes. The branch and any PR stay.</p>}
          </ConfirmDialog>
        )}
      </aside>
    </div>
    </FileLinksProvider>
  );
}
