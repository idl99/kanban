// "Report bug": turns a user's (or Claude's) bug report plus some board context into a GitHub issue on
// the ckanban repo, with `gh issue create`, or a prefilled "new issue" URL when gh can't do it.
import { homedir, platform, arch, release } from "node:os";
import { extractFinalText, summarizeEvent } from "./activity";
import { run, type RunResult } from "./git";
import { maskSecrets } from "./mcp";
import type { Store } from "./store";
import type { ActivityEntry, Profile, Ticket } from "./types";
import { REPO, VERSION } from "./version";

export const BUG_REPO = REPO;
export const LOG_MAX_LINES = 50;
export const LOG_MAX_BYTES = 4096;
/** GitHub rejects very long new-issue URLs (and browsers truncate them); stay well under. */
export const MAX_URL_LENGTH = 8000;

export type BugBlockId = "env" | "ticket" | "log";
export type BugSource = "ui" | "ai" | "cli";

/** One piece of auto-included context; the user sees it and can leave it out. */
export interface BugBlock {
  id: BugBlockId;
  label: string;
  text: string;
}

export interface BugDraft {
  blocks: BugBlock[];
  /** Local URLs (/api/attachments/...) of screenshots in the ticket; they can't be uploaded with gh. */
  screenshots: string[];
}

export interface BugReportInput {
  title: string;
  description: string;
  blocks: BugBlock[];
  /** Block ids to include; omitted = all. */
  include?: BugBlockId[];
  source: BugSource;
}

export interface BugReportResult {
  /** The created issue. Null when gh could not create it. */
  url: string | null;
  /** Prefilled new-issue page: the way out when gh is missing, logged out or failed. */
  fallbackUrl: string;
  error: string | null;
  /** Screenshots referenced by the report that were not uploaded. */
  screenshots: string[];
}

export class BugReportError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const TOKEN_RE = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;
const ATTACHMENT_RE = /\S*?attachments\/([0-9a-f]{32}\.(?:png|jpg|gif|webp))\b/g;
const IMAGE_MD_RE = /!\[[^\]]*\]\(\s*<?\S*?attachments\/([0-9a-f]{32}\.(?:png|jpg|gif|webp))>?\s*\)/g;

/** Hides the data folder, the home folder and anything that looks like a secret or token. */
export function scrub(text: string, opts: { home?: string; dataRoot?: string } = {}): string {
  let out = text;
  const home = opts.home ?? homedir();
  if (opts.dataRoot) out = out.split(opts.dataRoot).join("<ckanban data>");
  if (home && home !== "/") out = out.split(home).join("~");
  return maskSecrets(out.replace(TOKEN_RE, "***"));
}

/** Screenshot file names referenced in the texts (pasted images live only on this machine). */
export function screenshotNames(...texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(ATTACHMENT_RE)) out.add(m[1]);
  return [...out];
}

/** Replaces local image references with a placeholder, since GitHub can't load them. */
export function stripScreenshots(text: string): string {
  return text.replace(IMAGE_MD_RE, "_[screenshot not uploaded]_").replace(ATTACHMENT_RE, "_[screenshot not uploaded]_");
}

/** Last `maxLines` lines of the text, and at most `maxBytes` of it. */
export function tail(text: string, maxLines = LOG_MAX_LINES, maxBytes = LOG_MAX_BYTES): string {
  let lines = text.split("\n");
  if (lines.length > maxLines) lines = lines.slice(-maxLines);
  let out = lines.join("\n");
  const enc = new TextEncoder();
  while (enc.encode(out).length > maxBytes && out.includes("\n")) out = out.slice(out.indexOf("\n") + 1);
  if (enc.encode(out).length > maxBytes) out = out.slice(-maxBytes);
  return out;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}\n…(cut)` : t;
}

export function envBlock(): BugBlock {
  const lines = [
    `- ckanban: ${VERSION}`,
    `- OS: ${platform()} ${release()} (${arch()})`,
    `- Bun: ${Bun.version}`,
  ];
  return { id: "env", label: "Version and system", text: lines.join("\n") };
}

/** Events of the ticket's latest run. */
function lastRun(activity: ActivityEntry[]): ActivityEntry[] {
  const run = activity.at(-1)?.run;
  return run === undefined ? [] : activity.filter((e) => e.run === run);
}

export function ticketBlock(profile: Profile, t: Ticket, activity: ActivityEntry[]): BugBlock {
  const lines = [
    `- Ticket: ${t.id} — ${t.title}`,
    `- Board: ${profile.name}`,
    `- Column: ${t.status}${t.outcome ? ` (last run: ${t.outcome})` : ""}, mode: ${t.mode ?? "auto"}, runs: ${t.runCount}`,
  ];
  if (t.prUrl) lines.push(`- PR: ${t.prUrl}`);
  if (t.error) lines.push(`- Error: ${clip(t.error, 1500)}`);
  const result = extractFinalText(lastRun(activity).map((e) => e.event));
  const parts = [lines.join("\n"), `**Description**\n\n${clip(t.body, 3000) || "(empty)"}`];
  if (result.trim()) parts.push(`**Last run result**\n\n${clip(result, 1500)}`);
  return { id: "ticket", label: "Ticket details", text: parts.join("\n\n") };
}

export function logBlock(activity: ActivityEntry[]): BugBlock | null {
  const lines = lastRun(activity)
    .map((e) => {
      const s = summarizeEvent(e.event, { raw: true });
      return s ? `${e.at.slice(11, 19)} ${s}` : null;
    })
    .filter((s): s is string => !!s);
  if (!lines.length) return null;
  return { id: "log", label: "Last run log (tail)", text: tail(lines.join("\n")) };
}

/** The context blocks for a report, scrubbed; ticket blocks only when a ticket is given. */
export function draftReport(store: Store, ref?: { slug: string; id: string } | null): BugDraft {
  const blocks: BugBlock[] = [envBlock()];
  let screenshots: string[] = [];
  if (ref) {
    const profile = store.getProfile(ref.slug);
    if (!profile) throw new BugReportError(404, `board ${ref.slug} not found`);
    const t = store.getTicket(ref.slug, ref.id);
    if (!t) throw new BugReportError(404, `ticket ${ref.id} not found`);
    const activity = store.readActivity(ref.slug, ref.id);
    blocks.push(ticketBlock(profile, t, activity));
    const log = logBlock(activity);
    if (log) blocks.push(log);
    screenshots = screenshotNames(t.body, ...store.listComments(ref.slug, ref.id).map((c) => c.text));
  }
  const opts = { dataRoot: store.root };
  return {
    blocks: blocks.map((b) => ({ ...b, text: scrub(b.text, opts) })),
    screenshots: screenshots.map((n) => `/api/attachments/${n}`),
  };
}

const FROM: Record<BugSource, string> = { ui: "the board", ai: "Claude, on the user's request", cli: "the ckanban CLI" };

/** Markdown issue body: the user's text, then the context blocks they kept. */
export function buildIssueBody(input: BugReportInput, opts: { dataRoot?: string; home?: string } = {}): { body: string; screenshots: string[] } {
  const keep = input.include ? new Set(input.include) : null;
  const blocks = input.blocks.filter((b) => !keep || keep.has(b.id));
  const description = input.description.trim() || "(no description)";
  const screenshots = screenshotNames(description, ...blocks.map((b) => b.text));
  const parts = [stripScreenshots(description)];
  if (screenshots.length) {
    parts.push(`> ${screenshots.length} screenshot${screenshots.length === 1 ? "" : "s"} not uploaded, see comments.`);
  }
  for (const b of blocks) {
    const text = stripScreenshots(b.text);
    parts.push(b.id === "log"
      ? `<details><summary>${b.label}</summary>\n\n\`\`\`text\n${text.replace(/```/g, "ˋˋˋ")}\n\`\`\`\n\n</details>`
      : `### ${b.label}\n\n${text}`);
  }
  parts.push(`<sub>Reported from ${FROM[input.source]} (ckanban ${VERSION}).</sub>`);
  return { body: scrub(parts.join("\n\n"), opts), screenshots };
}

/** Prefilled new-issue page; the body is cut to keep the URL under `max` characters. */
export function newIssueUrl(title: string, body: string, labels: string[] = ["bug"], max = MAX_URL_LENGTH): string {
  const make = (b: string) => {
    const q = new URLSearchParams({ title, body: b });
    if (labels.length) q.set("labels", labels.join(","));
    return `https://github.com/${BUG_REPO}/issues/new?${q}`;
  };
  let url = make(body);
  if (url.length <= max) return url;
  const note = "\n\n…(cut to fit the link; add more details here)";
  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (make(body.slice(0, mid) + note).length <= max) lo = mid;
    else hi = mid - 1;
  }
  url = make(body.slice(0, lo) + note);
  return url.length <= max ? url : make("").slice(0, max);
}

export type GhRunner = (args: string[]) => Promise<RunResult>;

const ghRun: GhRunner = (args) => run(["gh", ...args], process.cwd());

function ghError(r: RunResult): string {
  const text = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join(" ");
  if (r.code === -1 && /ENOENT|not found|No such file|Executable not found/i.test(text)) {
    return "GitHub CLI (gh) is not installed. Install it with `brew install gh`, then run `gh auth login`.";
  }
  if (/auth login|not logged|authentication|HTTP 401/i.test(text)) {
    return "GitHub CLI (gh) is not logged in. Run `gh auth login` in a terminal.";
  }
  return `gh issue create failed: ${maskSecrets(text) || `exit code ${r.code}`}`;
}

/**
 * Creates the issue with gh. A missing label is not worth failing for: retry without labels.
 * On failure the result carries the error and a prefilled URL to finish in the browser.
 */
export async function fileIssue(title: string, body: string, labels: string[], gh: GhRunner = ghRun): Promise<{ url: string | null; error: string | null; fallbackUrl: string }> {
  const fallbackUrl = newIssueUrl(title, body, labels.filter((l) => l === "bug"));
  const create = (ls: string[]) => gh(["issue", "create", "--repo", BUG_REPO, "--title", title, "--body", body, ...ls.flatMap((l) => ["--label", l])]);
  let r = await create(labels);
  if (r.code !== 0 && labels.length && /label/i.test(r.stderr + r.stdout)) r = await create([]);
  if (r.code !== 0) return { url: null, error: ghError(r), fallbackUrl };
  const url = r.stdout.match(/https:\/\/github\.com\/\S+\/issues\/\d+/)?.[0] ?? r.stdout.trim().split("\n").at(-1) ?? null;
  return { url: url || null, error: null, fallbackUrl };
}

/** Validates, builds and files a report. */
export async function submitReport(input: BugReportInput, opts: { dataRoot?: string; gh?: GhRunner } = {}): Promise<BugReportResult> {
  const title = scrub(input.title.trim().replace(/\s+/g, " "), opts);
  if (!title) throw new BugReportError(400, "title is required");
  if (title.length > 200) throw new BugReportError(400, "title is too long (200 characters max)");
  const { body, screenshots } = buildIssueBody(input, opts);
  const labels = input.source === "ai" ? ["bug", "from-ai"] : ["bug"];
  const r = await fileIssue(title, body, labels, opts.gh);
  return { ...r, screenshots: screenshots.map((n) => `/api/attachments/${n}`) };
}
