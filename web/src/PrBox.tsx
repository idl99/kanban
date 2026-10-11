import { useEffect, useState } from "react";
import { api, safeHref, type PrCheck, type Profile, type Ticket } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ExternalIcon, RefreshIcon } from "./icons";
import { ResolveConflicts } from "./ResolveConflicts";
import { currentPr, mergeBlock, reviewText } from "./prText";
import { fullTime, timeAgo } from "./time";
import { useNow } from "./useNow";
import { toast } from "./toast";

const MARK: Record<PrCheck["state"], { sym: string; tone: string; verb: string }> = {
  pass: { sym: "✓", tone: "ok", verb: "passed" },
  fail: { sym: "✗", tone: "bad", verb: "failed" },
  pending: { sym: "●", tone: "pend", verb: "started" },
  skipped: { sym: "–", tone: "plain", verb: "skipped" },
};

/**
 * Review drawer box for the ticket's pull request: one row per check, conflicts, reviews and comments, plus
 * "Send failures to Claude", "Resolve conflicts" and "Merge & done". Asks the server for a fresh status on open (it reuses one under 30s old).
 */
export function PrBox({ profile, ticket, onError }: { profile: Profile; ticket: Ticket & { prUrl: string }; onError: (msg: string) => void }) {
  useNow();
  const slug = profile.slug;
  const pr = currentPr(ticket);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);

  const refresh = async (force: boolean) => {
    setLoading(true);
    try {
      await api.prRefresh(slug, ticket.id, force);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    refresh(false);
  }, [slug, ticket.id, ticket.prUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendFailures = async () => {
    setSending(true);
    try {
      await api.prSendFailures(slug, ticket.id);
      toast("Sent the CI failures to Claude.");
    } catch (e: any) {
      onError(e.message);
    } finally {
      setSending(false);
    }
  };

  const number = pr?.number ?? ticket.prUrl.split("/").pop();
  const block = mergeBlock(pr);
  const failing = pr?.checks.filter((c) => c.state === "fail") ?? [];
  const allGreen = !!pr && !pr.failing && !pr.pending;

  return (
    <div className="pr-box" aria-label="Pull request">
      <div className="pr-line pr-head">
        <span className="pr-label">Pull request</span>
        <span className="pr-sp" />
        <button className="icon-btn pr-refresh" onClick={() => refresh(true)} disabled={loading}
          title={pr ? `Checked ${timeAgo(pr.fetchedAt)} (${fullTime(pr.fetchedAt)}). Check again` : "Check again"} aria-label="Refresh PR status">
          <RefreshIcon size={12} className={loading ? "icon pr-spin" : "icon"} />
        </button>
        <a className="pr-gh" href={safeHref(ticket.prUrl)} target="_blank" rel="noreferrer">#{number} · open on GitHub <ExternalIcon size={11} /></a>
      </div>

      {!pr && (loadError
        ? <div className="pr-line pr-error" title={loadError}>Could not read the PR: {loadError}</div>
        : <div className="pr-line muted small">Checking the PR…</div>)}

      {pr && pr.state !== "OPEN" && <div className="pr-line muted small">This PR is {pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "in an unknown state"}.</div>}

      {pr && pr.state === "OPEN" && (
        <>
          {allGreen && pr.checks.length > 0 ? (
            <div className="pr-line"><span className="pr-mark ok">✓</span>All {pr.checks.length} {pr.checks.length === 1 ? "check" : "checks"} passed</div>
          ) : pr.checks.length === 0 ? (
            <div className="pr-line"><span className="pr-mark plain">–</span>No checks on this PR</div>
          ) : null}
          {!allGreen && pr.checks.map((c, i) => {
            const m = MARK[c.state];
            return (
              <div key={`${c.name}-${i}`} className="pr-line pr-check">
                <span className={`pr-mark ${m.tone}`} aria-label={m.verb}>{m.sym}</span>
                <span className="pr-name" title={c.name}>{c.name}</span>
                {c.at && <span className="muted small" title={fullTime(c.at)}>{m.verb} {timeAgo(c.at)}</span>}
                <span className="pr-sp" />
                {c.url && <a className="pr-log" href={safeHref(c.url)} target="_blank" rel="noreferrer">log <ExternalIcon size={11} /></a>}
              </div>
            );
          })}
          <div className="pr-line">
            {pr.conflicts
              ? <><span className="pr-mark bad">✗</span>Conflicts with the base branch<span className="pr-sp" /><ResolveConflicts slug={slug} ticket={ticket} onError={onError} /></>
              : pr.mergeable === "MERGEABLE"
                ? <><span className="pr-mark ok">✓</span>No conflicts · mergeable</>
                : <><span className="pr-mark plain">?</span>GitHub is still checking for conflicts</>}
          </div>
          <div className="pr-line">
            <span className={`pr-mark ${pr.reviewDecision === "CHANGES_REQUESTED" ? "bad" : pr.reviewDecision === "APPROVED" ? "ok" : "plain"}`}>
              {pr.reviewDecision === "CHANGES_REQUESTED" ? "✗" : pr.reviewDecision === "APPROVED" ? "✓" : "–"}
            </span>
            {reviewText(pr.reviewDecision)}
            {pr.comments > 0 && <span className="muted small">· {pr.comments} {pr.comments === 1 ? "comment" : "comments"}</span>}
          </div>
          <div className="pr-actions">
            {failing.length > 0 && (
              <button className="btn primary small" onClick={sendFailures} disabled={sending}
                title={`Send the failing ${failing.length === 1 ? "check" : "checks"} and ${failing.length === 1 ? "its" : "their"} log to Claude to fix`}>
                {sending ? "Sending…" : "Send failures to Claude"}
              </button>
            )}
            <span title={block ?? "Squash-merges, deletes the branch, moves the card to Done"}>
              <button className={`btn small ${!block ? "primary" : ""}`} disabled={!!block} onClick={() => setConfirmMerge(true)}>Merge & done</button>
            </span>
          </div>
          <p className="muted small pr-hint">{block ? `Merge is disabled: ${block}.` : "Squash-merges, deletes the branch, moves the card to Done."}</p>
        </>
      )}

      {confirmMerge && (
        <ConfirmDialog title={`Merge PR #${number} into ${profile.baseBranch || "the base branch"}?`} confirmLabel="Merge" busyLabel="Merging…" tone="primary"
          onCancel={() => setConfirmMerge(false)}
          onConfirm={async () => {
            await api.prMerge(slug, ticket.id);
            setConfirmMerge(false);
            toast(`PR #${number} merged.`);
          }}>
          Squash merge · delete branch{ticket.branch ? <> <code>{ticket.branch}</code></> : null} · card moves to Done
        </ConfirmDialog>
      )}
    </div>
  );
}
