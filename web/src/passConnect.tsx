import { useState } from "react";
import { api, type Pass } from "./api";

/**
 * Sends the tab opened before the wait to a service's sign-in page: only a web address (http/https), never a
 * `javascript:` one, which would run on the board's own page. Closes the tab otherwise.
 */
export function openSignIn(tab: Window | null, url: string): void {
  let ok = false;
  try {
    ok = ["https:", "http:"].includes(new URL(url).protocol);
  } catch {}
  if (!ok) {
    tab?.close();
    throw new Error("The service sent a sign-in address that isn't a web page");
  }
  if (tab) tab.location.href = url;
  else window.open(url, "_blank", "noopener");
}

/**
 * Connects a Connections (Claude) server for automations: the board's own pass. A program on this computer is ready
 * at once; an online server opens its sign-in page in a new tab (opened before the wait, so it isn't blocked as a
 * popup). Returns "needs_key" when the server can't sign the board in by itself: offer a key instead.
 */
export async function connectFromClaude(server: { name: string; transport: string | null }, existing: Pass | null): Promise<"done" | "signing_in" | "needs_key"> {
  if (server.transport === "stdio") {
    if (!existing) await api.addPass({ kind: "local", claudeName: server.name, name: server.name });
    return "done";
  }
  const tab = window.open("about:blank", "_blank");
  try {
    let pass = existing;
    if (!pass) {
      const cfg = await api.mcpConfig(server.name);
      pass = await api.addPass({ kind: "mcp", claudeName: server.name, name: server.name, url: cfg.url });
    }
    const { url } = await api.authorizePass(pass.id);
    openSignIn(tab, url);
    return "signing_in";
  } catch (e: any) {
    tab?.close();
    if (e?.code === "no_registration") return "needs_key";
    throw e;
  }
}

/** Paste a key: for a service without its own sign-in, or an MCP server that can't sign the board in by itself. */
export function KeyForm({ name, claudeName, url, envName, help, onSaved, onCancel }: {
  name: string;
  claudeName?: string | null;
  /** The MCP server the key is for; missing: scripts get it as an environment variable. */
  url?: string | null;
  envName?: string;
  help?: string;
  onSaved: (p: Pass) => void;
  onCancel?: () => void;
}) {
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onSaved(await api.addPass({ kind: "key", name, claudeName: claudeName ?? null, ...(url ? { url } : { envName }), secret }));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="mcp-manual auto-pass" onSubmit={save}>
      <span className="muted small">{help ?? `Paste a key for ${name}.`} It stays on this computer and only the automations that use it get it.</span>
      <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={`${name} key`} aria-label={`${name} key`} autoComplete="off" />
      <button className="btn small primary" disabled={busy || !secret.trim()}>{busy ? "Saving…" : "Save key"}</button>
      {onCancel && <button type="button" className="btn small ghost" onClick={onCancel}>Cancel</button>}
      {err && <div className="form-error">{err}</div>}
    </form>
  );
}
