import { useEffect, useState } from "react";
import { api, subscribe, type AutomationProposal, type Pass } from "./api";
import { everyLabel, resolveProposedPass } from "./automations";
import { connectFromClaude, KeyForm, openSignIn } from "./passConnect";

/**
 * The setup chat proposed an automation (propose_automation). The card shows what it watches and the connections it
 * needs (Connect or paste a key for each one still missing); only the user's Save automation saves it. Its tickets
 * land in Backlog: the editor in Automations is where the user lets them start Claude by themselves.
 */
export function AutomationCard({ slug, ticketId, uuid, proposal, saved, onOpenAutomations, onError }: {
  slug: string;
  ticketId: string;
  uuid: string;
  proposal: AutomationProposal;
  /** The automation this card saved (the ticket's automationCards), if any. */
  saved?: { loopId: string };
  onOpenAutomations?: () => void;
  onError: (m: string) => void;
}) {
  const [passes, setPasses] = useState<Pass[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showScript, setShowScript] = useState(false);
  const load = () => api.passes().then((r) => setPasses(r.passes)).catch(() => {});
  useEffect(() => {
    load();
    return subscribe((e) => {
      if (e.type === "integration.updated") load();
    });
  }, []);

  if (saved) {
    return (
      <div className="proposal applied auto-card">
        <span className="proposal-tag">Automation saved</span>
        <div className="proposal-actions">
          <span className="badge ok">{proposal.name}: checks every {everyLabel(proposal.everyMinutes)}</span>
          {onOpenAutomations && <button className="btn small ghost" onClick={onOpenAutomations}>Open in Automations</button>}
        </div>
      </div>
    );
  }

  const resolved = proposal.passes.map((p) => ({ p, ...resolveProposedPass(p, passes ?? []) }));
  const ready = passes !== null && resolved.every((r) => r.need === null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setNote(null);
    try {
      await fn();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const connect = (r: (typeof resolved)[number]) => run(`c:${r.p.name}`, async () => {
    let result: "done" | "signing_in" | "needs_key";
    if (r.p.from) {
      const server = (await api.mcp()).servers.find((s) => s.name === r.p.from);
      if (!server) throw new Error(`${r.p.from} isn't in Connections any more`);
      result = await connectFromClaude(server, r.pass);
    } else {
      const tab = window.open("about:blank", "_blank");
      try {
        const pass = r.pass ?? await api.addPass({ kind: "mcp", name: r.p.name, url: r.p.url });
        openSignIn(tab, (await api.authorizePass(pass.id)).url);
        result = "signing_in";
      } catch (e: any) {
        tab?.close();
        if (e?.code !== "no_registration") throw e;
        result = "needs_key";
      }
    }
    if (result === "needs_key") setKeyFor(r.p.name);
    if (result === "signing_in") setNote("Approve the board in the tab that just opened; this card updates when you are done.");
    await load();
  });

  const save = () => run("save", async () => {
    const ids = resolved.map((r) => r.pass!.id);
    const l = await api.createLoop(slug, {
      name: proposal.name, enabled: true, service: proposal.service, passes: ids, script: proposal.script, everyMinutes: proposal.everyMinutes,
      column: "backlog", autoStart: false, askClaude: proposal.askClaude ?? { on: false, prompt: "" },
      instructions: proposal.instructions ?? "Look at this item from {{service}} and do what it needs.\n\nLink: {{link}}",
    });
    await api.answerAutomationCard(slug, ticketId, uuid, l.id);
  });

  return (
    <div className="proposal auto-card">
      <span className="proposal-tag">Proposed automation</span>
      <div className="proposal-title">{proposal.name}</div>
      <div className="muted small">{proposal.summary}</div>
      <div className="auto-box">
        <div className="small">
          Checks {proposal.service} every {everyLabel(proposal.everyMinutes)}, without Claude. New items become tickets in Backlog.
          {proposal.askClaude?.on ? " Claude looks at each new item first (a little cost per new item)." : ""}
        </div>
        {resolved.length > 0 && (
          <div className="auto-passes">
            {resolved.map((r) => (
              <div key={r.p.name} className="auto-pass">
                <span>{r.p.name}</span>
                {r.need === null && <span className="badge ok">✓ connected</span>}
                {r.need === "connect" && (
                  <button className="btn small primary" disabled={!!busy} onClick={() => connect(r)}>{busy === `c:${r.p.name}` ? "Connecting…" : "Connect"}</button>
                )}
                {r.need === "key" && keyFor !== r.p.name && <button className="btn small primary" onClick={() => setKeyFor(r.p.name)}>Paste a key</button>}
                {r.need === "missing" && <span className="badge blocked">not connected: connect it in Connections</span>}
                {keyFor === r.p.name && (
                  <KeyForm name={r.p.name} claudeName={r.p.from ?? null} url={r.p.envName ? null : r.pass?.url ?? r.p.url ?? null} envName={r.p.envName} help={r.p.keyHelp}
                    onCancel={() => setKeyFor(null)} onSaved={() => { setKeyFor(null); load(); }} />
                )}
              </div>
            ))}
          </div>
        )}
        <button type="button" className="link-btn small" aria-expanded={showScript} onClick={() => setShowScript((v) => !v)}>
          {showScript ? "▾" : "▸"} How it checks
        </button>
        {showScript && <pre className="mcp-raw">{proposal.script}</pre>}
      </div>
      {note && <div className="muted small">{note}</div>}
      <div className="proposal-actions">
        <button className="btn primary" disabled={!ready || !!busy} title={ready ? "" : "Connect what it needs first"} onClick={save}>
          {busy === "save" ? "Saving…" : "Save automation"}
        </button>
      </div>
    </div>
  );
}
