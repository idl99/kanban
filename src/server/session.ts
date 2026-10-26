import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { commandText, localCommandOutput, TERMINAL_COMMANDS } from "./commands";
import type { Bus } from "./events";
import { proposedBudget, rosterError, type RosterEntry } from "./huddle-roster";
import { mockupName, stripMockups } from "./mockups";
import { parseResult } from "./result";
import { parseTeammateProposal, type TeammateProposal } from "./teammate-proposal";
import { parseAutomationProposal, type AutomationProposal } from "./automation-proposal";
import type { Store } from "./store";
import { normalizeTags } from "./tags";
import { AGENT_TOOL, notifiedStatus, parseTaskNotification, SubagentCache, subagentFiles, toolLabel, withTranscript, type AgentInfo } from "./subagents";
import { findToolDetailIn, type ToolDetail } from "./tooldetail";
import { parseSetupBlock, type SetupResult } from "./worktree-setup";
import { starredTitle } from "./util";

/** One visible item of a Claude Code session, as shown in the ticket's Conversation tab. */
export interface QuestionOption {
  label: string;
  description?: string;
  recommended: boolean;
  /** Mockup this option stands for (file name in outputs/mockups); the form links to its preview. */
  mockup?: string;
}

export interface Question {
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface TicketProposal {
  title: string;
  description: string;
  /** ⭐ Important: the proposal asked for it (important: true, or a ⭐ before the title, which is left out of title). */
  important?: true;
}

/** A ticket a planner's chat proposed creating; key/dependsOn order the plan. */
export interface NewTicketDraft extends TicketProposal {
  key?: string;
  dependsOn?: string[];
  /** Exclusive resources (e.g. emulator), see Ticket.needs. */
  needs?: string[];
  /** Tags the ticket gets when created (see Ticket.tags). */
  tags?: string[];
}

export interface SessionEntry {
  uuid: string;
  at: string;
  role: "user" | "assistant";
  /** board: a prompt the board sent on the user's behalf (instructions hidden). */
  /** agent: a subagent Claude started (rendered as its own row with status and steps). */
  kind: "text" | "tool" | "board" | "agent";
  text: string;
  /** Tool rows: the tool_use id (its full input and output load from the tool endpoint). */
  toolUseId?: string;
  /** Tool rows whose result was an error. */
  error?: true;
  agent?: AgentInfo;
  /** Interview questions Claude asked (rendered as a form). */
  questions?: Question[];
  /** Improved title/description Claude proposed (rendered with an Apply button). */
  proposal?: TicketProposal;
  /** New tickets Claude proposed splitting the work into (rendered with Create buttons). */
  newTickets?: NewTicketDraft[];
  /** Claude offered to branch this ticket (rendered with a Branch button). */
  branch?: { reason: string };
  /** Claude proposed a huddle roster (propose_huddle; rendered with a Start button). */
  huddle?: { roster: RosterEntry[]; reason: string; template?: string; maxCostUsd?: number };
  /** Claude asked to delete tickets (propose_delete; rendered with Cancel / Delete buttons). */
  deletion?: { ids: string[]; reason: string };
  /** Claude proposed a teammate (propose_teammate; rendered with Save teammate / Edit first / Dismiss). */
  teammate?: TeammateProposal;
  /** Claude proposed an automation (propose_automation; rendered with Connect buttons and Save automation). */
  automation?: AutomationProposal;
  /** Mockups Claude sent as blocks (saved to outputs/mockups; the chat links to them). */
  mockups?: string[];
  /** Claude asked the board to move the ticket (a planning-only request arrived in Review). */
  moved?: "planning";
  /** A board block whose JSON couldn't be read (left visible as text; the chat says so). */
  unreadable?: BlockKind;
  /**
   * A message from outside the user: in = into this session. A huddle digest has ticketId null; a message another
   * ticket's Claude sent (chat_ticket) has that ticket's id and title, and text is just the message.
   */
  peer?: { dir: "in" | "out"; ticketId: string | null; title?: string };
  /** A plain message of the user's that the chat can rewind to (not one sent mid-turn, not a huddle or peer message). */
  rewind?: true;
  /** Huddle messages delivered to this ticket's session (also a peer entry, ticketId null): the huddle's id. */
  huddleId?: string;
  /** A setup the board ran: before this prompt (older runs), or alone (text "") after `ckanban ticket setup`. Shown as a row. */
  setup?: SetupResult;
  /** A user message that ran a slash command (its name, without the slash); text is `/name args`. */
  command?: string;
  /** Output of a built-in command Claude Code ran itself (/context), not a reply from Claude. */
  commandOutput?: boolean;
}

export type BlockKind = "questions" | "proposal" | "tickets";

/** Marker Claude adds when a Review message only asked for planning; the board moves the card. */
export const MOVE_TO_PLANNING_RE = /<ckanban-move\s+to="planning"\s*\/?>(?:\s*<\/ckanban-move>)?/;
/** A Review/Done chat reply that only proposed tickets: the card stays in its column. */
export const STAY_RE = /<ckanban-stay\s*\/?>(?:\s*<\/ckanban-stay>)?/;

const CONTEXT_TAG = "<ckanban-context";

/** End index (exclusive) of the JSON object/array starting at `from`, or -1 when it never closes. */
function jsonEnd(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Find a `<tag>` block and parse its JSON. The JSON's own end decides where the block stops, so a wrong or
 * missing closing tag, or a closing tag quoted inside the JSON text, doesn't break it. A ```json fence around
 * the JSON is fine. Each occurrence of the opening tag is tried in order (prose may mention the tag before the
 * real block); the first whose content parses wins. `raw` is the block's text (to remove it), `value` null when
 * no occurrence parses (then `raw` is the first one).
 */
function findBlock<T>(text: string, tag: string, parse: (v: unknown) => T | null): { raw: string; value: T | null } | null {
  const open = `<${tag}>`;
  let first: string | null = null;
  for (let start = text.indexOf(open); start >= 0; start = text.indexOf(open, start + open.length)) {
    const head = /^\s*(?:```(?:json)?\s*)?/.exec(text.slice(start + open.length))![0];
    const from = start + open.length + head.length;
    const end = text[from] === "{" || text[from] === "[" ? jsonEnd(text, from) : -1;
    if (end < 0) {
      first ??= text.slice(start);
      continue;
    }
    const tail = /^(?:\s*```)?(?:\s*<\/[\w-]+>)?/.exec(text.slice(end))![0];
    const raw = text.slice(start, end + tail.length);
    let value: T | null = null;
    try {
      value = parse(JSON.parse(text.slice(from, end)));
    } catch {}
    if (value) return { raw, value };
    first ??= raw;
  }
  return first === null ? null : { raw: first, value: null };
}

export function parseQuestions(v: any): Question[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  const qs = v.map((q: any) => ({
    question: String(q?.question ?? "").trim(),
    multiSelect: !!q?.multiSelect,
    options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({
      label: String(o?.label ?? "").trim(),
      description: typeof o?.description === "string" && o.description ? o.description : undefined,
      recommended: !!o?.recommended,
      ...(typeof o?.mockup === "string" && mockupName(o.mockup) ? { mockup: mockupName(o.mockup)! } : {}),
    })).filter((o: QuestionOption) => o.label),
  }));
  return qs.every((q) => q.question) ? qs : null;
}

export function parseProposal(v: any): TicketProposal | null {
  const star = starredTitle(typeof v?.title === "string" ? v.title.trim() : "");
  const description = typeof v?.description === "string" ? v.description.trim() : "";
  const title = star.title.trim();
  return title || description ? { title, description, ...(star.important || v?.important === true ? { important: true } : {}) } : null;
}

export function parseNewTickets(v: any): NewTicketDraft[] | null {
  if (!Array.isArray(v)) return null;
  const ts = v.map((x: any) => {
    const star = starredTitle(typeof x?.title === "string" ? x.title.trim() : "");
    const d: NewTicketDraft = {
      title: star.title.trim(),
      description: typeof x?.description === "string" ? x.description.trim() : "",
    };
    if (star.important || x?.important === true) d.important = true;
    const key = typeof x?.key === "string" ? x.key.trim() : "";
    if (key) d.key = key;
    const deps = Array.isArray(x?.dependsOn) ? x.dependsOn.filter((k: unknown) => typeof k === "string" && k.trim()).map((k: string) => k.trim()) : [];
    if (deps.length) d.dependsOn = deps;
    const needs = Array.isArray(x?.needs) ? x.needs.filter((k: unknown) => typeof k === "string" && k.trim()).map((k: string) => k.trim().toLowerCase()) : [];
    if (needs.length) d.needs = needs;
    const tags = normalizeTags(x?.tags);
    if (tags.length) d.tags = tags;
    return d;
  }).filter((x) => x.title);
  return ts.length ? ts : null;
}

/** Split an assistant text block into visible text + structured questions/proposal/new tickets. */
function assistantBlock(text: string): Pick<SessionEntry, "text" | "questions" | "proposal" | "newTickets" | "mockups" | "moved" | "unreadable"> {
  const { text: rest, names: mockups } = stripMockups(text);
  let out = rest;
  let moved: "planning" | undefined;
  if (MOVE_TO_PLANNING_RE.test(out)) {
    moved = "planning";
    out = out.replace(MOVE_TO_PLANNING_RE, "");
  }
  out = out.replace(STAY_RE, "");
  let unreadable: BlockKind | undefined;
  /** Parse one block and cut it from the text; an unreadable block stays visible and is flagged. */
  const take = <T>(tag: string, kind: BlockKind, parse: (v: unknown) => T | null): T | undefined => {
    const b = findBlock(out, tag, parse);
    if (!b) return undefined;
    if (!b.value) {
      unreadable ??= kind;
      return undefined;
    }
    out = out.replace(b.raw, "");
    return b.value;
  };
  const questions = take("ckanban-questions", "questions", parseQuestions);
  const proposal = take("ckanban-ticket", "proposal", parseProposal);
  const newTickets = take("ckanban-tickets", "tickets", parseNewTickets);
  return {
    text: out.trim(),
    ...(questions ? { questions } : {}),
    ...(proposal ? { proposal } : {}),
    ...(newTickets ? { newTickets } : {}),
    ...(mockups.length ? { mockups } : {}),
    ...(moved ? { moved } : {}),
    ...(unreadable ? { unreadable } : {}),
  };
}

/** The board doesn't move a blocked run to Planning; its reply (up to the next user message) mustn't claim it did. */
function dropBlockedMoves(entries: SessionEntry[]): void {
  entries.forEach((e, i) => {
    if (!e.moved) return;
    for (let j = i; j < entries.length && !(entries[j].role === "user" && !entries[j].huddleId); j++) {
      const r = entries[j].role === "assistant" && entries[j].kind === "text" ? parseResult(entries[j].text) : null;
      if (r?.status === "blocked") return void delete e.moved;
    }
  });
}

export interface SessionArtifact {
  url: string;
  label: string;
  at: string;
}

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
  /** A user-role message that didn't come from the user: a huddle digest. */
  from?: "huddle";
  /** An assistant message answering such a message (a quiet reply, not one for the user). */
  peerReply?: boolean;
}

export interface ParsedSession {
  title: string | null;
  entries: SessionEntry[];
  artifacts: SessionArtifact[];
  lastMessage: SessionMessage | null;
  /** Questions Claude asked since the user's last message. */
  openQuestions: number;
  /** Latest ticket proposal since the user's last message. */
  pendingProposal: TicketProposal | null;
  /** Latest proposed new tickets since the user's last message (some may already be created). */
  pendingNewTickets: TicketProposal[];
  /** Teammate cards (their entry uuids) since the user's last message; Ticket.teammateCards says which were answered. */
  pendingTeammates: string[];
  /** Automation cards (entry uuids) since the user's last message; Ticket.automationCards says which were saved. */
  pendingAutomations: string[];
}

/** What the board card and ticket header need; sent over SSE. */
export interface SessionSummary {
  title: string | null;
  lastMessage: SessionMessage | null;
  artifacts: SessionArtifact[];
  updatedAt: string;
  openQuestions: number;
  pendingProposal: TicketProposal | null;
  pendingNewTickets: TicketProposal[];
  pendingTeammates: string[];
  pendingAutomations?: string[];
}

interface Dirs {
  configDir?: string;
}

function projectsDir(d: Dirs): string {
  return join(d.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

export function findSessionFile(sessionId: string, d: Dirs = {}): string | null {
  const root = projectsDir(d);
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const f = join(root, dir, `${sessionId}.jsonl`);
    try {
      if (statSync(f).isFile()) return f;
    } catch {}
  }
  return null;
}

const PUBLISHED = /Published (\S+) at (https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+)/g;

const HELPER_PUBLISH = /\bartifact publish\b/;
const PUBLISH_TOOL = /(?:^|__)publish_artifact$/;

/** `ckanban ticket setup`: its output ends with the setup block the chat draws a row from. */
const SETUP_HELPER = /\bticket setup\b/;

function isPublisher(block: any): boolean {
  if (block.name === "Artifact" || PUBLISH_TOOL.test(String(block.name ?? ""))) return true;
  return block.name === "Bash" && typeof block.input?.command === "string" && HELPER_PUBLISH.test(block.input.command);
}

/** A Claude Code built-in typed in a terminal session (/exit, /resume): not part of the ticket chat. */
function terminalOnly(cmd: string | null): boolean {
  return !!cmd && TERMINAL_COMMANDS.has(cmd.slice(1).split(" ")[0]);
}

/** How the board labels a message another ticket's Claude sent (http.ts chat): `Message from ticket <id> ("<title>"): text`. */
export const fromTicketText = (ticketId: string, title: string, text: string) => `Message from ticket ${ticketId} ("${title}"): ${text}`;
const FROM_TICKET = /^Message from ticket (t_[\w-]+) \("([\s\S]*?)"\): ([\s\S]*)$/;

/** The sender and message of a text fromTicketText made, or null for anything else. */
export function fromTicket(text: string): { ticketId: string; title: string; text: string } | null {
  const m = FROM_TICKET.exec(text);
  return m ? { ticketId: m[1], title: m[2], text: m[3].trim() } : null;
}

function userText(content: unknown): { kind: "text" | "board"; text: string; huddle?: string; setup?: SetupResult; command?: string } | null {
  if (Array.isArray(content)) {
    if (content.some((c: any) => c?.type === "tool_result")) return null;
    content = content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");
  }
  if (typeof content !== "string") return null;
  const ctx = content.indexOf(CONTEXT_TAG);
  if (ctx >= 0) {
    // Board-sent prompt: show only what the user typed; pure instructions become a short note.
    const typed = content.slice(0, ctx).trim();
    const tag = content.slice(ctx, content.indexOf(">", ctx) + 1);
    const setup = parseSetupBlock(content.slice(ctx));
    const extra = setup ? { setup } : {};
    // Huddle messages for this ticket's session: huddle="<huddle id>".
    const huddle = tag.match(/ huddle="([^"]*)"/)?.[1];
    if (typed && huddle) return { kind: "text", text: typed, huddle, ...extra };
    if (typed) return { kind: "text", text: typed, ...extra };
    const note = content.slice(ctx).match(/note="([^"]*)"/)?.[1];
    return { kind: "board", text: note || "Board sent instructions to Claude", ...extra };
  }
  const t = content.trim();
  // A slash command the user ran: Claude Code stores it as tags; show it as typed.
  const cmd = commandText(t);
  if (cmd) return terminalOnly(cmd) ? null : { kind: "text", text: cmd, command: cmd.slice(1).split(" ")[0] };
  // Other slash-command wrappers, hook output and skill preambles are stored as user messages too.
  if (!t || t.startsWith("<") || /^(Base directory for this skill|Caveat:|\[Request interrupted)/.test(t)) return null;
  return { kind: "text", text: t };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
  return "";
}

/** Planning-chat tools (ckanban MCP): their input becomes a form or card, like the text blocks. */
const QUESTIONS_TOOL = /(?:^|__)ask_questions$/;
const PROPOSAL_TOOL = /(?:^|__)propose_ticket$/;
const TICKETS_TOOL = /(?:^|__)propose_tickets$/;
const BRANCH_TOOL = /(?:^|__)propose_branch$/;
const HUDDLE_TOOL = /(?:^|__)propose_huddle$/;
const DELETE_TOOL = /(?:^|__)propose_delete$/;
const TEAMMATE_TOOL = /(?:^|__)propose_teammate$/;
const AUTOMATION_TOOL = /(?:^|__)propose_automation$/;

/** The form or card a planning-chat tool call shows, or null for other tools (or input that can't be read). */
function cardEntry(block: any): Pick<SessionEntry, "questions" | "proposal" | "newTickets" | "branch" | "huddle" | "deletion" | "teammate" | "automation"> | null {
  const name = String(block.name ?? "");
  if (QUESTIONS_TOOL.test(name)) {
    const questions = parseQuestions(block.input?.questions);
    return questions && { questions };
  }
  if (PROPOSAL_TOOL.test(name)) {
    const proposal = parseProposal(block.input);
    return proposal && { proposal };
  }
  if (TICKETS_TOOL.test(name)) {
    const newTickets = parseNewTickets(block.input?.tickets);
    return newTickets && { newTickets };
  }
  if (BRANCH_TOOL.test(name)) return { branch: { reason: typeof block.input?.reason === "string" ? block.input.reason.trim() : "" } };
  if (DELETE_TOOL.test(name)) {
    const ids = Array.isArray(block.input?.ids) ? [...new Set(block.input.ids.filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim()))] as string[] : [];
    return ids.length ? { deletion: { ids, reason: typeof block.input?.reason === "string" ? block.input.reason.trim() : "" } } : null;
  }
  if (TEAMMATE_TOOL.test(name)) {
    const teammate = parseTeammateProposal(block.input);
    return teammate && { teammate };
  }
  if (AUTOMATION_TOOL.test(name)) {
    const automation = parseAutomationProposal(block.input);
    return automation && { automation };
  }
  if (HUDDLE_TOOL.test(name)) {
    const template = typeof block.input?.template === "string" && block.input.template.trim() ? block.input.template.trim() : undefined;
    // With a template the roster is optional: the card fills in the template's.
    const roster = template && block.input?.roster === undefined ? [] : block.input?.roster;
    if (!(template && Array.isArray(roster) && !roster.length) && rosterError(roster)) return null;
    const reason = typeof block.input?.reason === "string" ? block.input.reason.trim() : "";
    // A budget Claude was asked for (capped); one that isn't a positive amount is left out, the card's default applies.
    const maxCostUsd = proposedBudget(block.input?.maxCostUsd);
    return { huddle: { roster, reason, ...(template ? { template } : {}), ...(typeof maxCostUsd === "number" ? { maxCostUsd } : {}) } };
  }
  return null;
}

export function parseSession(raw: string): ParsedSession {
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  const entries: SessionEntry[] = [];
  const artifacts = new Map<string, SessionArtifact>();
  const publishers = new Set<string>();
  /** Bash calls running `ckanban ticket setup` (by tool_use id). */
  const setups = new Set<string>();
  /** Card tool calls (by tool_use id) and those whose result was an error: those don't render. */
  const cards = new Set<string>();
  const failed = new Set<string>();
  /** Tool calls whose result was an error (their rows get a ✗). */
  const errored = new Set<string>();
  /** Subagents by the Agent tool_use id; their rows update as results and notifications arrive. */
  const agents = new Map<string, AgentInfo>();
  /** The last command was terminal-only: its output (next local-command-stdout, if any) is hidden too. */
  let hideOutput = false;
  const notified = (text: unknown, at: string) => {
    const n = typeof text === "string" ? parseTaskNotification(text) : null;
    const a = n && agents.get(n.toolUseId);
    if (!n || !a) return;
    a.status = notifiedStatus(n.status);
    a.endedAt = at || a.endedAt;
    a.updatedAt = at || a.updatedAt;
    if (a.status === "done") a.result = n.result ?? a.result;
    else a.error = n.result ?? `Agent ${n.status}`;
  };
  const peerEntry = (u: NonNullable<ReturnType<typeof userText>>, uuid: string, at: string): SessionEntry => {
    const from = u.kind === "text" && !u.huddle ? fromTicket(u.text) : null;
    return {
      uuid, at, role: "user", kind: u.kind, text: from ? from.text : u.text, ...(u.command ? { command: u.command } : {}),
      ...(u.huddle ? { peer: { dir: "in" as const, ticketId: null }, huddleId: u.huddle } : {}),
      ...(from ? { peer: { dir: "in" as const, ticketId: from.ticketId, title: from.title } } : {}),
      ...(u.setup ? { setup: u.setup } : {}),
    };
  };

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "custom-title" && typeof ev.customTitle === "string") customTitle = ev.customTitle;
    else if (ev.type === "ai-title" && typeof ev.aiTitle === "string") aiTitle = ev.aiTitle;
    const at = typeof ev.timestamp === "string" ? ev.timestamp : "";
    const uuid = typeof ev.uuid === "string" ? ev.uuid : `${entries.length}`;
    // A message sent while Claude was working is saved as an attachment to the running turn, not a user message.
    if (ev.type === "attachment" && ev.attachment?.type === "queued_command" && !ev.isSidechain) notified(ev.attachment.prompt, at);
    if (ev.type === "attachment" && ev.attachment?.type === "queued_command" && ev.attachment.commandMode === "prompt" && !ev.isSidechain) {
      const u = userText(ev.attachment.prompt);
      if (u) entries.push(peerEntry(u, uuid, at));
      continue;
    }
    if (ev.type === "system" && !ev.isSidechain) {
      // What a built-in command printed (/context, /model), and where /compact summarised the conversation.
      const out = ev.subtype === "local_command" && typeof ev.content === "string" ? localCommandOutput(ev.content) : null;
      if (out !== null && hideOutput) hideOutput = false;
      else if (out) entries.push({ uuid, at, role: "assistant", kind: "text", text: out, commandOutput: true });
      else if (ev.subtype === "compact_boundary") entries.push({ uuid, at, role: "user", kind: "board", text: "Conversation compacted" });
      continue;
    }
    if ((ev.type !== "user" && ev.type !== "assistant") || ev.isSidechain) continue;
    const content = ev.message?.content;

    if (ev.type === "user") {
      // The summary /compact left behind: the boundary above already says so.
      if (ev.isCompactSummary) continue;
      // A terminal-only command is hidden, and so is what it printed.
      if (typeof content === "string" && terminalOnly(commandText(content.trim()))) {
        hideOutput = true;
        continue;
      }
      const out = typeof content === "string" ? localCommandOutput(content) : null;
      if (out !== null) {
        if (hideOutput) hideOutput = false;
        else if (out) entries.push({ uuid, at, role: "assistant", kind: "text", text: out, commandOutput: true });
        continue;
      }
      if (!ev.isMeta) hideOutput = false;
      notified(typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n") : "", at);
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "tool_result" && agents.has(b.tool_use_id)) agentResult(agents.get(b.tool_use_id)!, b, ev.toolUseResult, at);
          if (b?.type === "tool_result" && b.is_error && cards.has(b.tool_use_id)) failed.add(b.tool_use_id);
          if (b?.type === "tool_result" && b.is_error) errored.add(b.tool_use_id);
          if (b?.type === "tool_result" && setups.has(b.tool_use_id)) {
            const setup = parseSetupBlock(resultText(b.content));
            if (setup) entries.push({ uuid: `${b.tool_use_id}:setup`, at, role: "assistant", kind: "board", text: "", setup });
          }
          // Only real publishes: output of the Artifact tool, or of the `ckanban artifact publish`
          // helper / publish_artifact MCP tool headless runs use. Other tools (e.g. Bash grepping a different session's file)
          // can print the same text.
          if (b?.type !== "tool_result" || !publishers.has(b.tool_use_id)) continue;
          for (const m of resultText(b.content).matchAll(PUBLISHED)) {
            const label = basename(m[1]).replace(/\.[a-z0-9]+$/i, "");
            artifacts.delete(m[2]); // re-insert so the newest publish sorts last
            artifacts.set(m[2], { url: m[2], label, at });
          }
        }
      }
      const u = userText(content);
      if (u && !ev.isMeta) {
        const e = peerEntry(u, uuid, at);
        if (e.kind === "text" && !e.peer && !e.setup) e.rewind = true;
        entries.push(e);
      }
      continue;
    }

    hideOutput = false;
    if (!Array.isArray(content)) continue;
    content.forEach((b: any, i: number) => {
      if (b?.type === "tool_use" && typeof b.id === "string" && isPublisher(b)) publishers.add(b.id);
      if (b?.type === "tool_use" && typeof b.id === "string" && b.name === "Bash" && SETUP_HELPER.test(String(b.input?.command ?? ""))) setups.add(b.id);
      const id = i ? `${uuid}:${i}` : uuid;
      const card = b?.type === "tool_use" && typeof b.id === "string" ? cardEntry(b) : null;
      if (b?.type === "text" && b.text?.trim()) entries.push({ uuid: id, at, role: "assistant", kind: "text", ...assistantBlock(b.text.trim()) });
      else if (card) {
        // The tool_use id keeps the uuid stable, so form drafts and answered/applied state stick to it.
        cards.add(b.id);
        entries.push({ uuid: b.id, at, role: "assistant", kind: "text", text: "", ...card });
      } else if (b?.type === "tool_use" && AGENT_TOOL.test(b.name ?? "") && typeof b.id === "string") {
        const input = b.input ?? {};
        const agent: AgentInfo = {
          toolUseId: b.id, description: typeof input.description === "string" && input.description.trim() ? input.description.trim() : "Subagent",
          type: typeof input.subagent_type === "string" ? input.subagent_type : null, background: input.run_in_background === true,
          status: "running", startedAt: at, endedAt: null, updatedAt: at, steps: [], stepCount: 0, current: null, result: null, error: null,
        };
        agents.set(b.id, agent);
        entries.push({ uuid: b.id, at, role: "assistant", kind: "agent", text: toolLabel(b), agent });
      } else if (b?.type === "tool_use") {
        entries.push({ uuid: id, at, role: "assistant", kind: "tool", text: toolLabel(b), ...(typeof b.id === "string" ? { toolUseId: b.id } : {}) });
      }
    });
  }

  for (const e of entries) if (e.toolUseId && errored.has(e.toolUseId)) e.error = true;
  if (failed.size) entries.splice(0, entries.length, ...entries.filter((e) => !failed.has(e.uuid)));
  dropBlockedMoves(entries);
  const last = entries.findLast((e) => e.kind === "text" && (e.text || e.questions || e.proposal || e.newTickets || e.branch || e.deletion || e.teammate || e.automation));
  const lastText = !last ? "" : last.text
    || (last.questions ? `Asked ${last.questions.length} question${last.questions.length > 1 ? "s" : ""}`
      : last.newTickets ? `Proposed ${last.newTickets.length} new ticket${last.newTickets.length > 1 ? "s" : ""}`
      : last.branch ? "Offered to branch this ticket"
      : last.deletion ? `Asked to delete ${last.deletion.ids.length} ticket${last.deletion.ids.length > 1 ? "s" : ""}`
      : last.teammate ? `Proposed teammate @${last.teammate.name}`
      : last.automation ? `Proposed automation "${last.automation.name}"` : "Proposed an updated ticket");
  const asked = last?.role === "assistant" ? entries.findLast((e, i) => i < entries.indexOf(last) && e.role === "user" && e.kind === "text") : undefined;
  return {
    title: customTitle ?? aiTitle,
    entries,
    artifacts: [...artifacts.values()],
    lastMessage: last
      ? {
        role: last.role, text: lastText, at: last.at,
        ...(last.role === "user" && last.huddleId ? { from: "huddle" as const } : {}),
        ...(asked?.huddleId ? { peerReply: true } : {}),
      }
      : null,
    ...pendingSince(entries),
  };
}

/** The parent's tool_result for an Agent call: the report (sync), the launch (background) or an error. */
function agentResult(a: AgentInfo, block: any, meta: any, at: string): void {
  a.updatedAt = at || a.updatedAt;
  if (meta?.status === "async_launched") {
    a.background = true;
    return;
  }
  if (block.is_error) {
    a.status = "failed";
    a.error = resultText(block.content).trim() || "Agent failed";
  } else {
    a.status = "done";
    const report = meta && Array.isArray(meta.content) ? resultText(meta.content).trim() : "";
    a.result = report || handBack(resultText(block.content));
    if (typeof meta?.agentType === "string") a.type ??= meta.agentType;
  }
  a.endedAt = at || null;
}

/** A sync agent's tool_result wraps its report in a notice and indents it; keep just the report. */
function handBack(text: string): string {
  const m = /^\[Subagent hand-back\][^\n]*\n/.exec(text);
  if (!m) return text.trim();
  return text.slice(m[0].length).split("\n").map((l) => l.replace(/^ {2}/, "")).join("\n").trim();
}

function pendingSince(entries: SessionEntry[]): Pick<ParsedSession, "openQuestions" | "pendingProposal" | "pendingNewTickets" | "pendingTeammates" | "pendingAutomations"> {
  let lastUser = -1;
  entries.forEach((e, i) => {
    // Huddle messages don't answer what Claude asked the user (another ticket's message, e.g. the planner's answer, does).
    if (e.role === "user" && e.kind === "text" && !e.huddleId) lastUser = i;
  });
  const after = entries.slice(lastUser + 1);
  return {
    openQuestions: after.reduce((n, e) => n + (e.questions?.length ?? 0), 0),
    pendingProposal: after.findLast((e) => e.proposal)?.proposal ?? null,
    pendingNewTickets: after.findLast((e) => e.newTickets)?.newTickets ?? [],
    pendingTeammates: after.filter((e) => e.teammate).map((e) => e.uuid),
    pendingAutomations: after.filter((e) => e.automation).map((e) => e.uuid),
  };
}

interface CacheItem {
  file: string;
  key: string;
  parsed: ParsedSession;
  /** parsed with its subagents' transcripts merged in, for agentKey. */
  agentKey: string;
  merged: ParsedSession;
}

/** Parses session files lazily; re-reads only when size/mtime change. */
export class SessionCache {
  private items = new Map<string, CacheItem>();
  private files = new Map<string, string>();
  private agents = new SubagentCache();

  constructor(private dirs: Dirs = {}) {}

  private locate(sessionId: string): string | null {
    const known = this.files.get(sessionId);
    if (known) {
      try {
        statSync(known);
        return known;
      } catch {}
    }
    const f = findSessionFile(sessionId, this.dirs);
    if (f) this.files.set(sessionId, f);
    return f;
  }

  private fileVersion(f: string): string | null {
    try {
      const s = statSync(f);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  }

  /** The session's transcript file, wherever it is under the projects folder; null when there is none. */
  file(sessionId: string): string | null {
    return this.locate(sessionId);
  }

  /** Cheap change marker for polling (subagent transcripts included); null when the session file doesn't exist. */
  version(sessionId: string): string | null {
    const f = this.locate(sessionId);
    const v = f && this.fileVersion(f);
    if (!f || !v) return null;
    const agents = this.agents.version(f);
    return agents ? `${v}|${agents}` : v;
  }

  get(sessionId: string): ParsedSession | null {
    const f = this.locate(sessionId);
    const key = f && this.fileVersion(f);
    if (!f || !key) return null;
    let hit = this.items.get(sessionId);
    if (!hit || hit.key !== key || hit.file !== f) {
      let raw = "";
      try {
        raw = readFileSync(f, "utf8");
      } catch {
        return null;
      }
      const parsed = parseSession(raw);
      hit = { file: f, key, parsed, agentKey: "", merged: parsed };
      this.items.set(sessionId, hit);
    }
    if (!hit.parsed.entries.some((e) => e.agent)) return hit.parsed;
    const agentKey = this.agents.version(f);
    if (hit.agentKey !== agentKey || hit.merged === hit.parsed) {
      const transcripts = this.agents.load(f);
      hit.merged = {
        ...hit.parsed,
        entries: hit.parsed.entries.map((e) => (e.agent ? { ...e, agent: withTranscript(e.agent, transcripts.get(e.agent.toolUseId)) } : e)),
      };
      hit.agentKey = agentKey;
    }
    return hit.merged;
  }

  /** One tool call in full (input and output), from the session or one of its subagents' transcripts. */
  toolDetail(sessionId: string, toolUseId: string): ToolDetail | null {
    const f = this.locate(sessionId);
    return f ? findToolDetailIn([f, ...subagentFiles(f)], toolUseId) : null;
  }

  summary(sessionId: string): SessionSummary | null {
    const p = this.get(sessionId);
    const f = this.locate(sessionId);
    if (!p || !f) return null;
    let updatedAt = "";
    try {
      updatedAt = statSync(f).mtime.toISOString();
    } catch {}
    return {
      title: p.title, lastMessage: p.lastMessage, artifacts: p.artifacts, updatedAt,
      openQuestions: p.openQuestions, pendingProposal: p.pendingProposal, pendingNewTickets: p.pendingNewTickets, pendingTeammates: p.pendingTeammates,
      pendingAutomations: p.pendingAutomations,
    };
  }
}

/** One polling pass: emit session.updated for every ticket whose session file changed since last pass. */
export function pollSessions(store: Store, bus: Bus, cache: SessionCache, state: Map<string, string>): void {
  const live = new Set<string>();
  for (const p of store.listProfiles()) {
    for (const t of store.listTickets(p.slug)) {
      if (!t.sessionId) continue;
      const key = `${p.slug}/${t.id}`;
      live.add(key);
      const v = cache.version(t.sessionId);
      if (!v || state.get(key) === `${t.sessionId}:${v}`) continue;
      state.set(key, `${t.sessionId}:${v}`);
      const session = cache.summary(t.sessionId);
      if (session) bus.emit({ type: "session.updated", profile: p.slug, id: t.id, session });
    }
  }
  for (const k of state.keys()) if (!live.has(k)) state.delete(k);
}

export function startSessionWatcher(store: Store, bus: Bus, cache: SessionCache, intervalMs = 2000): () => void {
  const state = new Map<string, string>();
  const timer = setInterval(() => {
    try {
      pollSessions(store, bus, cache, state);
    } catch (e) {
      console.error("session watcher", e);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
