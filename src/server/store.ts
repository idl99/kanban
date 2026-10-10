import {
  appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import YAML from "yaml";
import type {
  ActivityEntry, Comment, Config, Huddle, HuddleMessage, OutputFile, Profile, Schedule, ScheduleHistoryEntry, Status, Ticket, TicketMode, TicketQuestion,
} from "./types";
import { cleanPresets, type HuddlePreset } from "./huddle-presets";
import { cleanTemplates, type HuddleTemplate } from "./huddle-templates";
import { type HuddleNote, type NoteScope, parseNotes, serializeNotes } from "./huddle-notes";
import { newId, newTicketId, nowIso } from "./util";

const DEFAULT_CONFIG: Config = { port: 7777, prPollMinutes: 5 };

export function defaultRoot(): string {
  return process.env.CKANBAN_HOME ?? join(homedir(), ".claude-kanban");
}

export function atomicWrite(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${newId()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function parseTicket(raw: string): Ticket {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("missing frontmatter");
  const meta = YAML.parse(m[1]);
  if (!meta || typeof meta !== "object" || !meta.id) throw new Error("invalid frontmatter");
  return { ...meta, body: m[2] ?? "" } as Ticket;
}

function serializeTicket(t: Ticket): string {
  const { body, ...meta } = t;
  return `---\n${YAML.stringify(meta)}---\n${body}`;
}

export class Store {
  /** Parsed huddle message logs by "<slug>/<huddle>", with the byte offset read up to (see readHuddleMessages). */
  private huddleLogs = new Map<string, { offset: number; msgs: HuddleMessage[] }>();
  constructor(public readonly root: string) {
    mkdirSync(join(root, "profiles"), { recursive: true });
  }

  config(): Config {
    const file = join(this.root, "config.json");
    if (!existsSync(file)) return { ...DEFAULT_CONFIG };
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  /** Pasted images, shared by all profiles (see attachments.ts). */
  get attachmentsDir(): string {
    return join(this.root, "attachments");
  }

  private profileDir(slug: string) {
    return join(this.root, "profiles", slug);
  }

  private ticketDir(slug: string, id: string) {
    return join(this.profileDir(slug), "tickets", id);
  }

  listProfiles(): Profile[] {
    const dir = join(this.root, "profiles");
    return readdirSync(dir)
      .map((s) => this.getProfile(s))
      .filter((p): p is Profile => p !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getProfile(slug: string): Profile | null {
    const file = join(this.profileDir(slug), "profile.json");
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  saveProfile(p: Profile): void {
    atomicWrite(join(this.profileDir(p.slug), "profile.json"), JSON.stringify(p, null, 2) + "\n");
  }

  deleteProfile(slug: string): void {
    rmSync(this.profileDir(slug), { recursive: true, force: true });
  }

  ticketPath(slug: string, id: string): string {
    return join(this.ticketDir(slug, id), "ticket.md");
  }

  listTickets(slug: string): Ticket[] {
    const dir = join(this.profileDir(slug), "tickets");
    if (!existsSync(dir)) return [];
    const out: Ticket[] = [];
    for (const id of readdirSync(dir)) {
      if (!existsSync(this.ticketPath(slug, id))) continue;
      out.push(this.readTicketOrCorrupt(slug, id));
    }
    return out.sort((a, b) => a.order - b.order);
  }

  private readTicketOrCorrupt(slug: string, id: string): Ticket {
    const file = this.ticketPath(slug, id);
    try {
      return parseTicket(readFileSync(file, "utf8"));
    } catch (e) {
      const at = nowIso();
      return {
        id, title: id, status: "backlog", order: 0, sessionId: null, worktree: null, branch: null,
        prUrl: null, outcome: null, lastActivity: null, lastRunAt: null, runCount: 0,
        error: `corrupt ticket file: ${(e as Error).message}`, createdAt: at, updatedAt: at, body: "",
      };
    }
  }

  getTicket(slug: string, id: string): Ticket | null {
    if (!existsSync(this.ticketPath(slug, id))) return null;
    return this.readTicketOrCorrupt(slug, id);
  }

  nextOrder(slug: string, status: Status): number {
    const orders = this.listTickets(slug).filter((t) => t.status === status).map((t) => t.order);
    return orders.length ? Math.max(...orders) + 1 : 1;
  }

  topOrder(slug: string, status: Status): number {
    const orders = this.listTickets(slug).filter((t) => t.status === status).map((t) => t.order);
    return orders.length ? Math.min(...orders) - 1 : 1;
  }

  /** Where a ticket lands when it enters a column: on top, except Ready, which is a FIFO run queue. */
  entryOrder(slug: string, status: Status): number {
    return status === "ready" ? this.nextOrder(slug, status) : this.topOrder(slug, status);
  }

  createTicket(
    slug: string,
    input: {
      title: string; body: string; status: Status; mode?: TicketMode; scheduleId?: string; parentId?: string; planKey?: string; dependsOn?: string[];
      needs?: string[];
    },
  ): Ticket {
    const at = nowIso();
    const t: Ticket = {
      id: newTicketId(), title: input.title, status: input.status, mode: input.mode ?? "auto", order: this.entryOrder(slug, input.status),
      sessionId: null, worktree: null, branch: null, prUrl: null, outcome: null, lastActivity: null,
      lastRunAt: null, runCount: 0, error: null, createdAt: at, updatedAt: at, body: input.body,
      ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.planKey ? { planKey: input.planKey } : {}),
      ...(input.dependsOn?.length ? { dependsOn: input.dependsOn } : {}),
      ...(input.needs?.length ? { needs: input.needs } : {}),
    };
    atomicWrite(this.ticketPath(slug, t.id), serializeTicket(t));
    return t;
  }

  updateTicket(slug: string, id: string, patch: Partial<Ticket>): Ticket {
    const current = parseTicket(readFileSync(this.ticketPath(slug, id), "utf8"));
    const next: Ticket = { ...current, ...patch, id, updatedAt: nowIso() };
    // Changing column without an explicit position (drag drop) places the ticket by entryOrder().
    if (patch.status !== undefined && patch.status !== current.status && patch.order === undefined) {
      next.order = this.entryOrder(slug, patch.status);
    }
    if (patch.body === undefined) next.body = current.body;
    atomicWrite(this.ticketPath(slug, id), serializeTicket(next));
    return next;
  }

  deleteTicket(slug: string, id: string): void {
    rmSync(this.ticketDir(slug, id), { recursive: true, force: true });
  }

  /** Folder where runs save deliverables (reports etc.) for the user to read on the board. */
  outputsDir(slug: string, id: string): string {
    const dir = join(this.ticketDir(slug, id), "outputs");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Absolute path of the outputs folder, without creating it (shown in the Share menu). */
  outputsPath(slug: string, id: string): string {
    return join(this.ticketDir(slug, id), "outputs");
  }

  /** Give a branched ticket its own copy of the source's deliverables. */
  copyOutputs(slug: string, from: string, to: string): void {
    const src = join(this.ticketDir(slug, from), "outputs");
    if (existsSync(src)) cpSync(src, join(this.ticketDir(slug, to), "outputs"), { recursive: true });
  }

  listOutputs(slug: string, id: string): OutputFile[] {
    const dir = join(this.ticketDir(slug, id), "outputs");
    if (!existsSync(dir)) return [];
    const out: OutputFile[] = [];
    const walk = (sub: string) => {
      for (const name of readdirSync(join(dir, sub))) {
        const rel = sub ? `${sub}/${name}` : name;
        const st = statSync(join(dir, rel));
        if (st.isDirectory()) walk(rel);
        else out.push({ name: rel, size: st.size, updatedAt: st.mtime.toISOString() });
      }
    };
    walk("");
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Resolve an output file path, refusing anything outside the ticket's outputs folder. */
  outputPath(slug: string, id: string, name: string): string | null {
    const dir = join(this.ticketDir(slug, id), "outputs");
    const file = resolve(dir, name);
    if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) return null;
    return file;
  }

  listComments(slug: string, id: string): Comment[] {
    return readJsonl<Comment>(join(this.ticketDir(slug, id), "comments.jsonl"));
  }

  addComment(slug: string, id: string, author: Comment["author"], text: string): Comment {
    const c: Comment = { id: newId(), author, text, at: nowIso() };
    appendFileSync(join(this.ticketDir(slug, id), "comments.jsonl"), JSON.stringify(c) + "\n");
    return c;
  }

  appendActivity(slug: string, id: string, run: number, event: unknown): void {
    const e: ActivityEntry = { run, at: nowIso(), event };
    appendFileSync(join(this.ticketDir(slug, id), "activity.jsonl"), JSON.stringify(e) + "\n");
  }

  readActivity(slug: string, id: string): ActivityEntry[] {
    return readJsonl<ActivityEntry>(join(this.ticketDir(slug, id), "activity.jsonl"));
  }

  private schedulesDir(slug: string) {
    return join(this.profileDir(slug), "schedules");
  }

  listSchedules(slug: string): Schedule[] {
    const dir = this.schedulesDir(slug);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.getSchedule(slug, f.slice(0, -5)))
      .filter((s): s is Schedule => s !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getSchedule(slug: string, id: string): Schedule | null {
    if (!/^[a-z0-9]+$/.test(id)) return null;
    const file = join(this.schedulesDir(slug), `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  saveSchedule(slug: string, s: Schedule): void {
    atomicWrite(join(this.schedulesDir(slug), `${s.id}.json`), JSON.stringify(s, null, 2) + "\n");
  }

  deleteSchedule(slug: string, id: string): void {
    rmSync(join(this.schedulesDir(slug), `${id}.json`), { force: true });
    rmSync(join(this.schedulesDir(slug), `${id}.history.jsonl`), { force: true });
  }

  appendScheduleHistory(slug: string, id: string, e: ScheduleHistoryEntry): void {
    mkdirSync(this.schedulesDir(slug), { recursive: true });
    appendFileSync(join(this.schedulesDir(slug), `${id}.history.jsonl`), JSON.stringify(e) + "\n");
  }

  readScheduleHistory(slug: string, id: string): ScheduleHistoryEntry[] {
    return readJsonl<ScheduleHistoryEntry>(join(this.schedulesDir(slug), `${id}.history.jsonl`));
  }

  listQuestions(slug: string): TicketQuestion[] {
    const file = join(this.profileDir(slug), "questions.json");
    if (!existsSync(file)) return [];
    try {
      const v = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  saveQuestions(slug: string, qs: TicketQuestion[]): void {
    atomicWrite(join(this.profileDir(slug), "questions.json"), JSON.stringify(qs, null, 2) + "\n");
  }

  /** Huddle presets at one level: a board's own (slug), or the global ones every board gets (slug null). Merge with mergePresets. */
  listHuddlePresets(slug: string | null): HuddlePreset[] {
    return this.readList(this.levelFile(slug, "huddle-presets.json"), cleanPresets);
  }

  saveHuddlePresets(slug: string | null, ps: HuddlePreset[]): void {
    atomicWrite(this.levelFile(slug, "huddle-presets.json"), JSON.stringify(ps, null, 2) + "\n");
  }

  /** Huddle templates at one level: a board's own (slug), or the global ones (slug null). Merge with mergeTemplates. */
  listHuddleTemplates(slug: string | null): HuddleTemplate[] {
    return this.readList(this.levelFile(slug, "huddle-templates.json"), cleanTemplates);
  }

  saveHuddleTemplates(slug: string | null, ts: HuddleTemplate[]): void {
    atomicWrite(this.levelFile(slug, "huddle-templates.json"), JSON.stringify(ts, null, 2) + "\n");
  }

  /** <home>/<name> for the global level (slug null), else the board's profiles/<slug>/<name>. */
  private levelFile(slug: string | null, name: string): string {
    return join(slug === null ? this.root : this.profileDir(slug), name);
  }

  private readList<T>(file: string, clean: (v: unknown) => T[]): T[] {
    if (!existsSync(file)) return [];
    try {
      return clean(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return [];
    }
  }

  /** A role's notes file: general ones are global (<home>/huddle-notes), repo ones the board's. role: "_all" or a preset name. */
  huddleNotesPath(slug: string, role: string, scope: NoteScope): string {
    return join(scope === "general" ? this.root : this.profileDir(slug), "huddle-notes", `${role}.md`);
  }

  /** A role's notes, newest first. */
  readHuddleNotes(slug: string, role: string, scope: NoteScope): HuddleNote[] {
    const file = this.huddleNotesPath(slug, role, scope);
    return existsSync(file) ? parseNotes(readFileSync(file, "utf8")) : [];
  }

  writeHuddleNotes(slug: string, role: string, scope: NoteScope, notes: HuddleNote[]): void {
    atomicWrite(this.huddleNotesPath(slug, role, scope), serializeNotes(role, scope, notes));
  }

  /** Roles with a notes file (general or this board's repo notes). */
  huddleNoteRoles(slug: string): string[] {
    const names = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)) : []);
    return [...new Set([...names(join(this.root, "huddle-notes")), ...names(join(this.profileDir(slug), "huddle-notes"))])].sort();
  }

  private huddlesDir(slug: string) {
    return join(this.profileDir(slug), "huddles");
  }

  listHuddles(slug: string): Huddle[] {
    const dir = this.huddlesDir(slug);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.getHuddle(slug, f.slice(0, -5)))
      .filter((h): h is Huddle => h !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getHuddle(slug: string, id: string): Huddle | null {
    if (!/^h_[a-z0-9_]+$/i.test(id)) return null;
    const file = join(this.huddlesDir(slug), `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  saveHuddle(slug: string, h: Huddle): void {
    atomicWrite(join(this.huddlesDir(slug), `${h.id}.json`), JSON.stringify(h, null, 2) + "\n");
  }

  /** Identifies one version of the huddle file (inode and mtime), or null if it is gone: tells edits from outside. */
  huddleStamp(slug: string, id: string): string | null {
    try {
      const st = statSync(join(this.huddlesDir(slug), `${id}.json`));
      return `${st.ino}:${st.mtimeMs}`;
    } catch {
      return null;
    }
  }

  /** The message log is append-only: messages are never edited or removed. */
  appendHuddleMessage(slug: string, id: string, m: HuddleMessage): void {
    mkdirSync(this.huddlesDir(slug), { recursive: true });
    appendFileSync(join(this.huddlesDir(slug), `${id}.messages.jsonl`), JSON.stringify(m) + "\n");
  }

  /**
   * The huddle's messages, oldest first. The parsed log is cached per huddle with the byte offset read up to (the
   * append index): a read parses only the lines appended since. A shorter file (replaced) is read again in full.
   */
  readHuddleMessages(slug: string, id: string): HuddleMessage[] {
    const file = join(this.huddlesDir(slug), `${id}.messages.jsonl`);
    const key = `${slug}/${id}`;
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      this.huddleLogs.delete(key);
      return [];
    }
    let log = this.huddleLogs.get(key);
    if (!log || size < log.offset) log = { offset: 0, msgs: [] };
    if (size > log.offset) {
      const fd = openSync(file, "r");
      let buf: Buffer;
      try {
        buf = Buffer.alloc(size - log.offset);
        buf = buf.subarray(0, readSync(fd, buf, 0, buf.length, log.offset));
      } finally {
        closeSync(fd);
      }
      // Only whole lines: a line still being written is read next time.
      const end = buf.lastIndexOf(0x0a) + 1;
      const msgs = log.msgs.slice();
      for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          msgs.push(JSON.parse(line));
        } catch {}
      }
      log = { offset: log.offset + end, msgs };
    }
    this.huddleLogs.set(key, log);
    // Copies: a caller changing a message must not change the cache.
    return log.msgs.map((m) => ({ ...m, mentions: [...(m.mentions ?? [])] }));
  }

  /** Where a huddle participant saves reports and scripts: outputs/<handle>/ of the host ticket. */
  huddleOutputsDir(slug: string, ticketId: string, handle: string): string {
    const dir = join(this.ticketDir(slug, ticketId), "outputs", handle);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
