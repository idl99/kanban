import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { dayKey } from "./limit";
import { atomicWrite, type Store } from "./store";

// Dollars spent, at a glance: each ticket's API-equivalent cost (the same sum as its Usage tab, see ticketRuns) and
// what all boards spent today. Tickets are read from their activity logs, incrementally; huddle agents have no
// ticket log, so their result lines add to a small per-day ledger (spend-days.json).

const CHUNK = 8 * 1024 * 1024;
/** Days the huddle ledger keeps. */
const KEEP_DAYS = 60;

export interface TicketSpend {
  costUsd: number;
  /** Cost by local day (YYYY-MM-DD) of the result line that reported it. */
  days: Map<string, number>;
}

interface FileState extends TicketSpend {
  offset: number;
  /** Last running total per session (result lines carry the session's total, kept across --resume). */
  totals: Map<string, number>;
}

export interface TodaySpend {
  day: string;
  costUsd: number;
  boards: { slug: string; name: string; costUsd: number }[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export class SpendIndex {
  private files = new Map<string, FileState>();
  constructor(private store: Store, private now: () => Date = () => new Date()) {}

  /** A ticket's cost so far (reads only what was appended since the last call). */
  ticket(slug: string, id: string): TicketSpend {
    const file = this.store.activityPath(slug, id);
    let st = this.files.get(file);
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      this.files.delete(file);
      return { costUsd: 0, days: new Map() };
    }
    // Rewritten or replaced (e.g. a deleted and re-made ticket): start over.
    if (!st || size < st.offset) {
      st = { offset: 0, totals: new Map(), costUsd: 0, days: new Map() };
      this.files.set(file, st);
    }
    if (size > st.offset) this.read(file, st, size);
    return st;
  }

  private read(file: string, st: FileState, size: number) {
    const fd = openSync(file, "r");
    try {
      let rest = "";
      let pos = st.offset;
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        pos += n;
        const text = rest + buf.toString("utf8", 0, n);
        const cut = text.lastIndexOf("\n");
        // A line still being written stays for the next read.
        if (cut < 0) {
          rest = text;
          continue;
        }
        for (const line of text.slice(0, cut).split("\n")) this.line(st, line);
        rest = text.slice(cut + 1);
        st.offset = pos - Buffer.byteLength(rest);
      }
    } finally {
      closeSync(fd);
    }
  }

  private line(st: FileState, line: string) {
    if (!line.includes('"total_cost_usd"')) return;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const ev = e?.event;
    if (ev?.type !== "result") return;
    const sid = String(ev.session_id ?? "");
    const total = num(ev.total_cost_usd);
    const prev = st.totals.get(sid) ?? 0;
    const cost = total >= prev ? total - prev : total;
    st.totals.set(sid, total);
    if (!cost) return;
    st.costUsd += cost;
    const at = new Date(e.at);
    const day = Number.isNaN(at.getTime()) ? "" : dayKey(at);
    st.days.set(day, (st.days.get(day) ?? 0) + cost);
  }

  /** What every board spent today (local day): its tickets' runs and its huddle agents. */
  today(): TodaySpend {
    const now = this.now();
    const day = dayKey(now);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const huddles = readLedger(this.store.root)[day] ?? {};
    const boards = this.store.listProfiles().map((p) => {
      let cost = huddles[p.slug] ?? 0;
      const dir = join(this.store.root, "profiles", p.slug, "tickets");
      for (const id of existsSync(dir) ? readdirSync(dir) : []) {
        // Untouched since midnight: nothing spent today.
        let mtime = 0;
        try {
          mtime = statSync(this.store.activityPath(p.slug, id)).mtimeMs;
        } catch {
          continue;
        }
        if (mtime >= start) cost += this.ticket(p.slug, id).days.get(day) ?? 0;
      }
      return { slug: p.slug, name: p.name, costUsd: cost };
    });
    return { day, costUsd: boards.reduce((s, b) => s + b.costUsd, 0), boards };
  }
}

const ledgerFile = (root: string) => join(root, "spend-days.json");

function readLedger(root: string): Record<string, Record<string, number>> {
  try {
    const v = JSON.parse(readFileSync(ledgerFile(root), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** A huddle agent's run cost (its result line's growth), for today's total. */
export function addHuddleSpend(root: string, slug: string, costUsd: number, at = new Date()): void {
  if (!(costUsd > 0)) return;
  const ledger = readLedger(root);
  const d = (ledger[dayKey(at)] ??= {});
  d[slug] = (d[slug] ?? 0) + costUsd;
  const keep = Object.keys(ledger).sort().slice(-KEEP_DAYS);
  atomicWrite(ledgerFile(root), JSON.stringify(Object.fromEntries(keep.map((k) => [k, ledger[k]]))) + "\n");
}
