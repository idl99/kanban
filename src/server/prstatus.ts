import { tmpdir } from "node:os";
import { run } from "./git";
import type { PrCheck, PrStatus } from "./types";

/** Fields of `gh pr view --json` the board reads. */
export const PR_FIELDS = "number,state,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,comments";

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const SKIPPED = new Set(["SKIPPED", "NEUTRAL", "STALE"]);

/** One entry of statusCheckRollup: a GitHub Actions CheckRun or a commit StatusContext. */
function parseCheck(c: any): PrCheck {
  const name = String(c?.name ?? c?.context ?? "check");
  const url = typeof (c?.detailsUrl ?? c?.targetUrl) === "string" && (c.detailsUrl ?? c.targetUrl) ? String(c.detailsUrl ?? c.targetUrl) : null;
  let state: PrCheck["state"];
  if (c?.__typename === "StatusContext" || (c?.context && !c?.name)) {
    const s = String(c?.state ?? "").toUpperCase();
    state = s === "SUCCESS" ? "pass" : FAILED.has(s) ? "fail" : "pending";
  } else {
    const conclusion = String(c?.conclusion ?? "").toUpperCase();
    if (String(c?.status ?? "").toUpperCase() !== "COMPLETED" || !conclusion) state = "pending";
    else state = conclusion === "SUCCESS" ? "pass" : SKIPPED.has(conclusion) ? "skipped" : "fail";
  }
  const at = c?.completedAt && !String(c.completedAt).startsWith("0001") ? String(c.completedAt) : c?.startedAt ? String(c.startedAt) : null;
  return { name, state, url, at };
}

/** `gh pr view --json PR_FIELDS` output to the status the board caches on the ticket. */
export function parsePrStatus(url: string, raw: any, now = new Date().toISOString()): PrStatus {
  const checks: PrCheck[] = (Array.isArray(raw?.statusCheckRollup) ? raw.statusCheckRollup : []).map(parseCheck);
  const state = raw?.state === "OPEN" || raw?.state === "MERGED" || raw?.state === "CLOSED" ? raw.state : null;
  const mergeable = raw?.mergeable === "MERGEABLE" || raw?.mergeable === "CONFLICTING" ? raw.mergeable : "UNKNOWN";
  const comments = Array.isArray(raw?.comments) ? raw.comments.length : Number(raw?.comments) || 0;
  return {
    url,
    number: Number(raw?.number) || Number(url.split("/").pop()) || null,
    state,
    checks,
    failing: checks.filter((c) => c.state === "fail").length,
    pending: checks.filter((c) => c.state === "pending").length,
    mergeable,
    conflicts: mergeable === "CONFLICTING" || raw?.mergeStateStatus === "DIRTY",
    mergeStateStatus: typeof raw?.mergeStateStatus === "string" ? raw.mergeStateStatus : null,
    reviewDecision: typeof raw?.reviewDecision === "string" && raw.reviewDecision ? raw.reviewDecision : null,
    comments,
    fetchedAt: now,
  };
}

/** Why Merge & done is not allowed right now, or null when it is. The server checks this again on a fresh status. */
export function mergeBlock(pr: PrStatus | null | undefined): string | null {
  if (!pr) return "PR status not loaded yet";
  if (pr.state !== "OPEN") return pr.state === "MERGED" ? "PR is already merged" : pr.state === "CLOSED" ? "PR is closed" : "PR state unknown";
  if (pr.conflicts) return "PR has conflicts with the base branch";
  if (pr.failing) return `${pr.failing} ${pr.failing === 1 ? "check" : "checks"} failing`;
  if (pr.pending) return "Checks are still running";
  if (pr.mergeable !== "MERGEABLE") return "GitHub has not confirmed the PR is mergeable yet";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "A reviewer requested changes";
  return null;
}

export const PER_CHECK_LOG = 8_000;
export const TOTAL_LOG = 20_000;

/** The end of a log (errors are usually last), at most max chars. */
export function tail(log: string, max: number): string {
  const s = log.trimEnd();
  if (s.length <= max) return s;
  return `… (${s.length - max} earlier chars cut)\n${s.slice(s.length - max)}`;
}

/** The chat message "Send failures to Claude" sends: failing check names and the end of each failed log. */
export function failureMessage(pr: PrStatus, logs: { name: string; log: string | null; url: string | null }[]): string {
  const names = logs.map((l) => l.name);
  const parts = [`CI failed on PR #${pr.number ?? "?"} (${pr.url}): ${names.join(", ")}.`];
  let budget = TOTAL_LOG;
  for (const l of logs) {
    let body: string;
    if (!l.log?.trim()) body = `(no log available${l.url ? `; see ${l.url}` : ""})`;
    else if (budget <= 0) body = `(log left out to keep this message short${l.url ? `; see ${l.url}` : ""})`;
    else {
      const cap = Math.min(PER_CHECK_LOG, budget);
      body = "```\n" + tail(l.log, cap) + "\n```";
      budget -= Math.min(l.log.trimEnd().length, cap);
    }
    parts.push(`### ${l.name}\n${body}`);
  }
  parts.push("Fix it and push.");
  return parts.join("\n\n");
}

/** The chat message "Resolve conflicts" sends: rebase the ticket branch onto the base, fix conflicts, check, push. */
export function conflictMessage(pr: PrStatus, base: string): string {
  const b = base || "the base branch";
  const remote = base ? `origin/${base}` : "the remote base branch";
  return [
    `PR #${pr.number ?? "?"} (${pr.url}) has conflicts with ${b}. Resolve them:`,
    `1. \`git fetch\` and rebase this branch onto the remote base branch (\`${remote}\`).`,
    "2. Resolve every conflict keeping both sides' intent: the base branch's changes and this ticket's.",
    "3. Run the repo's checks (tests, typecheck, build) and fix anything the rebase broke.",
    "4. Push with `git push --force-with-lease` to this ticket's branch only. Never force-push the base branch or any other branch.",
  ].join("\n");
}

/** owner/repo, run id and job id from an Actions details URL (.../owner/repo/actions/runs/<run>/job/<job>). */
export function actionsIds(url: string | null): { repo: string; run: string; job: string | null } | null {
  const m = url?.match(/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
  return m ? { repo: m[1], run: m[2], job: m[3] ?? null } : null;
}

// ---- gh calls (run outside any checkout, so gh never touches local branches) ----

export async function ghPrStatus(url: string): Promise<PrStatus> {
  const r = await run(["gh", "pr", "view", url, "--json", PR_FIELDS], tmpdir());
  if (r.code !== 0) throw new Error(r.stderr.trim() || "gh pr view failed");
  return parsePrStatus(url, JSON.parse(r.stdout));
}

export async function ghFailedLog(check: PrCheck): Promise<string | null> {
  const ids = actionsIds(check.url);
  if (!ids) return null;
  const args = ids.job ? ["--job", ids.job] : [ids.run];
  const r = await run(["gh", "run", "view", ...args, "--log-failed", "-R", ids.repo], tmpdir());
  return r.code === 0 ? r.stdout : null;
}

export async function ghMerge(url: string): Promise<{ ok: boolean; error: string }> {
  const r = await run(["gh", "pr", "merge", url, "--squash", "--delete-branch"], tmpdir());
  return { ok: r.code === 0, error: (r.stderr.trim() || r.stdout.trim() || "gh pr merge failed") };
}
