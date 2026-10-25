import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, onReconnect, subscribe, type Profile, type QuickChat, type SessionEntry } from "./api";
import { AttachmentChips } from "./AttachmentChips";
import { autoGrow } from "./autoGrow";
import { ConfirmDialog } from "./ConfirmDialog";
import { draftKey } from "./drafts";
import { enterSends } from "./enterSends";
import { ArrowDownIcon, ChatIcon, MoreIcon, PlusIcon, TrashIcon } from "./icons";
import { ImagePickButton } from "./ImagePickButton";
import { useImagePaste } from "./imagePaste";
import { KeyHint } from "./KeyHint";
import { useLayer } from "./layers";
import { expired, handoff as handoffOf, liveView, repeats, saved, withHandoff, type Handoff } from "./liveReply";
import { norm } from "./pendingBubbles";
import { MoreSheet } from "./PhoneNav";
import { fullTime, timeAgo } from "./time";
import { toast } from "./toast";
import { ToolRows } from "./ToolRows";
import { Markdown } from "./Transcript";
import { useNow } from "./useNow";
import { usePersistentState } from "./usePersistentState";

/** The chat each board last had open ("" = a new, empty one), so the Ask tab and the Claude panel reopen it. */
const SELECTED_KEY = "ckanban.chat.";
const readSelected = (slug: string): string | null | undefined => {
  try {
    const v = localStorage.getItem(SELECTED_KEY + slug);
    return v === null ? undefined : v || null;
  } catch {
    return undefined;
  }
};
const writeSelected = (slug: string, id: string | null) => {
  try {
    localStorage.setItem(SELECTED_KEY + slug, id ?? "");
  } catch {}
};

const HANDOFF_RETRY_MS = 500;

/**
 * Quick chats with Claude in the board's folder, no ticket: the phone's Ask tab (full screen, Chats and ⋯ open bottom
 * sheets) and the computer's Claude panel (chat list on the left). The same chats show on both; each runs on the
 * daemon, so a reply keeps going when the page is closed.
 */
export function QuickChatPane({ profile, phone, onOpenTicket }: {
  profile: Profile;
  phone: boolean;
  onOpenTicket: (id: string) => void;
}) {
  const slug = profile.slug;
  const [chats, setChats] = useState<QuickChat[] | null>(null);
  const [selected, setSelected] = useState<string | null | undefined>(() => readSelected(slug));
  // Changes when the user picks a chat (not when a new chat gets its id), so the open thread keeps its state then.
  const [threadKey, setThreadKey] = useState(0);
  const [sheet, setSheet] = useState<"list" | "menu" | null>(null);
  const [renaming, setRenaming] = useState<QuickChat | null>(null);
  const [deleting, setDeleting] = useState<QuickChat | null>(null);
  const [making, setMaking] = useState(false);

  const load = useCallback(() => api.chats(slug).then(setChats).catch((e) => toast(`Couldn't load the chats: ${e.message}`, { tone: "error" })), [slug]);
  useEffect(() => {
    setChats(null);
    setSelected(readSelected(slug));
    setThreadKey((n) => n + 1);
    load();
    return onReconnect(load);
  }, [slug]);
  useEffect(() => subscribe((e) => {
    if (e.type === "chat.updated" && e.profile === slug) {
      setChats((cs) => {
        if (!cs) return cs;
        const rest = cs.filter((c) => c.id !== e.id);
        return e.chat ? [e.chat, ...rest].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : rest;
      });
    } else if (e.type === "chat.activity" && e.profile === slug) {
      setChats((cs) => cs?.map((c) => (c.id === e.id ? { ...c, activity: e.activity } : c)) ?? cs);
    }
  }), [slug]);

  // Not picked yet: the latest chat, unless it became a ticket (then a new one).
  const latest = chats?.[0];
  const currentId = selected === undefined ? (latest && !latest.ticketId ? latest.id : null) : selected;
  const current = currentId ? chats?.find((c) => c.id === currentId) ?? null : null;
  // A picked chat that is gone (deleted elsewhere): fall back to a new one.
  useEffect(() => {
    if (chats && currentId && !current) pick(null);
  }, [chats, currentId, current]);

  const pick = (id: string | null) => {
    setSelected(id);
    writeSelected(slug, id);
    setThreadKey((n) => n + 1);
    setSheet(null);
  };

  const created = (c: QuickChat) => {
    setChats((cs) => [c, ...(cs ?? []).filter((x) => x.id !== c.id)]);
    setSelected(c.id);
    writeSelected(slug, c.id);
  };

  const makeTicket = async (c: QuickChat) => {
    if (making) return;
    setMaking(true);
    try {
      const r = await api.chatTicket(slug, c.id);
      setChats((cs) => cs?.map((x) => (x.id === c.id ? r.chat : x)) ?? cs);
      toast("Ticket made from the chat. It's in Backlog and its chat carries on from here.", { tone: "ok" });
      // The ticket owns that conversation now: a fresh chat here, so two replies never share it.
      pick(null);
      onOpenTicket(r.ticket.id);
    } catch (e: any) {
      toast(`Couldn't make the ticket: ${e.message}`, { tone: "error" });
    } finally {
      setMaking(false);
    }
  };

  const canMake = !!current && current.started && !current.ticketId && !current.running;
  const makeTitle = !current ? "Send Claude a message first" : current.ticketId ? "This chat is already a ticket"
    : current.running ? "Wait for Claude's reply to finish" : !current.started ? "Send Claude a message first"
    : "Turn this chat into a Backlog ticket that carries on the conversation";

  const thread = (
    <ChatThread key={`${slug}:${threadKey}`} slug={slug} chat={current} phone={phone} onCreated={created} onOpenTicket={onOpenTicket} onNew={() => pick(null)} />
  );
  const dialogs = (
    <>
      {renaming && <RenameDialog chat={renaming} onClose={() => setRenaming(null)}
        onSave={async (title) => {
          const c = await api.chatRename(slug, renaming.id, title);
          setChats((cs) => cs?.map((x) => (x.id === c.id ? c : x)) ?? cs);
          setRenaming(null);
        }} />}
      {deleting && (
        <ConfirmDialog title="Delete this chat?" confirmLabel="Delete" busyLabel="Deleting…" onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await api.chatDelete(slug, deleting.id);
            setChats((cs) => cs?.filter((x) => x.id !== deleting.id) ?? cs);
            if (deleting.id === currentId) pick(null);
            setDeleting(null);
          }}>
          <p>Removes <b>{deleting.title}</b> from this board's chats.{deleting.running ? " Claude's reply stops." : ""}{deleting.ticketId ? " The ticket made from it stays." : ""}</p>
        </ConfirmDialog>
      )}
    </>
  );

  if (phone) {
    const items = [
      ...(current && !current.ticketId ? [{ label: making ? "Making ticket…" : "Make ticket from this chat", title: makeTitle, onSelect: () => (canMake ? void makeTicket(current) : toast(makeTitle)) }] : []),
      ...(current?.ticketId ? [{ label: "Open the ticket", onSelect: () => onOpenTicket(current.ticketId!) }] : []),
      { label: "New chat", icon: <PlusIcon size={16} />, onSelect: () => pick(null) },
      ...(current ? [
        { label: "Rename", onSelect: () => setRenaming(current) },
        { label: "Delete chat", icon: <TrashIcon size={16} />, danger: true, onSelect: () => setDeleting(current) },
      ] : []),
    ];
    return (
      <div className="qc qc-phone">
        <div className="qc-head">
          <button className="btn ghost small" onClick={() => setSheet("list")} aria-label="Chats in this folder"><ChatIcon size={14} /> Chats</button>
          <span className="qc-title" title={current?.title}>{current?.title ?? "New chat"}</span>
          <button className="icon-btn qc-more" onClick={() => setSheet("menu")} aria-label="Chat actions"><MoreIcon /></button>
        </div>
        {thread}
        {sheet === "list" && (
          <ChatListSheet chats={chats} currentId={currentId} onPick={pick} onClose={() => setSheet(null)} />
        )}
        {sheet === "menu" && <MoreSheet label="Chat actions" items={items} onClose={() => setSheet(null)} />}
        {dialogs}
      </div>
    );
  }

  return (
    <div className="qc qc-dock">
      <aside className="qc-list" aria-label="Chats in this folder">
        <button className={`qc-row qc-new${currentId === null ? " cur" : ""}`} onClick={() => pick(null)}><PlusIcon size={13} /> New chat</button>
        <ChatRows chats={chats} currentId={currentId} onPick={pick} />
      </aside>
      <section className="qc-main">
        <div className="qc-head">
          <span className="qc-title" title={current?.title}>{current?.title ?? "New chat"}</span>
          {current?.ticketId && <button className="link-btn small" onClick={() => onOpenTicket(current.ticketId!)}>Open the ticket</button>}
          <div className="spacer" />
          {current && !current.ticketId && (
            <button className="btn ghost small" onClick={() => makeTicket(current)} disabled={!canMake || making} title={makeTitle}>
              {making ? "Making ticket…" : "Make ticket"}
            </button>
          )}
          {current && <button className="btn ghost small" onClick={() => setRenaming(current)}>Rename</button>}
          {current && <button className="btn ghost small" onClick={() => setDeleting(current)} title="Delete this chat">Delete</button>}
        </div>
        {thread}
      </section>
      {dialogs}
    </div>
  );
}

function ChatRows({ chats, currentId, onPick }: { chats: QuickChat[] | null; currentId: string | null; onPick: (id: string) => void }) {
  useNow();
  if (chats === null) return <div className="muted small qc-list-note"><span className="spinner" /> Loading…</div>;
  if (!chats.length) return <div className="muted small qc-list-note">No chats yet. Ask Claude anything about this folder.</div>;
  return (
    <>
      {chats.map((c) => (
        <button key={c.id} className={`qc-row${c.id === currentId ? " cur" : ""}`} onClick={() => onPick(c.id)} title={c.title}>
          <span className="qc-row-title">{c.running && <span className="spinner" />}{c.title}</span>
          <span className="qc-row-meta">
            <time dateTime={c.updatedAt} title={fullTime(c.updatedAt)}>{timeAgo(c.updatedAt)}</time>
            {c.ticketId && <span className="qc-tag">made ticket</span>}
            {c.error && !c.running && <span className="qc-tag err">failed</span>}
          </span>
        </button>
      ))}
    </>
  );
}

/** Phone: the chat list as a bottom sheet. */
function ChatListSheet({ chats, currentId, onPick, onClose }: {
  chats: QuickChat[] | null; currentId: string | null; onPick: (id: string | null) => void; onClose: () => void;
}) {
  useLayer(onClose);
  return (
    <div className="sheet-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet qc-sheet" role="dialog" aria-label="Chats in this folder">
        <span className="sheet-grip" aria-hidden />
        <div className="qc-sheet-head">Chats in this folder</div>
        <button className="sheet-item qc-sheet-new" onClick={() => onPick(null)}><PlusIcon size={16} /><span className="sheet-label">New chat</span></button>
        <ChatRows chats={chats} currentId={currentId} onPick={onPick} />
      </div>
    </div>
  );
}

function RenameDialog({ chat, onSave, onClose }: { chat: QuickChat; onSave: (title: string) => Promise<void>; onClose: () => void }) {
  const [title, setTitle] = useState(chat.renamed ? chat.title : "");
  return (
    <ConfirmDialog title="Rename chat" confirmLabel="Save" busyLabel="Saving…" tone="primary" onCancel={onClose} onConfirm={() => onSave(title)}>
      <input autoFocus value={title} maxLength={80} placeholder={chat.title} aria-label="Chat name"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSave(title).catch((err) => toast(`Couldn't rename: ${err.message}`, { tone: "error" }));
          }
        }} />
      <p className="muted small">Leave it empty to name it after the first message.</p>
    </ConfirmDialog>
  );
}

/** A run of tool calls folded into one line, or one message. */
type Block = { kind: "entry"; e: SessionEntry } | { kind: "tools"; items: SessionEntry[] };

function group(entries: SessionEntry[]): Block[] {
  const out: Block[] = [];
  for (const e of entries) {
    if (e.kind === "tool" || e.kind === "agent") {
      const prev = out.at(-1);
      if (prev?.kind === "tools") prev.items.push(e);
      else out.push({ kind: "tools", items: [e] });
    } else if (e.text || e.kind === "board") out.push({ kind: "entry", e });
  }
  return out;
}

const delivered = (entries: SessionEntry[], text: string) => entries.some((e) => e.role === "user" && norm(e.text) === norm(text));

/** One chat's conversation and message box (chat null: a new chat, made by its first message). */
function ChatThread({ slug, chat, phone, onCreated, onOpenTicket, onNew }: {
  slug: string;
  chat: QuickChat | null;
  phone: boolean;
  onCreated: (c: QuickChat) => void;
  onOpenTicket: (id: string) => void;
  onNew: () => void;
}) {
  const id = chat?.id ?? null;
  const [page, setPage] = useState<{ entries: SessionEntry[]; start: number } | null>(id ? null : { entries: [], start: 0 });
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [pending, setPending] = useState<{ text: string; steer: boolean }[]>([]);
  const [live, setLive] = useState("");
  const liveRef = useRef("");
  liveRef.current = live;
  const [handoff, setHandoff] = useState<Handoff[]>([]);
  const entriesRef = useRef<SessionEntry[]>([]);
  const [draft, setDraft] = usePersistentState(draftKey(slug, `chat-${id ?? "new"}`), () => "", (v) => !v.trim(), (v) => typeof v === "string");
  const images = useImagePaste(setDraft);
  const composer = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const keepOffset = useRef<number | null>(null);
  const [jump, setJump] = useState<{ fresh: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const running = !!chat?.running;
  const endedAt = useRef<number | null>(running ? null : Date.now());
  const tailSeq = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useNow();

  const loadTail = useCallback(async () => {
    if (!id) return null;
    const seq = ++tailSeq.current;
    const r = await api.chatConversation(slug, id);
    if (seq !== tailSeq.current) return null;
    setPage((prev) => {
      if (!prev || r.start <= prev.start) return { entries: r.entries, start: r.start };
      const idx = prev.entries.findIndex((e) => e.uuid === r.entries[0]?.uuid);
      return idx >= 0 ? { entries: [...prev.entries.slice(0, idx), ...r.entries], start: prev.start } : { entries: r.entries, start: r.start };
    });
    return r.entries;
  }, [slug, id]);
  useEffect(() => {
    loadTail().catch(() => setPage((p) => p ?? { entries: [], start: 0 }));
  }, [loadTail]);
  useEffect(() => (id ? onReconnect(() => void loadTail().catch(() => {})) : undefined), [id, loadTail]);
  useLayoutEffect(() => autoGrow(composer.current), [draft, phone]);

  useEffect(() => subscribe((e) => {
    if (!id || (e.type !== "chat.draft" && e.type !== "chat.activity" && e.type !== "chat.updated") || e.profile !== slug || e.id !== id) return;
    if (e.type === "chat.draft") {
      if (e.text) return setLive(e.text);
      const finished = e.final || liveRef.current;
      if (finished) setHandoff((hs) => withHandoff(hs, handoffOf(finished, entriesRef.current.length)));
      setLive("");
      loadTail().catch(() => {});
      return;
    }
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      loadTail().catch(() => {});
    }, 500);
  }), [slug, id, loadTail]);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  // The reply ended: pick up the saved copy; a message Claude never read (Stop) can't arrive any more.
  useEffect(() => {
    endedAt.current = running ? null : Date.now();
    if (running) return;
    setStopping(false);
    if (liveRef.current) {
      const h = handoffOf(liveRef.current, entriesRef.current.length);
      setHandoff((hs) => withHandoff(hs, h));
      setLive("");
    }
    if (!id) return;
    loadTail().then((tail) => {
      if (tail) setPending((ps) => ps.filter((p) => !delivered(tail, p.text) && !p.steer));
    }).catch(() => {});
  }, [running]);

  const entries = page?.entries ?? [];
  entriesRef.current = entries;
  const waitingHandoff = useMemo(() => handoff.filter((h) => !saved(entries, h)), [handoff, entries]);
  useEffect(() => {
    if (waitingHandoff.length !== handoff.length) setHandoff(waitingHandoff);
  }, [waitingHandoff, handoff]);
  const handingOff = handoff.length > 0;
  useEffect(() => {
    if (!handingOff) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setHandoff((hs) => (hs.some((h) => expired(h, now, endedAt.current)) ? hs.filter((h) => !expired(h, now, endedAt.current)) : hs));
      loadTail().catch(() => {});
    }, HANDOFF_RETRY_MS);
    return () => clearInterval(timer);
  }, [handingOff, loadTail]);
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
  }, [page, pending, running, live, waitingHandoff]);

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setJump(null);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || images.uploading) return;
    images.clearError();
    stickToBottom.current = true;
    setPending((ps) => [...ps, { text, steer: running }]);
    setDraft("");
    setSending(true);
    try {
      const c = id ? await api.chatSend(slug, id, text) : await api.newChat(slug, text);
      if (!id) onCreated(c);
    } catch (e: any) {
      setPending((ps) => ps.filter((p) => p.text !== text));
      setDraft(text);
      toast(e.message, { tone: "error" });
    } finally {
      setSending(false);
      composer.current?.focus();
    }
  };

  const stop = () => {
    if (!id) return;
    setStopping(true);
    api.chatStop(slug, id).catch((e) => {
      setStopping(false);
      toast(e.message, { tone: "error" });
    });
  };

  const loadEarlier = async () => {
    if (!id || !page || page.start === 0) return;
    setLoadingEarlier(true);
    try {
      const r = await api.chatConversation(slug, id, page.start);
      keepOffset.current = scroller.current ? scroller.current.scrollHeight - scroller.current.scrollTop : null;
      setPage((prev) => ({ entries: [...r.entries, ...(prev?.entries ?? [])], start: r.start }));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const loadTool = (toolUseId: string) => api.chatTool(slug, id!, toolUseId);
  const onScreen = [...waitingHandoff.map((h) => h.text), entries.findLast((e) => e.role === "assistant" && e.kind === "text")?.text ?? ""];
  const activity = chat?.activity && chat.activity !== "Starting…" && !repeats(chat.activity, onScreen) ? chat.activity : null;
  const empty = page !== null && !entries.length && !pending.length && !running && !live;
  const closed = !!chat?.ticketId;

  return (
    <div className="chat qc-thread">
      <div className="chat-log" ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          stickToBottom.current = gap < 60;
          if (gap < 60) setJump(null);
          else if (gap > 240) setJump((j) => j ?? { fresh: false });
        }}>
        {page === null && <div className="muted"><span className="spinner" /> Loading the conversation…</div>}
        {page && page.start > 0 && (
          <button className="btn ghost small load-earlier" onClick={loadEarlier} disabled={loadingEarlier}>
            {loadingEarlier ? "Loading…" : `Load earlier (${page.start} more)`}
          </button>
        )}
        {empty && (
          <div className="qc-empty">
            <p><b>Ask Claude about this folder.</b> No ticket needed. Claude can read and change files and run commands here, and knows this board.</p>
            <p className="muted small">Chats are kept: open Chats to go back to one. Make ticket turns a chat into a ticket.</p>
          </div>
        )}
        {group(entries).map((b) => {
          if (b.kind === "tools") {
            return (
              <details key={b.items[0].uuid} className="conv-tools">
                <summary>{b.items.length === 1 ? b.items[0].text : `${b.items.length} tool calls · ${b.items.at(-1)!.text}`}</summary>
                <ToolRows slug={slug} ticketId={`chat:${id}`} live={running} load={loadTool}
                  items={b.items.map((t) => ({ key: t.uuid, label: t.text, toolUseId: t.toolUseId ?? t.agent?.toolUseId, error: t.error }))} />
              </details>
            );
          }
          const e = b.e;
          if (e.kind === "board") return <div key={e.uuid} className="chat-note">{e.text}</div>;
          return (
            <div key={e.uuid} className={`conv-msg ${e.role}${e.commandOutput ? " command-output" : ""}`}>
              <div className="conv-head">
                <b>{e.role === "user" ? "You" : "Claude"}</b>
                {e.at && <time className="muted small" dateTime={e.at} title={fullTime(e.at)}>{timeAgo(e.at)}</time>}
              </div>
              <Markdown text={e.text} />
            </div>
          );
        })}
        {pending.filter((p) => !p.steer).map((p, i) => (
          <div key={i} className="conv-msg user"><Markdown text={p.text} /></div>
        ))}
        {waitingHandoff.map((h) => (
          <div key={h.at} className="conv-msg assistant live">
            <div className="conv-head"><b>Claude</b></div>
            {liveView(h.text).text && <Markdown text={liveView(h.text).text} />}
          </div>
        ))}
        {live && (
          <div className="conv-msg assistant live" aria-live="polite">
            <div className="conv-head"><b>Claude</b><span className="muted small">writing…</span></div>
            {liveView(live).text && <Markdown text={liveView(live).text} />}
          </div>
        )}
        {running && !live && (
          <div className="chat-typing"><span className="spinner" /> <span>{stopping ? "Stopping…" : activity ?? "Claude is working…"}</span></div>
        )}
        {pending.filter((p) => p.steer).map((p, i) => (
          <div key={i} className="conv-msg user pending">
            <div className="conv-head"><b>You</b><span className="muted small">sent · Claude reads it at its next step</span></div>
            <Markdown text={p.text} />
          </div>
        ))}
        {!!chat?.waiting && !running && (
          <div className="chat-note">{chat.waiting === 1 ? "Your message goes" : `${chat.waiting} messages go`} to Claude once the board has restarted.</div>
        )}
        {chat?.error && !running && <div className="banner error inline"><pre>{chat.error}</pre></div>}
        {closed && (
          <div className="banner info inline qc-closed" role="status">
            <span>This chat became a ticket. The conversation carries on in the ticket's chat.</span>
            <span className="qc-closed-actions">
              <button className="btn small" onClick={() => onOpenTicket(chat!.ticketId!)}>Open the ticket</button>
              <button className="btn ghost small" onClick={onNew}>New chat</button>
            </span>
          </div>
        )}
        {jump && (
          <button className={`jump-latest${jump.fresh ? " fresh" : ""}`} onClick={toBottom}>
            <ArrowDownIcon size={12} /> {jump.fresh ? "New messages" : "Jump to latest"}
          </button>
        )}
      </div>
      {!closed && (
        <div className="composer">
          <textarea ref={composer} rows={phone ? 1 : 2} value={draft} className={images.dragOver ? "drop-target" : undefined} {...images.handlers}
            placeholder={running ? "Add to your question: Claude reads it at its next step…" : phone ? "Ask Claude about this folder…" : "Ask Claude about this folder… (Enter sends)"}
            aria-label="Message to Claude"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (enterSends(e)) {
                e.preventDefault();
                send();
              }
            }} />
          <AttachmentChips text={draft} images={images} />
          {images.error && <div className="form-error">{images.error}</div>}
          <div className="composer-foot">
            <span className="muted small composer-hint">
              Claude works in this board's folder.<span className="composer-keys"> Enter to send · Shift+Enter for a new line</span>
            </span>
            <span className="composer-actions">
              <ImagePickButton images={images} target={composer} />
              {running && <button className="btn danger small" disabled={stopping} onClick={stop}>{stopping ? "Stopping…" : "Stop"}</button>}
              <button className="btn primary small" disabled={!draft.trim() || sending || images.uploading} onClick={send}>
                {images.uploading ? "Uploading…" : "Send"}<KeyHint keys="↵" />
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
