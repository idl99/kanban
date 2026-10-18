import type { SetupResult } from "./api";

function secs(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/** "Installed project dependencies · 14.2s": the board's setup command (and files copied, older runs), output on click. */
export function SetupRow({ setup, old }: { setup: SetupResult; old?: boolean }) {
  const failed = setup.ok === false;
  return (
    <details className={`setup-row${failed ? " failed" : ""}${old ? " inherited" : ""}`}>
      <summary>
        {!setup.command ? "Copied files into this copy of the folder" : failed ? "Installing project dependencies" : "Installed project dependencies"} · {secs(setup.durationMs)}
        {failed && <span className="setup-fail"> · failed</span>}
      </summary>
      <div className="setup-lines">
        {setup.copied.length > 0 && <div><span className="setup-ok">✓</span> copied {setup.copied.join(", ")}</div>}
        {setup.missing.length > 0 && <div className="muted">– not found: {setup.missing.join(", ")}</div>}
        {setup.command && (
          <div>
            {failed ? <span className="setup-err">✗</span> : <span className="setup-ok">✓</span>} <code>{setup.command}</code>
            {failed && <span className="muted"> {setup.timedOut ? "(timed out)" : setup.exitCode !== null ? `(exit ${setup.exitCode})` : ""}</span>}
          </div>
        )}
        {setup.output && <pre className="setup-output">{setup.output}</pre>}
        {failed && <div className="muted small">Claude was shown this output.</div>}
      </div>
    </details>
  );
}
