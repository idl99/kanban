import { useEffect, useRef, useState } from "react";
import type { Huddle, Profile } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { FilesView } from "./FilesView";
import { TeamTab, type HuddleSeed, type TeamRequest } from "./Team";
import { CloseIcon, RefreshIcon } from "./icons";
import { QuickChatPane } from "./QuickChat";
import { TerminalView } from "./TerminalView";

export type DockTab = "terminal" | "files" | "claude" | "team";
const TAB_KEY = "ckanban.dock.tab";
/** Each item keeps its own height under `${HEIGHT_KEY}.<item>`; the old shared height seeds them. */
const HEIGHT_KEY = "ckanban.dock.height";
const MIN_HEIGHT = 140;

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export const DOCK_ITEMS: Record<DockTab, { label: string; height: number }> = {
  terminal: { label: "Terminal", height: 280 },
  files: { label: "Files", height: 400 },
  claude: { label: "Claude", height: 380 },
  team: { label: "Team", height: 340 },
};
const isTab = (v: string | null): v is DockTab => !!v && v in DOCK_ITEMS;
/** The item shown when the panel opens without a request: the last one open (the old Huddles tab now lives in Team). */
export function lastDockTab(): DockTab {
  const t = stored(TAB_KEY);
  return t === "huddles" ? "team" : isTab(t) ? t : "terminal";
}

const tildePath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
const clampHeight = (h: number) => Math.round(Math.max(MIN_HEIGHT, Math.min(window.innerHeight - 120, h)));
const storedHeight = (tab: DockTab) => clampHeight(Number(stored(`${HEIGHT_KEY}.${tab}`)) || Number(stored(HEIGHT_KEY)) || DOCK_ITEMS[tab].height);

/**
 * Bottom panel for the selected profile's folder. It shows one item at a time, picked by the header buttons:
 * an interactive shell, a read-only file browser, the quick chats with Claude (no ticket, see QuickChat.tsx)
 * or the Team (teammates, templates, huddles). Hiding an item or the panel never stops it: the shell and
 * Claude's replies keep running on the server.
 */
export default function Dock({ profile, pty, onClose, command, onCommandSent, tabRequest, onTabChange, onOpenTicket, huddles = [], onOpenHuddle, openTicket = null, onStartHuddle }: {
  profile: Profile;
  pty: boolean;
  onClose: () => void;
  /** Typed into the shell and run (e.g. from Connections); `n` changes for each new request. */
  command?: { text: string; n: number } | null;
  onCommandSent?: () => void;
  /** Show this item (e.g. from a header button or shortcut); `n` changes for each new request. team: what the Team shows. */
  tabRequest?: { tab: DockTab; n: number; team?: TeamRequest } | null;
  /** The shown item, so the header buttons can show which one is open. */
  onTabChange?: (tab: DockTab) => void;
  onOpenTicket?: (id: string) => void;
  /** The board's huddles (kept live by the App), for the Team's Huddles view. */
  huddles?: Huddle[];
  /** Open a ticket's Huddle tab; with huddleId, on that huddle (an earlier round). */
  onOpenHuddle?: (ticketId: string, huddleId?: string) => void;
  /** The ticket open in the drawer (the Team's Start huddle goes there). */
  openTicket?: { id: string; title: string } | null;
  /** The Team's Start huddle: a roster with a teammate, or a template. */
  onStartHuddle?: (seed: HuddleSeed) => void;
}) {
  const [tab, setTab] = useState<DockTab>(() => tabRequest?.tab ?? lastDockTab());
  const [heights, setHeights] = useState(() => Object.fromEntries((Object.keys(DOCK_ITEMS) as DockTab[]).map((t) => [t, storedHeight(t)])) as Record<DockTab, number>);
  const height = heights[tab];
  const setHeight = (f: (h: number) => number) => setHeights((hs) => {
    const h = f(hs[tab]);
    store(`${HEIGHT_KEY}.${tab}`, String(h));
    return { ...hs, [tab]: h };
  });
  const [restart, setRestart] = useState(0);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const drag = useRef<{ y: number; h: number } | null>(null);
  // The Team stays mounted once shown, so its editor and selection survive switching items.
  const [teamSeen, setTeamSeen] = useState(false);
  useEffect(() => {
    if (tab === "team") setTeamSeen(true);
  }, [tab]);

  useEffect(() => {
    store(TAB_KEY, tab);
    onTabChange?.(tab);
  }, [tab]);
  useEffect(() => {
    if (command) setTab("terminal");
  }, [command?.n]);
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest?.n]);

  const onHandleKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 120 : 40;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setHeight((h) => clampHeight(h + (e.key === "ArrowUp" ? step : -step)));
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, h: height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const h = clampHeight(drag.current.h + drag.current.y - e.clientY);
    setHeight(() => h);
  };
  const onPointerUp = () => (drag.current = null);

  const label = DOCK_ITEMS[tab].label;
  return (
    <section className="dock" style={{ height }} aria-label={label}>
      <div className="dock-resize" role="separator" aria-orientation="horizontal" aria-label={`Resize ${label} panel`} tabIndex={0}
        aria-valuenow={height} aria-valuemin={MIN_HEIGHT}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onKeyDown={onHandleKey}
        onDoubleClick={() => setHeight(() => clampHeight(DOCK_ITEMS[tab].height))} title={`Drag (or ↑↓) to resize · double-click to reset. ${label} keeps its own height.`} />
      <div className="dock-head">
        <span className="dock-title">{label}</span>
        {tab !== "team" && <span className="dock-path" title={profile.path}>{tildePath(profile.path)}</span>}
        <div className="spacer" />
        {tab === "terminal" && pty && (
          <button className="btn ghost small" onClick={() => setConfirmRestart(true)} title="Kill this shell and start a new one">
            Restart
          </button>
        )}
        {tab === "files" && (
          <button className="btn ghost small icon-label" onClick={() => setRefresh((n) => n + 1)}><RefreshIcon size={12} /> Refresh</button>
        )}
        <button className="icon-btn" onClick={onClose} title={`Hide ${label}. The shell and Claude chats keep running.`} aria-label={`Hide ${label}`}>
          <CloseIcon />
        </button>
      </div>
      <div className="dock-body">
        <div className="dock-pane" hidden={tab !== "terminal"}>
          {pty ? (
            <TerminalView key={profile.slug} slug={profile.slug} active={tab === "terminal"} restartSignal={restart} command={command ?? null} onCommandSent={onCommandSent} />
          ) : (
            <PtyUnsupported />
          )}
        </div>
        <div className="dock-pane" hidden={tab !== "claude"}>
          <QuickChatPane profile={profile} phone={false} onOpenTicket={(id) => onOpenTicket?.(id)} />
        </div>
        <div className="dock-pane" hidden={tab !== "files"}>
          <FilesView key={profile.slug} slug={profile.slug} refreshSignal={refresh} />
        </div>
        <div className="dock-pane" hidden={tab !== "team"}>
          {teamSeen && (
            <TeamTab key={profile.slug} slug={profile.slug} boardName={profile.name} active={tab === "team"} openTicket={openTicket} onOpenHuddle={onOpenHuddle}
              request={tabRequest?.tab === "team" && tabRequest.team ? { ...tabRequest.team, n: tabRequest.n } : null}
              onStartHuddle={(seed) => onStartHuddle?.(seed)} huddles={huddles} />
          )}
        </div>
      </div>
      {confirmRestart && (
        <ConfirmDialog title="Restart the shell?" confirmLabel="Restart" busyLabel="Restarting…"
          onCancel={() => setConfirmRestart(false)} onConfirm={() => { setConfirmRestart(false); setRestart((n) => n + 1); }}>
          <p>Stops whatever is running in this terminal and starts a fresh shell in <code>{tildePath(profile.path)}</code>.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function PtyUnsupported() {
  return (
    <div className="empty small">
      The terminal needs Bun 1.3.5 or newer on the machine running the daemon. Upgrade Bun
      (<code>bun upgrade</code> or <code>brew upgrade bun</code>), then run <code>ckanban restart</code>.
    </div>
  );
}
