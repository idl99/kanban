import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, copy, COLUMNS, onReconnect, subscribe, waitsForSlot, type Health, type InboxItem, type Job, type McpState, type Profile, type Schedule, type Status, type Ticket } from "./api";
import { avatarColor, avatarLetter } from "./avatar";
import { BugReportDialog } from "./BugReportDialog";
import { AutomationsDialog } from "./AutomationsDialog";
import { ConnectionsDialog } from "./ConnectionsDialog";
import { HeaderMenu, type MenuItem } from "./HeaderMenu";
import { boardTags, hasTags, parseSearch, tagStyle } from "./tagText";
import { TagFilter } from "./Tags";
import { AtIcon, BellIcon, BugIcon, ChatIcon, CheckIcon, ClockIcon, CloseIcon, CopyIcon, DeviceIcon, FolderIcon, GearIcon, KeyboardIcon, LoopIcon, Logo, PlugIcon, PlusIcon, SearchIcon, TeamIcon, TerminalIcon } from "./icons";
import { Inbox } from "./Inbox";
import { NowView } from "./NowView";
import { NotificationsDialog } from "./NotificationsDialog";
import { PushHint } from "./PushHint";
import { startPushClient } from "./push";
import { PhoneAccessDialog } from "./PhoneAccessDialog";
import { MoreSheet, PhoneNav, type PhoneTab } from "./PhoneNav";
import { QuickChatPane } from "./QuickChat";
import { usePhone } from "./usePhone";
import { UsageBox, UsagePill } from "./UsagePill";
import { useUsage } from "./useUsage";
import { anyLayerOpen } from "./layers";
import { Board } from "./Board";
import { boardColumnOf, columnNeighbours, columnOrder } from "./columns";
import { NewTicketDialog } from "./NewTicketDialog";
import { ProfileDialog } from "./ProfileDialog";
import { SchedulesDialog } from "./SchedulesDialog";
import { SnippetsDialog } from "./SnippetsDialog";
import { Select } from "./Select";
import { BoardSwitcher, ShortcutsDialog } from "./Shortcuts";
import { CommandBar, type CommandAction } from "./CommandBar";
import { boardDigit, cardDir, isTyping, stepBoard, stepCard, type CardPos } from "./keynav";
import { KeyHint, useHintReveal } from "./KeyHint";
import { TicketDrawer } from "./TicketDrawer";
import { toast, Toaster } from "./toast";
import { SampleOffer } from "./SampleOffer";

import type { DockTab } from "./Dock";
import type { HuddleSeed, TeamRequest } from "./Team";
import { useBoardHuddles } from "./huddle";
import { hasOpenPr, runCounts } from "./boardStats";
import { ParallelConfirm } from "./ParallelConfirm";

// xterm.js and highlight.js only load once the panel is opened. After an upgrade the old chunk is gone:
// reload once to get the new build instead of blanking the whole page.
const Dock = lazy(() => import("./Dock").then((m) => {
  sessionStorage.removeItem("ckanban.chunkReload");
  return m;
}, () => {
  if (!sessionStorage.getItem("ckanban.chunkReload")) {
    sessionStorage.setItem("ckanban.chunkReload", "1");
    location.reload();
  }
  return { default: () => <div className="dock dock-failed">Couldn't load the terminal panel. Reload the page.</div> };
}));
const DOCK_OPEN = "ckanban.dock.open";

const LAST_PROFILE = "ckanban.profile";
/** Board slug the sample ticket is offered on, until it is started or dismissed. */
const SAMPLE_OFFER = "ckanban.sample-offer";

/** URL hash is the source of truth for what's open: #/<profile> or #/<profile>/<ticketId>. */
function parseHash(): { slug: string | null; ticket: string | null } {
  const [, slug, ticket] = decodeURIComponent(location.hash.replace(/^#/, "")).split("/");
  return { slug: slug || null, ticket: ticket || null };
}

function hashFor(slug: string | null, ticket?: string | null): string {
  if (!slug) return "#/";
  return `#/${encodeURIComponent(slug)}${ticket ? `/${encodeURIComponent(ticket)}` : ""}`;
}

/** Cards on screen, per expanded column, in board order. */
function cardGrid(): HTMLElement[][] {
  return [...document.querySelectorAll<HTMLElement>(".board > .column:not(.collapsed)")]
    .map((c) => [...c.querySelectorAll<HTMLElement>(".column-body > .sortable-card")]);
}

function focusedCard(grid: HTMLElement[][]): CardPos | null {
  const el = (document.activeElement as HTMLElement | null)?.closest?.(".sortable-card");
  for (let col = 0; col < grid.length; col++) {
    const row = grid[col].findIndex((c) => c === el);
    if (row >= 0) return { col, row };
  }
  return null;
}

function focusCard(pos: CardPos | null, grid = cardGrid()) {
  const col = pos && grid[pos.col];
  const el = col && col[Math.min(pos.row, col.length - 1)];
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Board filter chips; several on = tickets matching any of them. */
const FILTERS = [
  { id: "you", label: "Needs you", test: (t: Ticket) => !!t.attention },
  { id: "running", label: "Running", test: (t: Ticket) => t.status === "in_progress" || !!t.running },
  { id: "pr", label: "Has PR", test: hasOpenPr },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];

const DISMISSED = "ckanban.dismissedBanners";
function readDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISSED) ?? "[]"));
  } catch {
    return new Set();
  }
}

const tildePath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** Background load: retry once after a few seconds, then say so (quietly) instead of failing silently. */
function quiet<T>(load: () => Promise<T>, what: string, set: (v: T) => void) {
  load().then(set).catch(() => {
    setTimeout(() => load().then(set).catch(() => toast(`Couldn't load ${what}. It will retry when the connection comes back.`, { tone: "error" })), 3000);
  });
}

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_PROFILE);
  } catch {
    return null;
  }
}

export function App() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [slug, setSlug] = useState<string | null>(parseHash().slug ?? readLast());
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [dockOpen, setDockOpen] = useState(() => {
    try {
      return localStorage.getItem(DOCK_OPEN) === "1";
    } catch {
      return false;
    }
  });
  const [openId, setOpenId] = useState<string | null>(parseHash().ticket);
  // True when the open ticket was pushed onto browser history by us, so closing can go Back.
  const pushedOpen = useRef(false);
  // Board shown before that push: going Back to a different board would leave the ticket's board.
  const pushedFrom = useRef<string | null>(null);
  // The open ticket was reached with prev/next: the drawer stays put instead of sliding in again.
  const stepped = useRef(false);
  // Column and ticket order prev/next follow, frozen when the drawer opens (see below).
  const [navOrder, setNavOrder] = useState<{ column: Status; ids: string[] } | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [query, setQuery] = useState("");
  // Tags picked by clicking a card's tag chip, shown as chips in the search box (typed #tags stay in the query).
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  useEffect(() => setTagFilter([]), [slug]);
  const addTagFilter = useCallback((tag: string) => setTagFilter((f) => (f.includes(tag) ? f : [...f, tag])), []);
  const clearSearch = () => { setQuery(""); setTagFilter([]); };
  const searchRef = useRef<HTMLInputElement>(null);
  const inboxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [profileDialog, setProfileDialog] = useState<"new" | "edit" | null>(null);
  const [newTicket, setNewTicket] = useState(false);
  const [sampleFor, setSampleForState] = useState(() => { try { return localStorage.getItem(SAMPLE_OFFER); } catch { return null; } });
  const setSampleFor = (v: string | null) => {
    setSampleForState(v);
    try { if (v) localStorage.setItem(SAMPLE_OFFER, v); else localStorage.removeItem(SAMPLE_OFFER); } catch {}
  };
  const setError = (msg: string) => toast(msg, { tone: "error" });
  const [filters, setFilters] = useState<Set<FilterId>>(new Set());
  const [dismissed, setDismissed] = useState(readDismissed);
  const [shortcuts, setShortcuts] = useState(false);
  useHintReveal();
  const [bugReport, setBugReport] = useState(false);
  // ⌘K command bar; the inbox and usage popovers open from it too (n makes repeats count).
  const [commandBar, setCommandBar] = useState(false);
  const [inboxRequest, setInboxRequest] = useState(0);
  const [usageRequest, setUsageRequest] = useState(0);
  // Plan usage and today's spend: the header pill on computers, the More sheet on phones.
  const usage = useUsage();
  const [boardSwitcher, setBoardSwitcher] = useState(false);
  // Command to type into the dock's terminal (e.g. "claude mcp login x"); n makes repeats count.
  const [dockCommand, setDockCommand] = useState<{ text: string; n: number } | null>(null);
  // Item the bottom panel should show (Terminal, Files, Claude or Team); n makes repeats count.
  const [dockTab, setDockTab] = useState<{ tab: DockTab; n: number; team?: TeamRequest } | null>(null);
  // Item the open panel shows (reported by the panel), for the header buttons' on state.
  const [dockShown, setDockShown] = useState<DockTab | null>(null);
  const shownItem = dockOpen ? dockShown : null;
  /** team: what the Team shows (the new-teammate editor, a proposal to edit, a teammate, the huddles). */
  const openDockOn = (tab: DockTab, team?: TeamRequest) => {
    setDockOpen(true);
    setDockTab({ tab, n: Date.now(), ...(team ? { team } : {}) });
  };
  /** A header button or its key: shows that item in the panel, or hides the panel when it already shows it. */
  const toggleDock = (tab: DockTab) => (shownItem === tab ? setDockOpen(false) : openDockOn(tab));
  /** The quick chats with Claude: the Ask tab on phones, the panel's Claude on computers. */
  const openChat = () => (phoneRef.current ? setPhoneTab("ask") : openDockOn("claude"));
  const [mcp, setMcp] = useState<McpState | null>(null);
  const [connections, setConnections] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  // One-time scheduled jobs (Schedules → Upcoming, the chip on the ticket that scheduled them); jobFilter: one ticket's only.
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [jobFilter, setJobFilter] = useState<string | null>(null);
  const openSchedules = useCallback((ticketId: string | null = null) => {
    setJobFilter(ticketId);
    setSchedulesOpen(true);
  }, []);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  // Automations (this board) and the board's passes in Connections: they fetch for themselves and refetch when this
  // counter moves (the server says an automation or a pass changed).
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [autoTick, setAutoTick] = useState(0);
  const schedulesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phone = usePhone();
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  // Phone home: the Now list or the board (bottom tab bar); More opens the header menu as a sheet.
  const [phoneTab, setPhoneTab] = useState<PhoneTab>("now");
  const [moreOpen, setMoreOpen] = useState(false);
  const [phoneAccess, setPhoneAccess] = useState(false);
  const [notifications, setNotifications] = useState(false);
  // Phone notifications: tell the daemon while the board is on screen here, open tapped notifications' tickets.
  useEffect(() => startPushClient(), []);
  const [version, setVersion] = useState<{ version: string; latest: string | null; updateAvailable: boolean } | null>(null);

  const loadProfiles = useCallback(async () => {
    const ps = await api.profiles();
    setProfiles(ps);
    setSlug((cur) => (cur && ps.some((p) => p.slug === cur) ? cur : ps[0]?.slug ?? null));
  }, []);

  const slugRef = useRef(slug);
  slugRef.current = slug;
  const loadSchedules = useCallback((board: string) => api.schedules(board).then((list) => {
    // Ignore a late answer for a board we already left.
    if (slugRef.current === board) setSchedules(list);
  }).catch(() => {}), []);
  const loadJobs = useCallback((board: string) => api.jobs(board).then((list) => {
    if (slugRef.current === board) setJobs(list);
  }).catch(() => {}), []);
  // Fires and ticket changes move "next run", "running" and errors: refetch for the computed fields.
  const refreshSchedulesSoon = useCallback((board: string) => {
    if (schedulesTimer.current) return;
    schedulesTimer.current = setTimeout(() => {
      schedulesTimer.current = null;
      loadSchedules(board);
    }, 300);
  }, [loadSchedules]);

  const [snoozed, setSnoozed] = useState<InboxItem[]>([]);
  const loadInbox = useCallback(() => quiet(api.inbox, "the inbox", (list) => {
    setInbox(list.filter((i) => !i.snoozedUntil));
    setSnoozed(list.filter((i) => i.snoozedUntil));
  }), []);
  const refreshInboxSoon = useCallback(() => {
    if (inboxTimer.current) return;
    inboxTimer.current = setTimeout(() => {
      inboxTimer.current = null;
      loadInbox();
    }, 400);
  }, [loadInbox]);

  useEffect(() => {
    loadProfiles().catch((e) => setError(e.message));
    loadInbox();
    quiet(api.health, "tool checks", setHealth);
    quiet(api.version, "the version", setVersion);
    quiet(api.mcp, "connections", setMcp);
  }, [loadProfiles, loadInbox]);
  // First visit with no boards yet: open New board straight away (it lists recent Claude Code folders).
  const autoOpened = useRef(false);
  useEffect(() => {
    if (profiles?.length !== 0 || autoOpened.current) return;
    autoOpened.current = true;
    setProfileDialog("new");
  }, [profiles]);

  // Browser Back/Forward and pasted links drive the open board and ticket.
  useEffect(() => {
    const onHash = () => {
      const h = parseHash();
      if (h.slug) setSlug(h.slug);
      setOpenId(h.ticket);
      stepped.current = false;
      if (!h.ticket) pushedOpen.current = false;
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Keep the URL in step with the board shown (replace, so switching boards doesn't pile up history).
  useEffect(() => {
    if (slug && parseHash().slug !== slug) history.replaceState(null, "", hashFor(slug, openId));
  }, [slug]);

  const openTicket = useCallback((id: string, board = slug) => {
    if (!board) return;
    pushedOpen.current = true;
    pushedFrom.current = slug;
    location.hash = hashFor(board, id);
  }, [slug]);

  // Prev/next in the drawer: replace the history entry, so one Close or Back still returns to the board.
  const stepTicket = useCallback((id: string) => {
    stepped.current = true;
    history.replaceState(null, "", hashFor(slug, id));
    setOpenId(id);
  }, [slug]);

  // A huddle badge or the dock's Huddles list: open the ticket on its Huddle tab.
  const [huddleTab, setHuddleTab] = useState<{ id: string; n: number; huddleId?: string } | null>(null);
  const openHuddle = useCallback((id: string, huddleId?: string) => {
    setHuddleTab({ id, n: Date.now(), huddleId });
    if (id !== openId) openTicket(id);
  }, [openId, openTicket]);
  const huddles = useBoardHuddles(slug);
  // The Team tab's Start huddle: the drawer's ticket (or a new one) opens on its Huddle tab with this roster filled in.
  const [huddleSeed, setHuddleSeed] = useState<{ id: string; seed: HuddleSeed; n: number } | null>(null);

  const closeTicket = useCallback(() => {
    if (pushedOpen.current && pushedFrom.current === slug) history.back();
    else {
      pushedOpen.current = false;
      history.replaceState(null, "", hashFor(slug));
      setOpenId(null);
    }
  }, [slug]);

  // After the daemon restarts or the laptop wakes, events were missed: reload everything.
  // A pending daemon restart holds new runs on every board: show it so queued cards don't look stuck.
  const [restart, setRestart] = useState({ pending: false, waiting: 0 });
  useEffect(() => { api.restartState().then(setRestart).catch(() => {}); }, []);
  // The daemon keeps the Mac awake while work runs (board setting): said quietly in the running pill's tooltip.
  const [awake, setAwake] = useState(false);
  useEffect(() => { api.awakeState().then((s) => setAwake(s.held)).catch(() => {}); }, []);

  useEffect(() => onReconnect(() => {
    api.restartState().then(setRestart).catch(() => {});
    api.awakeState().then((s) => setAwake(s.held)).catch(() => {});
    loadProfiles().catch(() => {});
    loadInbox();
    api.mcp().then(setMcp).catch(() => {});
    if (slug) {
      api.tickets(slug).then(setTickets).catch(() => {});
      loadSchedules(slug);
      loadJobs(slug);
    }
  }), [slug, loadProfiles, loadInbox, loadSchedules, loadJobs]);

  const needYou = inbox.length;
  // A snooze ends by itself: reload when the first one runs out (the server only counts it again then).
  useEffect(() => {
    if (!snoozed.length) return;
    const first = Math.min(...snoozed.map((i) => Date.parse(i.snoozedUntil!)));
    const timer = setTimeout(() => {
      loadInbox();
      if (slugRef.current) api.tickets(slugRef.current).then(setTickets).catch(() => {});
    }, Math.min(Math.max(first - Date.now(), 0) + 1000, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [snoozed, loadInbox]);
  useEffect(() => {
    document.title = needYou ? `(${needYou}) ckanban` : "ckanban";
  }, [needYou]);

  useEffect(() => {
    try {
      localStorage.setItem(DOCK_OPEN, dockOpen ? "1" : "0");
    } catch {}
  }, [dockOpen]);
  // An item request is one-shot: reopening the panel later shows the user's last item.
  useEffect(() => {
    if (!dockOpen) setDockTab(null);
  }, [dockOpen]);

  // Board switching (B picker, [ ] prev/next, 1…9) leaves the open ticket: it belongs to the old board.
  const switchBoard = useCallback((to: string) => {
    if (to === slugRef.current) return;
    pushedOpen.current = false;
    setOpenId(null);
    setSlug(to);
  }, []);
  // Latest values for the window key handler below, which is bound once per dialog state.
  const live = useRef({ profiles, tickets, markDone: (_id: string) => {} });

  // Shortcuts: N new ticket, / search, ? cheatsheet, Ctrl+` Terminal, F Files, C Claude, T Team (each toggles its item in the bottom panel),
  // ⌘K command bar (tickets on every board, actions, boards),
  // B board picker, [ ] previous / next board, 1…9 board N, J/K/H/L or arrows select a card, D marks a Review card done.
  // Esc is handled by the panel and dialogs (one layer at a time, see layers.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "`") {
        e.preventDefault();
        if (slug) toggleDock("terminal");
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        if ((e.target as HTMLElement | null)?.closest?.(".xterm")) return;
        e.preventDefault();
        // Works without a board too; a second ⌘K closes the bar.
        const layer = anyLayerOpen();
        setCommandBar((o) => (o ? false : !layer));
        return;
      }
      const boards = live.current.profiles ?? [];
      const at = boards.findIndex((p) => p.slug === slug);
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
      if (openId || profileDialog || newTicket || connections || schedulesOpen || automationsOpen || anyLayerOpen() || document.querySelector(".overlay")) return;
      // Plain 1…9 (Alt+digit is taken by Chrome's tab switching); the ticket panel's questions form uses digits too.
      const digit = e.shiftKey || e.isComposing ? null : boardDigit(e.code);
      if (digit !== null) {
        if (!boards[digit]) return;
        e.preventDefault();
        switchBoard(boards[digit].slug);
        return;
      }
      const dir = e.shiftKey && e.key.startsWith("Arrow") ? null : cardDir(e.key);
      if (dir) {
        // A picked-up card (Space) moves with the arrows instead: leave those to the drag.
        if (!slug || e.defaultPrevented || document.querySelector(".sortable-card[aria-pressed='true']")) return;
        // Arrows on a focused button or menu trigger belong to it; J/K/H/L work from anywhere.
        const focus = document.activeElement;
        if (e.key.startsWith("Arrow") && focus && focus !== document.body && !focus.closest(".sortable-card")) return;
        const grid = cardGrid();
        const next = stepCard(grid.map((c) => c.length), focusedCard(grid), dir);
        if (!next) return;
        e.preventDefault();
        focusCard(next, grid);
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (slug) setNewTicket(true);
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "?") {
        e.preventDefault();
        setShortcuts(true);
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        if (slug) (phoneRef.current ? openChat() : toggleDock("claude"));
      } else if (e.key === "f" || e.key === "F") {
        if (!slug || phoneRef.current) return;
        e.preventDefault();
        toggleDock("files");
      } else if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        if (slug) toggleDock("team");
      } else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        if (boards.length) setBoardSwitcher(true);
      } else if (e.key === "[" || e.key === "]") {
        const to = boards[stepBoard(boards.length, at, e.key === "]" ? 1 : -1)];
        if (!to) return;
        e.preventDefault();
        switchBoard(to.slug);
      } else if (e.key === "d" || e.key === "D") {
        const id = (document.activeElement as HTMLElement | null)?.closest?.(".sortable-card")?.getAttribute("data-ticket");
        if (!id) return;
        e.preventDefault();
        live.current.markDone(id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, profileDialog, newTicket, connections, schedulesOpen, automationsOpen, slug, switchBoard, dockOpen, dockShown]);

  const runInTerminal = useCallback((text: string) => {
    setDockOpen(true);
    setDockCommand({ text, n: Date.now() });
  }, []);

  const dismiss = (key: string) => setDismissed((d) => {
    const next = new Set(d).add(key);
    try {
      sessionStorage.setItem(DISMISSED, JSON.stringify([...next]));
    } catch {}
    return next;
  });

  useEffect(() => {
    if (!slug) return;
    try {
      localStorage.setItem(LAST_PROFILE, slug);
    } catch {}
    setTickets([]);
    setSchedules(null);
    setJobs(null);
    api.tickets(slug).then(setTickets).catch((e) => setError(e.message));
    loadSchedules(slug);
    loadJobs(slug);
  }, [slug, loadSchedules, loadJobs]);

  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === "mcp.updated") {
          setMcp(e.state);
          return;
        }
        if (e.type === "integration.updated" || (e.type === "loop.updated" && e.profile === slug)) {
          setAutoTick((n) => n + 1);
          return;
        }
        if (e.type === "restart.updated") {
          setRestart({ pending: e.pending, waiting: e.waiting });
          return;
        }
        if (e.type === "awake.updated") {
          setAwake(e.held);
          return;
        }
        if (e.type === "profile.updated") {
          loadProfiles().catch(() => {});
          refreshInboxSoon();
          return;
        }
        if (e.type === "ticket.updated" || e.type === "ticket.deleted" || e.type === "session.updated" || e.type === "huddle.updated") refreshInboxSoon();
        if (e.type === "schedule.updated" && e.profile === slug) refreshSchedulesSoon(slug);
        if (e.type === "job.updated" && e.profile === slug) {
          const job = e.job;
          setJobs((js) => (js ? [...js.filter((j) => j.id !== e.id), ...(job ? [job] : [])] : js));
        }
        if (e.type === "ticket.updated" && e.profile === slug && e.ticket.scheduleId) refreshSchedulesSoon(slug);
        if (e.type === "ticket.updated" && e.profile === slug) {
          setTickets((ts) => {
            const i = ts.findIndex((t) => t.id === e.ticket.id);
            const merged = { ...ts[i], ...e.ticket };
            if (i < 0) return [...ts, merged];
            const next = ts.slice();
            next[i] = merged;
            return next;
          });
        }
        if (e.type === "session.updated" && e.profile === slug) {
          setTickets((ts) => ts.map((t) => (t.id === e.id ? { ...t, session: e.session } : t)));
        }
        if (e.type === "ticket.deleted" && e.profile === slug) {
          setTickets((ts) => ts.filter((t) => t.id !== e.id));
        }
      }),
    [slug, loadProfiles, refreshInboxSoon, refreshSchedulesSoon],
  );

  const profile = useMemo(() => profiles?.find((p) => p.slug === slug) ?? null, [profiles, slug]);
  const open = tickets.find((t) => t.id === openId) ?? null;

  /** Start huddle from the Team tab: on the ticket open in the drawer, else on a new ticket in Planning. No picker. */
  const startHuddle = async (seed: HuddleSeed) => {
    if (!profile) return;
    let id = open?.id;
    if (!id) {
      try {
        const what = "preset" in seed ? `@${seed.preset}` : `the ${seed.template} template`;
        const t = await api.createTicket(profile.slug, {
          title: "preset" in seed ? `Huddle with @${seed.preset}` : `Huddle: ${seed.template}`,
          body: `Started from the Team tab: a huddle with ${what}. Say what it should work on.`, status: "planning",
        });
        setTickets((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]));
        id = t.id;
      } catch (e) {
        toast(`Couldn't create the ticket: ${(e as Error).message}`, { tone: "error" });
        return;
      }
    }
    setHuddleSeed({ id, seed, n: Date.now() });
    openHuddle(id);
  };
  // The drawer has taken the Huddle tab request (as its first tab, or switched to it): forget it.
  useEffect(() => {
    if (huddleTab && open?.id === huddleTab.id) setHuddleTab(null);
  }, [huddleTab, open?.id]);
  const search = parseSearch(query);
  const q = search.text;
  const tagsWanted = [...new Set([...tagFilter, ...search.tags])];
  const activeFilters = FILTERS.filter((f) => filters.has(f.id));
  const shownTickets = tickets.filter((t) =>
    (!q || `${t.title}\n${t.body}`.toLowerCase().includes(q)) && hasTags(t, tagsWanted) && (!activeFilters.length || activeFilters.some((f) => f.test(t))));
  const filtering = !!q || tagsWanted.length > 0 || activeFilters.length > 0;
  // Prev/next walk the visible tickets of the column the drawer opened in, in its order at that time, so
  // moving the open ticket (e.g. Planning to Done) keeps Next in Planning, and the ends of the column stop
  // there. Stepping keeps that order; deleted tickets are skipped.
  const liveOrder = open ? { column: boardColumnOf(open), ids: columnOrder(shownTickets, boardColumnOf(open)) } : null;
  const orderMissing = !!openId && !navOrder?.ids.includes(openId);
  useEffect(() => {
    if (!openId) setNavOrder(null);
    else if (!stepped.current || orderMissing) setNavOrder(liveOrder);
  }, [openId, orderMissing, tickets.length > 0]);
  // navOrder is null until the effect above runs (and whenever no ticket is open): fall back to the live order.
  const navIn = orderMissing ? liveOrder : navOrder ?? liveOrder;
  const { prev: prevId, next: nextId } = open && navIn ? columnNeighbours(navIn.ids, navIn.column, open.id, tickets) : { prev: null, next: null };
  const perBoard = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of inbox) m.set(i.profile, (m.get(i.profile) ?? 0) + 1);
    return m;
  }, [inbox]);

  // Without an order the server puts the ticket where a column entry goes (e.g. top of Done).
  // "Move to board" in the ticket menu: the other boards; the ticket leaves this board and shows up in the target's Backlog.
  const moveTo = useMemo(() => ({
    boards: (profiles ?? []).filter((p) => p.slug !== slug).map((p) => ({ slug: p.slug, name: p.name })),
    onMove: async (id: string, to: { slug: string; name: string }) => {
      try {
        const t = await api.moveTicketToBoard(slug!, id, to.slug);
        toast(<>Moved <b>{t.title}</b> to {to.name}. It is in that board's Backlog.</>);
        return true;
      } catch (e: any) {
        toast(e.message, { tone: "error" });
        return false;
      }
    },
  }), [profiles, slug]);

  const move = async (id: string, status: Status, order?: number, undo = true) => {
    const board = slug!;
    const before = tickets.find((t) => t.id === id);
    setTickets((ts) => ts.map((t) => (t.id === id ? { ...t, status, ...(order === undefined ? {} : { order }) } : t)));
    try {
      await api.updateTicket(board, id, order === undefined ? { status } : { status, order });
      if (undo && before && before.status !== status) {
        const label = COLUMNS.find((c) => c.id === status)?.label ?? status;
        toast(<>Moved <b>{before.title}</b> to {label}</>, {
          action: { label: "Undo", run: () => { if (slugRef.current === board) move(id, before.status, before.order, false); } },
        });
      }
    } catch (e: any) {
      setError(`Couldn't move the ticket: ${e.message}`);
      api.tickets(board).then(setTickets).catch(() => {});
    }
  };

  // D on a focused Review card; focus stays at the same spot on the board for the next key.
  const markDone = (id: string) => {
    if (tickets.find((t) => t.id === id)?.status !== "review") return;
    const pos = focusedCard(cardGrid());
    void move(id, "done");
    setTimeout(() => focusCard(pos));
  };
  live.current = { profiles, tickets, markDone };

  const mcpAttention = mcp?.servers.filter((s) => s.attention).length ?? 0;
  const scheduleFails = schedules?.filter((s) => s.lastError).length ?? 0;
  const missing = health ? (["claude", "git", "gh"] as const).filter((k) => !health[k]) : [];
  // Every active ticket run (chat replies and Planning too); slots: the ones holding a maxParallel slot, as the server counts them.
  const running = runCounts(tickets, huddles);
  const liveHuddles = huddles.filter((h) => h.status === "live").length;
  // Lessons the board saved on its own since the user last looked (Team, Learned).
  const [learnedNew, setLearnedNew] = useState(0);
  useEffect(() => {
    setLearnedNew(0);
    if (!slug) return;
    const load = () => api.learned(slug).then((v) => setLearnedNew(v.newCount), () => {});
    load();
    return subscribe((e) => {
      if (e.type === "learned.updated" && (e.profile === slug || e.profile === null)) load();
    });
  }, [slug]);
  const queued = tickets.filter((t) => t.status === "ready" || waitsForSlot(t)).length;

  const updateKey = `update:${version?.latest}`;
  const pathKey = `path:${missing.join(",")}`;
  const folderKey = `folder:${profile?.slug}`;
  const toggleFilter = (id: FilterId) => setFilters((f) => {
    const next = new Set(f);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const menuItems: MenuItem[] = [
          ...(profile ? [{
            label: "Schedules", icon: <ClockIcon />, onSelect: () => openSchedules(),
            title: scheduleFails ? `${scheduleFails} schedule${scheduleFails === 1 ? "" : "s"} could not start their last run`
              : "Upcoming one-time jobs and recurring tickets",
            badge: scheduleFails > 0 ? <span className="need-chip">{scheduleFails}</span>
              : schedules && schedules.length > 0 ? <span className="muted small">{schedules.filter((s) => s.enabled).length} active</span> : null,
          }, {
            label: "Automations", icon: <LoopIcon />, onSelect: () => setAutomationsOpen(true),
            title: "Check a service on a timer, without Claude, and turn new items into tickets on this board",
          }, {
            label: "Snippets", icon: <AtIcon />, onSelect: () => setSnippetsOpen(true),
            title: "Reusable prompt text: type @name in a ticket or the chat to insert it",
          }] : []),
          {
            label: "Connections", icon: <PlugIcon />, onSelect: () => setConnections(true), separator: true,
            title: mcpAttention ? `${mcpAttention} MCP server${mcpAttention === 1 ? "" : "s"} failed or need you to log in again` : "Claude Code MCP servers",
            badge: mcpAttention > 0 ? <span className="need-chip">{mcpAttention}</span> : null,
          },
          ...(profile ? [{ label: "Board settings", icon: <GearIcon />, onSelect: () => setProfileDialog("edit") }] : []),
          { label: "Phone access", icon: <DeviceIcon />, onSelect: () => setPhoneAccess(true), title: "Open this board from your phone over Tailscale" },
          { label: "Notifications", icon: <BellIcon />, onSelect: () => setNotifications(true), title: "Get told on your phone when a ticket needs you" },
          { label: "Keyboard shortcuts", hint: "?", icon: <KeyboardIcon />, onSelect: () => setShortcuts(true) },
          { label: "Report a bug", icon: <BugIcon />, onSelect: () => setBugReport(true) },
  ];
  const menuAlert = scheduleFails > 0 || mcpAttention > 0;
  const menuFooter = version && version.version !== "dev" ? `ckanban v${version.version} · by Leo` : "by Leo";
  // Inbox triage on any board: the entry leaves the list (and the counts) at once, the server confirms.
  const inboxDone = async (i: InboxItem) => {
    setInbox((l) => l.filter((x) => x !== i));
    setSnoozed((l) => l.filter((x) => x !== i));
    if (i.profile === slug) return move(i.id, "done").finally(loadInbox);
    try {
      await api.updateTicket(i.profile, i.id, { status: "done" });
      toast(<>Moved <b>{i.title}</b> to Done</>);
    } catch (e: any) {
      setError(`Couldn't move the ticket: ${e.message}`);
      loadInbox();
    }
  };
  const inboxSnooze = async (i: InboxItem, on: boolean) => {
    const until = new Date(Date.now() + 24 * 3600_000).toISOString();
    if (on) {
      setInbox((l) => l.filter((x) => x !== i));
      setSnoozed((l) => [...l, { ...i, snoozedUntil: until }]);
    } else {
      setSnoozed((l) => l.filter((x) => x !== i));
      setInbox((l) => [...l, { ...i, snoozedUntil: undefined }]);
    }
    if (i.profile === slug) setTickets((ts) => ts.map((t) => (t.id === i.id ? { ...t, attention: on ? null : i.attention, snoozed: on ? { attention: i.attention, until } : null } : t)));
    try {
      const t = await (on ? api.snooze(i.profile, i.id) : api.unsnooze(i.profile, i.id));
      const merge = (t: Ticket) => { if (i.profile === slugRef.current) setTickets((ts) => ts.map((x) => (x.id === t.id ? { ...x, ...t } : x))); };
      if (on) toast(<>Snoozed <b>{i.title}</b> for a day</>, { action: { label: "Undo", run: () => void api.unsnooze(i.profile, i.id).then((t) => { merge(t); loadInbox(); }, () => {}) } });
      merge(t);
    } catch (e: any) {
      setError(`Couldn't ${on ? "snooze" : "unsnooze"} the ticket: ${e.message}`);
      if (i.profile === slugRef.current) api.tickets(i.profile).then(setTickets).catch(() => {});
    }
    loadInbox();
  };

  const openFrom = (board: string, id: string) => {
    if (board !== slug) setSlug(board);
    openTicket(id, board);
  };

  // ⌘K actions run the same handlers as their buttons and menu items.
  const commandActions: CommandAction[] = [
    ...(profile ? [
      { id: "new", label: "New ticket", keys: ["N"], run: () => setNewTicket(true) },
      { id: "dock", label: "Open terminal", keys: ["Ctrl", "`"], icon: <TerminalIcon size={14} />, run: () => openDockOn("terminal") },
      { id: "files", label: "Open files", keys: ["F"], icon: <FolderIcon size={14} />, hint: "browse this folder", run: () => openDockOn("files") },
      { id: "chat", label: "Quick Claude chat", keys: ["C"], icon: <ChatIcon size={14} />, run: () => openChat() },
    ] : []),
    ...(profile ? [
      { id: "team", label: "Open Team", keys: ["T"], icon: <TeamIcon size={14} />, hint: "teammates, templates, huddles", run: () => openDockOn("team") },
      { id: "huddles", label: liveHuddles ? `Huddles (${liveHuddles} live)` : "Huddles", icon: <TeamIcon size={14} />, hint: "in Team", run: () => openDockOn("team", { action: "huddles" }) },
      { id: "new-teammate", label: "New teammate…", run: () => openDockOn("team", { action: "new" }) },
    ] : []),
    ...(inbox.length ? [{ id: "inbox", label: `Open inbox (${inbox.length} need you)`, run: () => setInboxRequest(Date.now()) }] : []),
    ...(profile ? [{ id: "schedules", label: "Schedules", icon: <ClockIcon size={14} />, run: () => openSchedules() }] : []),
    ...(profile ? [{ id: "automations", label: "Automations", icon: <LoopIcon size={14} />, run: () => setAutomationsOpen(true) }] : []),
    { id: "connections", label: "Connections", icon: <PlugIcon size={14} />, run: () => setConnections(true) },
    ...(profile ? [{ id: "snippets", label: "Snippets", icon: <AtIcon size={14} />, run: () => setSnippetsOpen(true) }] : []),
    { id: "usage", label: "Usage", run: () => setUsageRequest(Date.now()) },
    ...(profile ? [{ id: "settings", label: "Board settings", icon: <GearIcon size={14} />, run: () => setProfileDialog("edit") }] : []),
    { id: "new-board", label: "New board", run: () => setProfileDialog("new") },
    { id: "notifications", label: "Notifications", icon: <BellIcon size={14} />, hint: "on your phone when a ticket needs you", run: () => setNotifications(true) },
    { id: "phone", label: "Phone access", icon: <DeviceIcon size={14} />, hint: "open the board from your phone", run: () => setPhoneAccess(true) },
    { id: "shortcuts", label: "Keyboard shortcuts", keys: ["?"], icon: <KeyboardIcon size={14} />, run: () => setShortcuts(true) },
    { id: "bug", label: "Report a bug", icon: <BugIcon size={14} />, run: () => setBugReport(true) },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <KeyHint keys="⌘K" />
          <Logo />
          <span className="brand-name">ckanban</span>
          <span className="brand-tagline">Kanban for Claude Code</span>
        </div>
        {profiles && profiles.length > 0 && (
          <Select
            className="profile-select"
            ariaLabel="Board"
            value={slug ?? ""}
            onChange={setSlug}
            menuClassName="profile-menu"
            menuMaxHeight={440}
            options={profiles.map((p) => ({ value: p.slug, label: p.name, hint: tildePath(p.path) }))}
            renderOption={(o, selected) => (
              <>
                <span className="profile-avatar" style={{ background: avatarColor(o.value) }} aria-hidden>{avatarLetter(String(o.label))}</span>
                <span className="profile-body">
                  <span className="profile-row">
                    <span className="profile-name">{o.label}</span>
                    {!!perBoard.get(o.value) && <span className="need-chip">{perBoard.get(o.value)} need you</span>}
                  </span>
                  <span className="profile-path" title={profiles.find((p) => p.slug === o.value)?.path}>{o.hint}</span>
                </span>
                <span className="profile-check" aria-hidden>{selected && <CheckIcon size={13} />}</span>
              </>
            )}
            renderValue={() => profile?.name}
            badge={<KeyHint keys="B  [ ]" />}
            footer={[
              ...(profile ? [{
                label: "Copy folder path",
                icon: <CopyIcon size={12} />,
                onSelect: () => { copy(profile.path).then(() => toast(<>Copied <code>{tildePath(profile.path)}</code></>, { tone: "ok" })); },
              }] : []),
              { label: "New board…", onSelect: () => setProfileDialog("new") },
            ]}
          />
        )}
        {profile && (
          <span className="pill" title={`${running.runs} ticket ${running.runs === 1 ? "run" : "runs"} active, ${running.slots} of ${profile.maxParallel} slots in use. Slots apply to ticket runs: at most ${profile.maxParallel} work at the same time on this board. Planning chats and replies to other tickets don't take a slot.${running.agents ? ` Huddle agents (${running.agents} working) run outside the slots.` : ""}${awake ? " Keeping Mac awake until the work on your boards finishes." : ""}`}>
            {running.runs}/{profile.maxParallel} running{running.agents > 0 && <> · {running.agents} huddle {running.agents === 1 ? "agent" : "agents"}</>}{queued > 0 && <> · {queued} queued</>}{awake && <> · keeping Mac awake</>}
          </span>
        )}
        <UsagePill state={usage} openRequest={usageRequest} />
        {restart.pending && (
          <span className="pill warn" title="The daemon restarts once every active run (on any board) has finished. Until then nothing new starts: queued tickets, chat replies and Planning interviews wait.">
            Restart pending{restart.waiting > 0 ? ` · waiting for ${restart.waiting} ${restart.waiting === 1 ? "run" : "runs"}` : ""}
          </span>
        )}
        <div className="spacer" />
        <Inbox items={inbox} snoozed={snoozed} openRequest={inboxRequest} onPick={(i) => openFrom(i.profile, i.id)}
          onMarkDone={(i) => void inboxDone(i)} onSnooze={(i, on) => void inboxSnooze(i, on)} />
        {profile && (
          <button className={`btn ghost icon-label${shownItem === "terminal" ? " on" : ""}`} onClick={() => toggleDock("terminal")}
            aria-pressed={shownItem === "terminal"} title="A terminal in this folder (Ctrl+`). Hiding it keeps the shell running." aria-label="Terminal">
            <TerminalIcon /><span className="label">Terminal</span><KeyHint keys="Ctrl+`" />
          </button>
        )}
        {profile && (
          <button className={`btn ghost icon-label${shownItem === "files" ? " on" : ""}`} onClick={() => toggleDock("files")}
            aria-pressed={shownItem === "files"} title="Browse the files in this folder (F)" aria-label="Files">
            <FolderIcon /><span className="label">Files</span><KeyHint keys="F" />
          </button>
        )}
        {profile && (
          <button className={`btn ghost icon-label${shownItem === "claude" ? " on" : ""}`} onClick={() => toggleDock("claude")}
            aria-pressed={shownItem === "claude"} title="Quick chat with Claude in this folder, no ticket needed (C)" aria-label="Quick Claude chat">
            <ChatIcon /><span className="label">Claude</span><KeyHint keys="C" />
          </button>
        )}
        {profile && (
          <button className={`btn ghost icon-label${shownItem === "team" ? " on" : ""}`} onClick={() => (learnedNew && shownItem !== "team" ? openDockOn("team", { action: "learned" }) : toggleDock("team"))}
            aria-pressed={shownItem === "team"} title={`Teammates, templates and huddles (T)${liveHuddles ? `. ${liveHuddles} ${liveHuddles === 1 ? "huddle" : "huddles"} live.` : ""}${learnedNew ? `. ${learnedNew} ${learnedNew === 1 ? "lesson" : "lessons"} saved.` : ""}`} aria-label="Team">
            <TeamIcon /><span className="label">Team</span>
            {liveHuddles > 0 && <span className="tab-count ok">{liveHuddles} live</span>}
            {learnedNew > 0 && <span className="tab-count">{learnedNew} new</span>}
            <KeyHint keys="T" />
          </button>
        )}
        {profile && (
          <button className="btn ghost phone-only topbar-icon" aria-label="Search tickets"
            onClick={() => { setPhoneTab("board"); requestAnimationFrame(() => searchRef.current?.focus()); }}>
            <SearchIcon size={18} />
          </button>
        )}
        {profile && (
          <button className="btn primary phone-only topbar-icon" aria-label="New ticket" onClick={() => setNewTicket(true)}><PlusIcon size={18} /></button>
        )}
        {profile && (
          <button className="btn primary desktop-only" onClick={() => setNewTicket(true)} title="New ticket (N)">
            New ticket<KeyHint keys="N" />
          </button>
        )}
        <HeaderMenu alert={menuAlert} keyHint={<KeyHint keys="?" />} items={menuItems} footer={menuFooter} />
      </header>

      {version?.updateAvailable && !dismissed.has(updateKey) && (
        <div className="banner info" role="status">
          <span>ckanban v{version.latest} is available (you have v{version.version}). Run <code>ckanban update</code> in a terminal.</span>
          <button className="icon-btn" aria-label="Dismiss" title="Hide until next time" onClick={() => dismiss(updateKey)}><CloseIcon size={12} /></button>
        </div>
      )}
      {missing.length > 0 && !dismissed.has(pathKey) && (
        <div className={`banner ${missing.includes("claude") ? "warn" : "info"}`} role="status">
          <span>
            {missing.includes("claude") && <><b>claude</b> not found on PATH: tickets cannot run. </>}
            {missing.includes("git") && <><b>git</b> not found: tickets still run, directly in the board folder without per-ticket worktrees. </>}
            {missing.includes("gh") && (
              <>
                <b>gh</b> (GitHub CLI) is optional: tickets run without it; it is only needed to open and track pull requests.
                {" "}To add it: <code>brew install gh</code>, then <code>gh auth login</code> (<a href="https://cli.github.com" target="_blank" rel="noreferrer">cli.github.com</a>).
              </>
            )}
          </span>
          <button className="icon-btn" aria-label="Dismiss" title="Hide until next time" onClick={() => dismiss(pathKey)}><CloseIcon size={12} /></button>
        </div>
      )}
      {profile && profile.pathExists === false && !dismissed.has(folderKey) && (
        <div className="banner warn" role="status">
          <span>Board folder <code>{profile.path}</code> does not exist. Tickets will not be picked up.</span>
          <button className="icon-btn" aria-label="Dismiss" title="Hide until next time" onClick={() => dismiss(folderKey)}><CloseIcon size={12} /></button>
        </div>
      )}

      {phone && profile && <PushHint onSetup={() => setNotifications(true)} />}

      {profiles === null ? (
        <div className="empty"><span className="spinner" /> Loading boards…</div>
      ) : !profile ? (
        <div className="empty">
          <h2>No boards yet</h2>
          <p>A board runs tickets in one folder, usually a git repo.</p>
          <button className="btn primary" onClick={() => setProfileDialog("new")}>
            Create board
          </button>
        </div>
      ) : (
        phone && phoneTab === "ask" ? (
          <QuickChatPane key={profile.slug} profile={profile} phone onOpenTicket={(id) => openTicket(id)} />
        ) : phone && phoneTab === "now" ? (
          <NowView inbox={inbox} tickets={tickets} slug={profile.slug} onOpen={openFrom} onMarkDone={(i) => void inboxDone(i)} onSnooze={(i) => void inboxSnooze(i, true)} onSwitchBoard={switchBoard} />
        ) : <>
          <div className="board-bar">
            <div className={`search${tagFilter.length ? " has-tags" : ""}`}>
              <SearchIcon className="icon search-icon" />
              {tagFilter.map((g) => (
                <button key={g} className="tag-chip search-tag" style={tagStyle(g)} title={`Stop filtering by ${g}`} aria-label={`Remove tag filter ${g}`}
                  onClick={() => setTagFilter((f) => f.filter((x) => x !== g))}>
                  #{g} <CloseIcon size={9} />
                </button>
              ))}
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tagFilter.length ? "Search" : "Search tickets · #tag"}
                aria-label="Search tickets on this board (#tag filters by tag)" aria-keyshortcuts="/"
                onKeyDown={(e) => {
                  if (e.key === "Escape") { e.preventDefault(); if (query || tagFilter.length) clearSearch(); else e.currentTarget.blur(); }
                  else if (e.key === "Backspace" && !query && tagFilter.length) setTagFilter((f) => f.slice(0, -1));
                }} />
              {query || tagFilter.length ? (
                <button className="search-clear" aria-label="Clear search" title="Clear (Esc)"
                  onMouseDown={(e) => e.preventDefault()} onClick={() => { clearSearch(); searchRef.current?.focus(); }}>
                  <CloseIcon size={12} />
                </button>
              ) : <kbd className="search-kbd" aria-hidden>/</kbd>}
              <KeyHint keys="/" />
            </div>
            <div className="filter-chips" role="group" aria-label="Filter tickets">
              {FILTERS.map((f) => {
                const n = tickets.filter(f.test).length;
                return (
                  <button key={f.id} className={`chip${filters.has(f.id) ? " on" : ""}`} aria-pressed={filters.has(f.id)} onClick={() => toggleFilter(f.id)}>
                    {f.label}{n > 0 && <span className="chip-count">{n}</span>}
                  </button>
                );
              })}
              <TagFilter tickets={tickets} picked={tagFilter} onChange={setTagFilter} />
            </div>
            {filtering && (
              <span className="muted small" aria-live="polite">
                {shownTickets.length} of {tickets.length} ticket{tickets.length === 1 ? "" : "s"}
                {" · "}<button className="link-btn small" onClick={() => { clearSearch(); setFilters(new Set()); }}>Clear all</button>
              </span>
            )}
          </div>
          {sampleFor === profile.slug && (
            <SampleOffer slug={profile.slug} onDismiss={() => setSampleFor(null)}
              onStarted={(t) => {
                setSampleFor(null);
                setTickets((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]));
                openTicket(t.id);
              }} />
          )}
          <Board tickets={shownTickets} filtered={filtering} onOpen={(id) => openTicket(id)} onMove={move} onAdd={() => setNewTicket(true)} restartPending={restart.pending}
            huddles={huddles} onOpenHuddle={openHuddle} slug={slug ?? undefined} onTag={addTagFilter}
            jobs={jobs ?? undefined} onOpenJobs={openSchedules} allTickets={tickets} />
        </>
      )}
      {phone && profile && (
        <PhoneNav tab={phoneTab} onTab={setPhoneTab} needYou={perBoard.get(profile.slug) ?? 0} scheduleAlert={scheduleFails > 0} onSchedules={() => openSchedules()}
          onMore={() => setMoreOpen(true)} moreAlert={mcpAttention > 0} />
      )}
      {moreOpen && <MoreSheet items={menuItems.filter((i) => i.label !== "Schedules" && i.label !== "Keyboard shortcuts")} footer={menuFooter} onClose={() => setMoreOpen(false)}
        top={<UsageBox state={usage} />} />}
      {phoneAccess && <PhoneAccessDialog onClose={() => setPhoneAccess(false)} />}
      {notifications && <NotificationsDialog profile={profile?.slug ?? null} onClose={() => setNotifications(false)} />}

      {dockOpen && profile && (
        <Suspense fallback={null}>
          <Dock profile={profile} pty={health?.pty ?? true} onClose={() => setDockOpen(false)} command={dockCommand}
            onCommandSent={() => setDockCommand(null)} tabRequest={dockTab} onTabChange={setDockShown} onOpenTicket={(id) => openTicket(id)}
            huddles={huddles} onOpenHuddle={openHuddle} openTicket={open ? { id: open.id, title: open.title } : null} onStartHuddle={startHuddle} />
        </Suspense>
      )}

      {connections && (
        <ConnectionsDialog state={mcp} refreshKey={autoTick} onClose={() => setConnections(false)}
          onRunInTerminal={profile && health?.pty !== false ? (cmd) => { setConnections(false); runInTerminal(cmd); } : undefined} />
      )}
      {shortcuts && <ShortcutsDialog onClose={() => setShortcuts(false)} />}
      {bugReport && <BugReportDialog onClose={() => setBugReport(false)} />}
      {boardSwitcher && profiles && (
        <BoardSwitcher profiles={profiles} current={slug} needYou={perBoard} onClose={() => setBoardSwitcher(false)}
          onPick={(s) => { setBoardSwitcher(false); switchBoard(s); }} />
      )}
      {commandBar && (
        <CommandBar profiles={profiles ?? []} current={profile?.slug ?? null} tickets={tickets} needYou={perBoard} actions={commandActions}
          onClose={() => setCommandBar(false)} onSwitchBoard={switchBoard}
          onOpenTicket={(board, id) => {
            if (board !== slug) switchBoard(board);
            openTicket(id, board);
          }} />
      )}
      {schedulesOpen && profile && (
        <SchedulesDialog profile={profile} schedules={schedules} jobs={jobs} jobFilter={jobFilter} onJobFilter={setJobFilter} tickets={tickets} onClose={() => setSchedulesOpen(false)}
          onOpenTicket={(id) => { setSchedulesOpen(false); openTicket(id); }} />
      )}
      {automationsOpen && profile && (
        <AutomationsDialog profile={profile} boards={profiles ?? []} refreshKey={autoTick} onClose={() => setAutomationsOpen(false)}
          onOpenTicket={(id) => { setAutomationsOpen(false); openTicket(id); }}
          onOpenConnections={() => { setAutomationsOpen(false); setConnections(true); }} />
      )}
      {snippetsOpen && profile && <SnippetsDialog profile={profile} onClose={() => setSnippetsOpen(false)} />}
      {open && profile && <TicketDrawer key={open.id} profile={profile} ticket={open} tickets={tickets} onOpenTicket={openTicket} onClose={closeTicket} moveTo={moveTo}
        jobs={jobs ?? []} onOpenJobs={openSchedules}
        nav={{ prev: prevId, next: nextId, go: stepTicket }} slideIn={!stepped.current}
        tabRequest={huddleTab?.id === open.id ? { tab: "huddle", n: huddleTab.n, huddleId: huddleTab.huddleId } : null}
        huddleSeed={huddleSeed?.id === open.id ? { seed: huddleSeed.seed, n: huddleSeed.n } : null}
        onOpenTeam={(r) => { closeTicket(); openDockOn("team", r); }} />}
      {profileDialog && (
        <ProfileDialog
          profile={profileDialog === "edit" ? profile : null}
          onClose={() => setProfileDialog(null)}
          onOpenTeam={() => { setProfileDialog(null); openDockOn("team"); }}
          onSaved={(p) => {
            // The first board gets the sample ticket offer.
            if (profileDialog === "new" && profiles?.length === 0) { setSampleFor(p.slug); setPhoneTab("board"); }
            setProfileDialog(null);
            loadProfiles().then(() => setSlug(p.slug));
          }}
          onDeleted={() => {
            if (sampleFor === profile?.slug) setSampleFor(null);
            setProfileDialog(null);
            setSlug(null);
            loadProfiles();
          }}
        />
      )}
      {newTicket && profile && (
        <NewTicketDialog
          slug={profile.slug}
          folder={profile.path}
          knownTags={boardTags(tickets)}
          onClose={() => setNewTicket(false)}
          onCreate={async (input) => {
            const t = await api.createTicket(profile.slug, input);
            setTickets((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]));
            setNewTicket(false);
            // Planning starts the interview immediately: open the ticket so the questions are in view.
            if (t.status === "planning") openTicket(t.id);
          }}
        />
      )}
      <ParallelConfirm />
      <Toaster />
    </div>
  );
}
