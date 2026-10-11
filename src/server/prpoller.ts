import type { Board } from "./board";
import { run } from "./git";
import { conflictMessage, failureMessage, ghFailedLog, ghMerge, ghPrStatus, mergeBlock } from "./prstatus";
import type { Store } from "./store";
import type { PrCheck, PrStatus, Ticket } from "./types";

export type PrState = "OPEN" | "MERGED" | "CLOSED" | null;

const CLOSED_MSG = "PR closed without merge.";
const MERGED_MSG = "PR merged.";

export async function ghState(url: string): Promise<PrState> {
  const r = await run(["gh", "pr", "view", url, "--json", "state", "-q", ".state"], process.cwd());
  if (r.code !== 0) return null;
  const s = r.stdout.trim();
  return s === "OPEN" || s === "MERGED" || s === "CLOSED" ? s : null;
}

/** waits: the card still needs the user, so a merged PR keeps it in Review until that is dealt with. */
export async function checkPr(
  board: Board, store: Store, slug: string, id: string, gh: (url: string) => Promise<PrState> = ghState,
  waits: (slug: string, id: string) => boolean = (s, i) => board.waitsOnUser(s, i),
): Promise<PrState> {
  const t = store.getTicket(slug, id);
  if (!t?.prUrl || t.status !== "review") return null;
  const state = await gh(t.prUrl);
  // The user may have moved the card while gh was in flight.
  const now = store.getTicket(slug, id);
  if (now?.status !== "review" || now.prUrl !== t.prUrl) return state;
  if (state === "MERGED") {
    // The poller sees the merge on every tick while the card waits; say it once.
    if (!store.listComments(slug, id).some((c) => c.author === "ai" && c.text === MERGED_MSG)) store.addComment(slug, id, "ai", MERGED_MSG);
    if (!waits(slug, id)) await board.updateTicket(slug, id, { status: "done" });
  } else if (state === "CLOSED") {
    const last = store.listComments(slug, id).filter((c) => c.author === "ai").at(-1);
    if (last?.text !== CLOSED_MSG) store.addComment(slug, id, "ai", CLOSED_MSG);
  }
  return state;
}

export interface PrDeps {
  status?: (url: string) => Promise<PrStatus>;
  merge?: (url: string) => Promise<{ ok: boolean; error: string }>;
  failedLog?: (check: PrCheck) => Promise<string | null>;
}

/** The drawer asks for a refresh on open; it reuses a status fetched less than this long ago. */
export const REFRESH_MIN_MS = 30_000;

/**
 * Fetch the PR's checks, conflicts and reviews, cache them on the ticket (broadcast), then apply merged/closed like
 * checkPr. maxAgeMs: keep a cached status this fresh instead of calling gh.
 */
export async function refreshPr(
  board: Board, store: Store, slug: string, id: string, deps: PrDeps & { maxAgeMs?: number } = {},
): Promise<PrStatus | null> {
  const t = store.getTicket(slug, id);
  if (!t?.prUrl || t.status !== "review") return null;
  const cached = t.pr?.url === t.prUrl ? t.pr : null;
  if (cached && deps.maxAgeMs && Date.now() - Date.parse(cached.fetchedAt) < deps.maxAgeMs) return cached;
  const pr = await (deps.status ?? ghPrStatus)(t.prUrl);
  const now = store.getTicket(slug, id);
  if (now?.prUrl !== t.prUrl) return pr;
  board.setPr(slug, id, pr);
  await checkPr(board, store, slug, id, async () => pr.state);
  return pr;
}

export class PrError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function reviewPr(store: Store, slug: string, id: string): Ticket & { prUrl: string } {
  const t = store.getTicket(slug, id);
  if (!t) throw new PrError(404, `ticket ${id} not found`);
  if (!t.prUrl) throw new PrError(400, "this ticket has no pull request");
  if (t.status !== "review") throw new PrError(409, "the ticket is no longer in Review");
  return t as Ticket & { prUrl: string };
}

/**
 * Merge & done: re-check the PR fresh (open, checks green, no conflicts, mergeable, no changes requested), squash-merge
 * it and delete its branch with gh (never --admin, so branch protection still applies), then move the card to Done.
 * Any failure leaves the ticket as it was.
 */
export async function mergePr(board: Board, store: Store, slug: string, id: string, deps: PrDeps = {}): Promise<Ticket> {
  const t = reviewPr(store, slug, id);
  const pr = await (deps.status ?? ghPrStatus)(t.prUrl).catch((e) => {
    throw new PrError(502, `Could not read the PR: ${(e as Error).message}`);
  });
  if (store.getTicket(slug, id)?.prUrl === t.prUrl) board.setPr(slug, id, pr);
  const why = mergeBlock(pr);
  if (why) throw new PrError(409, `Not merged: ${why}.`);
  const r = await (deps.merge ?? ghMerge)(t.prUrl);
  if (!r.ok) throw new PrError(502, r.error);
  board.setPr(slug, id, { ...pr, state: "MERGED", fetchedAt: new Date().toISOString() });
  if (!store.listComments(slug, id).some((c) => c.author === "ai" && c.text === MERGED_MSG)) store.addComment(slug, id, "ai", MERGED_MSG);
  if (store.getTicket(slug, id)?.status === "review") await board.updateTicket(slug, id, { status: "done" });
  return store.getTicket(slug, id)!;
}

/** Send failures to Claude: the failing checks and the end of their failed logs, as a chat message to the ticket. */
export async function sendFailures(board: Board, store: Store, slug: string, id: string, deps: PrDeps = {}): Promise<Ticket> {
  const t = reviewPr(store, slug, id);
  const pr = await (deps.status ?? ghPrStatus)(t.prUrl).catch((e) => {
    throw new PrError(502, `Could not read the PR: ${(e as Error).message}`);
  });
  board.setPr(slug, id, pr);
  const failing = pr.checks.filter((c) => c.state === "fail");
  if (!failing.length) throw new PrError(409, "No checks are failing on this PR any more.");
  const failedLog = deps.failedLog ?? ghFailedLog;
  const logs = await Promise.all(failing.map(async (c) => ({ name: c.name, url: c.url, log: await failedLog(c).catch(() => null) })));
  return board.chat(slug, id, failureMessage(pr, logs));
}

/** Resolve conflicts: re-check the PR, then ask the ticket's Claude to rebase onto the base branch and push. */
export async function resolveConflicts(board: Board, store: Store, slug: string, id: string, deps: PrDeps = {}): Promise<Ticket> {
  const t = reviewPr(store, slug, id);
  if (board.isRunning(slug, id)) throw new PrError(409, "Claude is already working on this ticket.");
  const pr = await (deps.status ?? ghPrStatus)(t.prUrl).catch((e) => {
    throw new PrError(502, `Could not read the PR: ${(e as Error).message}`);
  });
  board.setPr(slug, id, pr);
  if (pr.state !== "OPEN") throw new PrError(409, "The PR is no longer open.");
  if (!pr.conflicts) throw new PrError(409, "The PR has no conflicts any more.");
  return board.chat(slug, id, conflictMessage(pr, store.getProfile(slug)?.baseBranch ?? ""));
}

export function startPoller(board: Board, store: Store, minutes: number): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const p of store.listProfiles()) {
        for (const t of store.listTickets(p.slug)) {
          if (t.status === "review" && t.prUrl) await refreshPr(board, store, p.slug, t.id).catch(() => {});
        }
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, Math.max(1, minutes) * 60_000);
  tick();
  return () => clearInterval(timer);
}
