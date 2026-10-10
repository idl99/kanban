import { useEffect, useRef, useState } from "react";
import { api, type Huddle, type Profile, type QuickChat } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { FilesView } from "./FilesView";
import { TeamTab, type HuddleSeed, type TeamRequest } from "./Team";
import { brakeLabel, guestTickets, huddleCost, huddleTitle, members, quietLabel, roundTag, sortHuddles } from "./huddle";
import { CloseIcon, RefreshIcon } from "./icons";
import { TerminalView } from "./TerminalView";
import { fullTime, timeAgo } from "./time";
import { useNow } from "./useNow";
import { toast } from "./toast";
import { costText } from "./usage";

export type DockTab = "terminal" | "files" | "claude" | "huddles" | "team";
const TAB_KEY = "ckanban.dock.tab";
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

const TABS: [DockTab, string][] = [["terminal", "Terminal"], ["files", "Files"], ["claude", "Claude"], ["huddles", "Huddles"], ["team", "Team"]];
const isTab = (v: string | null): v is DockTab => TABS.some(([t]) => t === v);

const clampHeight = (h: number) => Math.round(Math.max(MIN_HEIGHT, Math.min(window.innerHeight - 120, h)));

/**
 * Bottom panel for the selected profile's folder: an interactive shell, a read-only file browser and a
 * quick Claude chat (interactive `claude`, no ticket). Closing it only hides it; the shell and the chat
 * keep running on the server and reattach next time.
 */
export default function Dock({ profile, pty, onClose, command, onCommandSent, tabRequest, onTabChange, onOpenTicket, huddles = [], onOpenHuddle, openTicket = null, onStartHuddle }: {
  profile: Profile;
  pty: boolean;
  onClose: () => void;
  /** Typed into the shell and run (e.g. from Connections); `n` changes for each new request. */
  command?: { text: string; n: number } | null;
  onCommandSent?: () => void;
  /** Switch to this tab (e.g. from a shortcut); `n` changes for each new request. team: what the Team tab shows. */
  tabRequest?: { tab: DockTab; n: number; team?: TeamRequest } | null;
  /** The visible tab, so the header buttons can show which one is open. */
  onTabChange?: (tab: DockTab) => void;
  onOpenTicket?: (id: string) => void;
  /** The board's huddles (kept live by the App), for the Huddles tab. */
  huddles?: Huddle[];
  /** Open a ticket's Huddle tab. */
  /** Open a ticket's Huddle tab; with huddleId, on that huddle (an earlier round). */
  onOpenHuddle?: (ticketId: string, huddleId?: string) => void;
  /** The ticket open in the drawer (the Team tab's Start huddle goes there). */
  openTicket?: { id: string; title: string } | null;
  /** The Team tab's Start huddle: a roster with a teammate, or a template. */
  onStartHuddle?: (seed: HuddleSeed) => void;
}) {
  const [tab, setTab] = useState<DockTab>(() => {
    const t = stored(TAB_KEY);
    return isTab(t) ? t : "terminal";
  });
  const [height, setHeight] = useState(() => clampHeight(Number(stored(HEIGHT_KEY)) || 320));
  const [restart, setRestart] = useState(0);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [chatRestart, setChatRestart] = useState(0);
  const [confirmNewChat, setConfirmNewChat] = useState(false);
  const [chat, setChat] = useState<QuickChat | null>(null);
  const [makingTicket, setMakingTicket] = useState(false);
  const drag = useRef<{ y: number; h: number } | null>(null);
  const liveCount = huddles.filter((h) => h.status === "live").length;
  // The Team tab stays mounted once shown, so its editor and selection survive switching tabs.
  const [teamSeen, setTeamSeen] = useState(false);
  useEffect(() => {
    if (tab === "team") setTeamSeen(true);
  }, [tab]);

  useEffect(() => {
    store(TAB_KEY, tab);
    onTabChange?.(tab);
  }, [tab]);
  useEffect(() => store(HEIGHT_KEY, String(height)), [height]);
  useEffect(() => {
    if (command) setTab("terminal");
  }, [command?.n]);
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest?.n]);

  // Make ticket needs the chat's session file, which appears after the first message: poll while visible.
  const loadChat = () => api.quickChat(profile.slug).then(setChat).catch(() => setChat(null));
  useEffect(() => {
    setChat(null);
    if (tab !== "claude" || !pty) return;
    loadChat();
    const timer = setInterval(loadChat, 3000);
    return () => clearInterval(timer);
  }, [tab, profile.slug, pty, chatRestart]);

  const makeTicket = async () => {
    if (!chat?.sessionId || !chat.started) return;
    setMakingTicket(true);
    try {
      const title = chat.title?.trim() || `Quick chat ${new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
      const t = await api.createTicket(profile.slug, {
        title, body: "Started from a quick Claude chat in the dock.", status: "backlog", sessionId: chat.sessionId,
      });
      // The ticket owns that session now; give the dock a fresh one so two `claude`s never share a session file.
      setChatRestart((n) => n + 1);
      toast("Ticket created from the chat");
      onOpenTicket?.(t.id);
    } catch (e) {
      toast(`Couldn't create the ticket: ${(e as Error).message}`, { tone: "error" });
    } finally {
      setMakingTicket(false);
    }
  };

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
    if (drag.current) setHeight(clampHeight(drag.current.h + drag.current.y - e.clientY));
  };
  const onPointerUp = () => (drag.current = null);

  return (
    <section className="dock" style={{ height }} aria-label="Terminal, files and team">
      <div className="dock-resize" role="separator" aria-orientation="horizontal" aria-label="Resize panel" tabIndex={0}
        aria-valuenow={height} aria-valuemin={MIN_HEIGHT}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onKeyDown={onHandleKey}
        onDoubleClick={() => setHeight(clampHeight(320))} title="Drag (or ↑↓) to resize · double-click to reset" />
      <div className="dock-head">
        <div className="tabs" role="tablist" aria-label="Panel">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              {label}
              {id === "huddles" && liveCount > 0 && <span className="tab-count ok" title={`${liveCount} live`}>{liveCount} live</span>}
            </button>
          ))}
        </div>
        <span className="dock-path" title={profile.path}>{profile.path.replace(/^\/Users\/[^/]+/, "~")}</span>
        <div className="spacer" />
        {tab === "terminal" && pty && (
          <button className="btn ghost small" onClick={() => setConfirmRestart(true)} title="Kill this shell and start a new one">
            Restart
          </button>
        )}
        {tab === "claude" && pty && (
          <>
            <button className="btn ghost small" onClick={makeTicket} disabled={!chat?.started || makingTicket}
              title={chat?.started ? "Turn this chat into a Backlog ticket (the dock starts a fresh chat)" : "Send Claude a message first"}>
              {makingTicket ? "Creating…" : "Make ticket"}
            </button>
            <button className="btn ghost small" onClick={() => setConfirmNewChat(true)} title="End this chat and start an empty one">
              New chat
            </button>
          </>
        )}
        {tab === "files" && (
          <button className="btn ghost small icon-label" onClick={() => setRefresh((n) => n + 1)}><RefreshIcon size={12} /> Refresh</button>
        )}
        <button className="icon-btn" onClick={onClose} title="Hide panel (Ctrl+`). The shell and Claude chat keep running." aria-label="Hide terminal and files panel">
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
          {pty ? (
            <TerminalView key={profile.slug} slug={profile.slug} kind="claude" active={tab === "claude"} restartSignal={chatRestart} command={null} />
          ) : (
            <PtyUnsupported />
          )}
        </div>
        <div className="dock-pane" hidden={tab !== "files"}>
          <FilesView key={profile.slug} slug={profile.slug} refreshSignal={refresh} />
        </div>
        <div className="dock-pane" hidden={tab !== "huddles"}>
          {tab === "huddles" && <HuddleList huddles={huddles} onOpen={onOpenHuddle} />}
        </div>
        <div className="dock-pane" hidden={tab !== "team"}>
          {teamSeen && (
            <TeamTab key={profile.slug} slug={profile.slug} boardName={profile.name} active={tab === "team"} openTicket={openTicket} onOpenHuddle={onOpenHuddle}
              request={tabRequest?.tab === "team" && tabRequest.team ? { ...tabRequest.team, n: tabRequest.n } : null}
              onStartHuddle={(seed) => onStartHuddle?.(seed)} />
          )}
        </div>
      </div>
      {confirmNewChat && (
        <ConfirmDialog title="Start a new chat?" confirmLabel="New chat" busyLabel="Starting…"
          onCancel={() => setConfirmNewChat(false)} onConfirm={() => { setConfirmNewChat(false); setChatRestart((n) => n + 1); }}>
          <p>Ends the current Claude chat and starts an empty one. The old conversation stays in Claude Code's history.</p>
        </ConfirmDialog>
      )}
      {confirmRestart && (
        <ConfirmDialog title="Restart the shell?" confirmLabel="Restart" busyLabel="Restarting…"
          onCancel={() => setConfirmRestart(false)} onConfirm={() => { setConfirmRestart(false); setRestart((n) => n + 1); }}>
          <p>Stops whatever is running in this terminal and starts a fresh shell in <code>{profile.path.replace(/^\/Users\/[^/]+/, "~")}</code>.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/** The Huddles tab: live and recent huddles on this board; a row opens that huddle in its host ticket's Huddle tab. */
function HuddleList({ huddles, onOpen }: { huddles: Huddle[]; onOpen?: (ticketId: string, huddleId: string) => void }) {
  const now = useNow();
  const list = sortHuddles(huddles);
  if (!list.length) {
    return <div className="dock-huddles"><div className="empty">No huddles on this board yet. Start one from a ticket's Huddle tab.</div></div>;
  }
  return (
    <div className="dock-huddles" role="list">
      {list.map((h) => {
        const agents = members(h).length;
        const tickets = 1 + guestTickets(h).length;
        const brake = brakeLabel(h);
        const quiet = quietLabel(h, now);
        const failed = members(h).filter((p) => p.status === "failed").length;
        const forYou = h.status === "closed" ? 0 : h.forYou ?? 0;
        const host = h.hostTitle ?? h.hostTicket;
        const round = roundTag(huddles, h);
        return (
          <button key={h.id} role="listitem" className={`huddle-row ${h.status}${brake ? " brake" : quiet ? " quiet" : ""}`} onClick={() => onOpen?.(h.hostTicket, h.id)}
            title={`Open ${round ? `${round.toLowerCase()} of ` : ""}the huddle of ${host}: ${huddleTitle(h)} · started ${fullTime(h.createdAt)}`}>
            <span className="hr-dot" aria-label={brake ?? (quiet ? "quiet" : h.status)} />
            <span className="hr-title">{host}{round && <span className="hr-round"> · {round}</span>}</span>
            <span className="hr-flags">
              {brake && <span className="hr-brake">Huddle · {brake}</span>}
              {quiet && <span className="hr-quiet">all quiet · {quiet}</span>}
              {failed > 0 && <span className="hb-failed">{failed} failed</span>}
              {forYou > 0 && <span className="for-you-pill">{forYou} for you</span>}
            </span>
            <span className="hr-meta">
              {agents} {agents === 1 ? "agent" : "agents"} · {h.status === "closed" ? "closed" : `${tickets} ${tickets === 1 ? "ticket" : "tickets"}`}
            </span>
            <time className="hr-meta" dateTime={h.updatedAt} title={`Last activity ${fullTime(h.updatedAt)} · ${h.seq} ${h.seq === 1 ? "message" : "messages"}`}>
              {h.status === "live" ? `last msg ${timeAgo(h.updatedAt)}` : timeAgo(h.updatedAt)}
            </time>
            <span className="hr-meta" title="What the huddle's agents have spent">{costText(huddleCost(h))}</span>
          </button>
        );
      })}
    </div>
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
