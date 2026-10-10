import {
  closestCenter, DndContext, pointerWithin, DragOverlay, KeyboardSensor, PointerSensor, rectIntersection, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragStartEvent, type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useMemo, useState } from "react";
import { BOARD_COLUMNS, type Huddle, type Status, type Ticket } from "./api";
import { Card } from "./Card";
import { groupByColumn } from "./columns";
import { cardHuddleBadge } from "./huddleText";
import { CollapseIcon, PlusIcon, SparkIcon } from "./icons";
import { useNow } from "./useNow";
import { toast } from "./toast";

const COLLAPSED_KEY = "ckanban.collapsedColumns";

function readCollapsed(): Set<Status> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

interface Props {
  tickets: Ticket[];
  onOpen: (id: string) => void;
  onMove: (id: string, status: Status, order: number) => void;
  onAdd: (status: Status) => void;
  /** A pending daemon restart holds queued tickets. */
  restartPending?: boolean;
  /** A search or filter is active (empty columns say "no match" instead of the usual hint). */
  filtered?: boolean;
  /** The board's huddles, for the card badges. */
  huddles?: Huddle[];
  /** Open a ticket's Huddle tab (a card's huddle badge). */
  onOpenHuddle?: (id: string) => void;
  /** The board's slug: cards waiting on the usage limit get "Continue now" and the auto-continue toggle. */
  slug?: string;
}

/** Card props shared down the columns. */
interface CardCtx { huddles: Huddle[]; onOpenHuddle?: (id: string) => void; limit?: { slug: string; onError: (msg: string) => void } }

/** Drag with the mouse, or focus a card: Enter opens it, Space picks it up (arrows move, Space drops, Esc cancels). */
function SortableCard({ ticket, onOpen, queued, held, ctx }: { ticket: Ticket; onOpen: (id: string) => void; queued?: number; held?: boolean; ctx: CardCtx }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    data: { status: ticket.status },
  });
  // The quiet badge's "idle 12m" ticks.
  const now = useNow();
  return (
    <div
      ref={setNodeRef}
      className="sortable-card"
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
      {...attributes}
      {...listeners}
      aria-label={ticket.title}
      data-ticket={ticket.id}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen(ticket.id);
          return;
        }
        listeners?.onKeyDown?.(e);
      }}
    >
      <Card ticket={ticket} onClick={() => onOpen(ticket.id)} queued={queued} held={held}
        huddle={cardHuddleBadge(ctx.huddles, ticket.id, now)} onOpenHuddle={ctx.onOpenHuddle} limit={ctx.limit} />
    </div>
  );
}

const EMPTY_HINT: Record<Status, string> = {
  backlog: "No parked ideas. Press N or + to add one.",
  planning: "Drop a card here and Claude starts interviewing you",
  ready: "Drop a card here and Claude starts working on it",
  in_progress: "Drop a card here and Claude starts working on it (queued if all slots are busy)",
  review: "Finished work lands here for you to check",
  done: "Nothing finished yet",
};

const DONE_LIMIT = 10;
const CLAUDE_TAG = "Claude starts automatically when a card is here";

function Column({ id, label, hint, claude, tickets, queue = [], held = false, onOpen, onAdd, collapsed, onCollapse, filtered, ctx }: {
  id: Status; label: string; hint: string; claude: boolean; tickets: Ticket[];
  /** In Progress only: tickets waiting for a free run slot, in start order. */
  queue?: Ticket[];
  /** A pending daemon restart holds the queue. */
  held?: boolean;
  onOpen: (id: string) => void; onAdd: (s: Status) => void;
  collapsed: boolean; onCollapse: (v: boolean) => void; filtered: boolean; ctx: CardCtx;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${id}`, data: { status: id } });
  const all = [...tickets, ...queue];
  const needYou = all.filter((t) => t.attention).length;
  const total = `${all.length} ${all.length === 1 ? "ticket" : "tickets"}${queue.length ? `, ${queue.length} queued` : ""}`;
  const countLabel = needYou > 0 ? `${total}, ${needYou} ${needYou === 1 ? "needs" : "need"} you` : total;
  const canAdd = id !== "in_progress" && id !== "done";
  // Done keeps growing: show the most recently finished cards unless expanded.
  const [showAll, setShowAll] = useState(false);
  const limited = id === "done" && !showAll && tickets.length > DONE_LIMIT;
  const shown = limited ? tickets.slice(0, DONE_LIMIT) : tickets;
  const countBadge = <span className={`count ${needYou > 0 ? "needs-you" : ""}`} title={countLabel} aria-label={countLabel}>{all.length}</span>;
  if (collapsed) {
    // Narrow strip: still a drop target; click to expand.
    return (
      <section ref={setNodeRef} className={`column collapsed col-${id} ${claude ? "claude-zone" : ""} ${isOver ? "over" : ""}`}>
        <button className="column-strip" onClick={() => onCollapse(false)} title={`Expand ${label}`} aria-label={`Expand ${label}, ${countLabel}`}>
          {countBadge}
          <span className="column-strip-title">{label}</span>
        </button>
      </section>
    );
  }
  return (
    <section className={`column col-${id} ${claude ? "claude-zone" : ""} ${isOver ? "over" : ""}`} aria-label={label}>
      <header className="column-head">
        <span className="column-title">{label}</span>
        {/* One badge: total count, turning amber with a dot while tickets wait on you. */}
        {countBadge}
        {claude && <span className="claude-tag" title={CLAUDE_TAG} aria-label={CLAUDE_TAG}><SparkIcon /></span>}
        <span className="spacer" />
        <button className="icon-btn tiny column-collapse" title={`Collapse ${label}`} aria-label={`Collapse ${label}`} onClick={() => onCollapse(true)}>
          <CollapseIcon />
        </button>
        {canAdd ? (
          <button className="icon-btn" title={`Add to ${label}`} aria-label={`Add ticket to ${label}`} onClick={() => onAdd(id)}><PlusIcon /></button>
        ) : <span className="icon-btn-placeholder" aria-hidden />}
      </header>
      <div className="column-hint">{hint}</div>
      <SortableContext items={[...shown, ...queue].map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="column-body">
          {shown.map((t) => (
            <SortableCard key={t.id} ticket={t} onOpen={onOpen} ctx={ctx} />
          ))}
          {queue.length > 0 && <div className="queue-sep" title="These start in this order as run slots free up">Queued</div>}
          {queue.map((t, i) => (
            <SortableCard key={t.id} ticket={t} onOpen={onOpen} queued={i + 1} held={held} ctx={ctx} />
          ))}
          {id === "done" && tickets.length > DONE_LIMIT && (
            <button className="btn ghost small show-all" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show all ${tickets.length}`}
            </button>
          )}
          {all.length === 0 && (
            <div className={claude ? "column-drop-hint" : "column-empty"}>{filtered ? "No matching tickets" : EMPTY_HINT[id]}</div>
          )}
        </div>
      </SortableContext>
    </section>
  );
}

// Keyboard: ←/→ jump to the next column (top of its list), ↑/↓ move within the column.
const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  if (event.code !== "ArrowLeft" && event.code !== "ArrowRight") return sortableKeyboardCoordinates(event, args);
  const rect = args.context.collisionRect;
  if (!rect) return undefined;
  const cols = [...document.querySelectorAll<HTMLElement>(".board > .column")].map((c) => c.getBoundingClientRect());
  const mid = rect.left + rect.width / 2;
  const at = cols.findIndex((c) => mid >= c.left && mid <= c.right);
  const next = cols[at + (event.code === "ArrowRight" ? 1 : -1)];
  if (at < 0 || !next) return undefined;
  event.preventDefault();
  return { x: next.left + (next.width - rect.width) / 2, y: next.top + 70 };
};

// Prefer whatever is under the pointer (a card beats its column); fall back to nearest card.
const collision: CollisionDetection = (args) => {
  // Keyboard drags have no pointer: take what the moved card overlaps most (a card, else the column).
  if (!args.pointerCoordinates) {
    const overlap = rectIntersection(args);
    if (overlap.length) return [overlap[0]];
    return closestCenter(args);
  }
  const hits = pointerWithin(args);
  if (hits.length) {
    const card = hits.find((h) => !String(h.id).startsWith("col:"));
    return [card ?? hits[0]];
  }
  return closestCenter(args);
};

const NO_HUDDLES: Huddle[] = [];

export function Board({ tickets, onOpen, onMove, onAdd, filtered = false, restartPending = false, huddles = NO_HUDDLES, onOpenHuddle, slug }: Props) {
  const ctx = useMemo(() => ({
    huddles, onOpenHuddle, limit: slug ? { slug, onError: (msg: string) => toast(msg, { tone: "error" }) } : undefined,
  }), [huddles, onOpenHuddle, slug]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Enter is kept for opening the card, so only Space picks up / drops.
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );
  const [dragId, setDragId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {}
  }, [collapsed]);
  const setColumnCollapsed = (id: Status, v: boolean) => setCollapsed((s) => {
    const next = new Set(s);
    if (v) next.add(id);
    else next.delete(id);
    return next;
  });

  const byColumn = useMemo(() => groupByColumn(tickets), [tickets]);

  const onDragStart = (e: DragStartEvent) => setDragId(String(e.active.id));

  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const { active, over } = e;
    if (!over) return;
    const ticket = tickets.find((t) => t.id === active.id);
    if (!ticket) return;
    let targetStatus = (over.data.current?.status as Status | undefined) ?? ticket.status;
    // Only Claude puts a ticket in progress: a card dropped on In Progress joins the queue
    // (at the front when dropped on a running card, else at the end) and starts when a slot is free.
    const queueDrop = targetStatus === "in_progress" && ticket.status !== "in_progress";
    if (queueDrop) targetStatus = "ready";
    const list = (byColumn.get(targetStatus) ?? []).filter((t) => t.id !== ticket.id);
    let index = queueDrop && !String(over.id).startsWith("col:") ? 0 : list.length;
    if (!queueDrop && !String(over.id).startsWith("col:")) {
      const overIndex = list.findIndex((t) => t.id === over.id);
      if (overIndex >= 0) {
        const originalList = byColumn.get(targetStatus) ?? [];
        const movingDown = ticket.status === targetStatus &&
          originalList.findIndex((t) => t.id === ticket.id) < originalList.findIndex((t) => t.id === over.id);
        index = movingDown ? overIndex + 1 : overIndex;
      }
    }
    const before = list[index - 1]?.order;
    const after = list[index]?.order;
    const order = before === undefined && after === undefined ? 1
      : before === undefined ? after! - 1
      : after === undefined ? before + 1
      : (before + after) / 2;
    if (targetStatus === ticket.status && order === ticket.order) return;
    onMove(ticket.id, targetStatus, order);
  };

  const dragging = tickets.find((t) => t.id === dragId);

  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
      <main className="board">
        {BOARD_COLUMNS.map((c) => (
          <Column key={c.id} {...c} tickets={byColumn.get(c.id) ?? []} queue={c.id === "in_progress" ? byColumn.get("ready") : undefined} held={restartPending} onOpen={onOpen} onAdd={onAdd} filtered={filtered} ctx={ctx}
            collapsed={collapsed.has(c.id)} onCollapse={(v) => setColumnCollapsed(c.id, v)} />
        ))}
      </main>
      <DragOverlay>{dragging ? <Card ticket={dragging} dragging huddle={cardHuddleBadge(huddles, dragging.id)} /> : null}</DragOverlay>
    </DndContext>
  );
}
