import { useEffect, useState } from "react";
import { api, copy, safeHref, type AgentStatus, type McpAddInput, type McpConfig, type McpServer, type McpState, type McpTransport } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { CloseIcon, CopyIcon, TerminalIcon } from "./icons";
import { Modal } from "./Modal";
import { timeAgo } from "./time";
import { useNow } from "./useNow";

const STATUS_LABEL: Record<McpServer["status"], [string, string]> = {
  connected: ["Connected", "ok"],
  needs_auth: ["Needs auth", "blocked"],
  failed: ["Failed", "failed"],
  pending: ["Pending approval", "stopped"],
  unknown: ["Unknown", "stopped"],
};
const SCOPE_LABEL: Record<McpServer["scope"], string> = {
  user: "user", local: "local", project: "project", "claude.ai": "claude.ai", other: "other",
};

export function canLogin(s: McpServer): boolean {
  return s.scope === "claude.ai" || s.transport === "http" || s.transport === "sse";
}

/** Quotes one word for a POSIX shell (only when needed). */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quotes args for the edit form's single "Arguments" line (inverse of splitArgs). */
function joinArgs(args: string[]): string {
  return args.map((a) => (/^[^\s"'\\]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, "\\$1")}"`)).join(" ");
}

/** Splits an argument line like a shell would for quotes, without running anything. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(line)); ) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] ?? m[3]);
  return out;
}

const SCOPE_HELP: Record<McpServer["scope"], string> = {
  user: "Your user config (~/.claude.json): every Claude session can use it.",
  local: "Local to your home folder's project entry in ~/.claude.json. Edit or remove it with `claude mcp` there.",
  project: "From a .mcp.json file. Edit or remove it in that file.",
  "claude.ai": "A claude.ai connector. Add or remove it in claude.ai → Settings → Connectors.",
  other: "From a plugin or another config. Manage it where it's defined.",
};

const looksLikeTty = (err: string | null | undefined) => !!err && /terminal|tty|stdin|interactive/i.test(err);

/** Claude Code MCP servers, like `/mcp`: status, OAuth log in / out, add, edit and remove (user scope). */
export function ConnectionsDialog({ state, onClose, onRunInTerminal }: {
  state: McpState | null;
  onClose: () => void;
  /** Opens the board's terminal and runs the command there. Missing when there's no terminal (no profile). */
  onRunInTerminal?: (command: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "remove" | "logout"; server: McpServer } | null>(null);
  const [showIdle, setShowIdle] = useState(false);
  const [editing, setEditing] = useState<McpConfig | null>(null);
  // Command to show with a Copy button when there is no terminal to run it in.
  const [manual, setManual] = useState<{ server: string; command: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useNow();

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const run = (server: string, command: string) => {
    if (onRunInTerminal) onRunInTerminal(command);
    else {
      setCopied(false);
      setManual({ server, command });
    }
  };
  // Same folder as the Connections list (home), so local servers resolve the same way.
  const loginCommand = (s: McpServer) => `cd ~ && claude mcp login ${shellQuote(s.name)}`;
  const runServer = (s: McpServer) => act(`run:${s.name}`, async () => {
    const cfg = await api.mcpConfig(s.name).catch(() => null);
    const line = cfg?.commandLine ?? (s.target && !s.target.includes("***") ? s.target : null);
    run(s.name, line ? `cd ~ && ${line}` : `claude mcp get ${shellQuote(s.name)}`);
  });
  const startEdit = (s: McpServer) => act(`edit:${s.name}`, async () => {
    setAdding(false);
    setEditing(await api.mcpConfig(s.name));
  });

  const servers = state?.servers ?? [];
  const attention = servers.filter((s) => s.attention);
  const mine = servers.filter((s) => !s.attention && s.scope !== "claude.ai");
  const connectors = servers.filter((s) => !s.attention && s.scope === "claude.ai" && s.status === "connected");
  // claude.ai connectors never set up here; kept out of the way (and out of the badge).
  const idle = servers.filter((s) => !s.attention && s.scope === "claude.ai" && s.status !== "connected");

  const terminalButton = (label: string, onClick: () => void, key?: string) => (
    <button className="btn small" disabled={!!key && busy === key} onClick={onClick}>
      {onRunInTerminal ? <TerminalIcon size={12} /> : <CopyIcon size={12} />} {onRunInTerminal ? label : "Show command"}
    </button>
  );

  const details = (text: string) => (
    <details className="mcp-details">
      <summary>Details</summary>
      <pre>{text}</pre>
    </details>
  );

  const row = (s: McpServer) => {
    const [label, tone] = STATUS_LABEL[s.status];
    const waiting = s.login?.state === "waiting";
    const loginFailed = s.login?.state === "failed";
    const failed = s.status === "failed";
    const stdio = !canLogin(s);
    return (
      <div key={s.name} className="mcp-item">
        <div className="mcp-row">
          <div className="mcp-main">
            <div className="mcp-name">
              <span>{s.name}</span>
              <span className={`badge ${tone}`}>{label}</span>
              <span className="badge stopped" title={SCOPE_HELP[s.scope]}>{SCOPE_LABEL[s.scope]}</span>
              {s.transport && s.scope !== "claude.ai" && <span className="badge stopped">{s.transport}</span>}
            </div>
            {s.target && (
              <div className="mcp-target-row">
                <span className="mcp-target" title={s.target}>{s.target}</span>
                {!s.target.includes("***") && (
                  <button className="icon-btn tiny" aria-label={`Copy ${s.name} ${stdio ? "command" : "URL"}`} title="Copy"
                    onClick={() => copy(s.target)}><CopyIcon size={12} /></button>
                )}
              </div>
            )}
            {waiting && (
              <div className="mcp-msg info">
                <span className="spinner" /> Waiting for you to finish in the browser…{" "}
                {safeHref(s.login?.url) && <a href={safeHref(s.login?.url)} target="_blank" rel="noreferrer">Open the login page</a>}
              </div>
            )}
            {loginFailed && (
              <div className="mcp-help">
                <div className="mcp-help-text">
                  {looksLikeTty(s.login?.error)
                    ? <><b>Login needs an interactive terminal.</b> Run it there and follow the prompts; this list updates by itself afterwards.</>
                    : <><b>Login didn't finish.</b> Try it in the terminal to see what the CLI asks for.</>}
                </div>
                <div className="mcp-help-actions">
                  {terminalButton("Open in terminal", () => run(s.name, loginCommand(s)))}
                  <button className="btn small ghost" disabled={busy === `recheck:${s.name}`}
                    onClick={() => act(`recheck:${s.name}`, () => api.mcpRecheck(s.name))}>
                    {busy === `recheck:${s.name}` ? "Checking…" : "Check again"}
                  </button>
                </div>
                {s.login?.error && details(s.login.error)}
              </div>
            )}
            {failed && !loginFailed && (
              <div className="mcp-help">
                <div className="mcp-help-text">
                  {stdio
                    ? <><b>The server command exits on start.</b> Run it in the terminal to see why (a missing tool, token or package).</>
                    : <><b>Couldn't reach the server.</b> Retry, or log in again from the terminal if it worked before.</>}
                </div>
                <div className="mcp-help-actions">
                  {stdio
                    ? terminalButton("Run in terminal", () => runServer(s), `run:${s.name}`)
                    : terminalButton("Log in in terminal", () => run(s.name, loginCommand(s)))}
                  <button className="btn small ghost" disabled={busy === `recheck:${s.name}`}
                    onClick={() => act(`recheck:${s.name}`, () => api.mcpRecheck(s.name))}>
                    {busy === `recheck:${s.name}` ? "Checking…" : "Retry"}
                  </button>
                </div>
                {s.message && details(s.message)}
              </div>
            )}
            {!failed && !loginFailed && s.message && s.status !== "needs_auth" && <div className="mcp-msg">{s.message}</div>}
            {manual?.server === s.name && (
              <div className="mcp-manual">
                <span className="muted small">Run this in a terminal:</span>
                <code>{manual.command}</code>
                <button className="btn small" onClick={async () => { await copy(manual.command); setCopied(true); }}>
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            )}
          </div>
          <div className="mcp-actions">
            {canLogin(s) && waiting && (
              <button className="btn small ghost" onClick={() => act(`cancel:${s.name}`, () => api.mcpCancelLogin(s.name))}>Cancel</button>
            )}
            {canLogin(s) && !waiting && s.status === "needs_auth" && (
              <button className="btn small primary" disabled={busy === `login:${s.name}`}
                onClick={() => act(`login:${s.name}`, () => api.mcpLogin(s.name))}>
                {busy === `login:${s.name}` ? "Starting…" : "Log in"}
              </button>
            )}
            {canLogin(s) && !waiting && s.status === "connected" && (
              <>
                <button className="btn small ghost" disabled={busy === `login:${s.name}`}
                  onClick={() => act(`login:${s.name}`, () => api.mcpLogin(s.name))}>
                  {busy === `login:${s.name}` ? "Starting…" : "Re-authenticate"}
                </button>
                <button className="btn small ghost" onClick={() => setConfirm({ kind: "logout", server: s })}>Log out</button>
              </>
            )}
            {s.scope === "user" && (
              <>
                <button className="btn small ghost" disabled={busy === `edit:${s.name}`} onClick={() => startEdit(s)}>Edit</button>
                <button className="btn small ghost danger" onClick={() => setConfirm({ kind: "remove", server: s })}>Remove</button>
              </>
            )}
            {s.scope !== "user" && s.scope !== "claude.ai" && (
              <span className="muted small mcp-managed" title={SCOPE_HELP[s.scope]}>Managed in {s.scope === "project" ? ".mcp.json" : "its config"}</span>
            )}
          </div>
        </div>
        {editing?.name === s.name && (
          <AddServerForm key={s.name} initial={editing} onAdded={() => setEditing(null)} onCancel={() => setEditing(null)} />
        )}
      </div>
    );
  };

  const section = (title: string, list: McpServer[]) => list.length > 0 && (
    <div className="mcp-section">
      <div className="inbox-board">{title}</div>
      {list.map(row)}
    </div>
  );

  return (
    <Modal title="Connections" onClose={onClose} wide>
      <div className="form mcp">
        <div className="mcp-toolbar">
          <span className="muted small">
            Claude Code MCP servers, as <code>claude mcp list</code> sees them from your home folder.{" "}
            {state?.checking ? <><span className="spinner" /> Checking…</> : state?.checkedAt ? `Checked ${timeAgo(state.checkedAt)}.` : ""}
          </span>
          <div className="spacer" />
          <button className="btn small" disabled={!!state?.checking} onClick={() => act("refresh", api.mcpRefresh)}>Refresh</button>
          <button className="btn small primary" onClick={() => { setEditing(null); setAdding((v) => !v); }}>{adding ? "Close form" : "Add server"}</button>
        </div>
        {adding && <AddServerForm onAdded={() => setAdding(false)} onCancel={() => setAdding(false)} />}
        {state?.error && <div className="banner error mcp-banner">{state.error}</div>}
        {err && <div className="form-error" role="alert">{err}</div>}
        {!state && <div className="muted"><span className="spinner" /> Loading…</div>}
        {state && !servers.length && !state.checking && !state.error && (
          <div className="muted">No MCP servers configured. Add one above, or with <code>claude mcp add</code>.</div>
        )}
        {state && !servers.length && state.checking && !state.checkedAt && (
          <div className="muted">Checking every server takes a little while (they're all health-checked)…</div>
        )}
        <AgentsSection />
        {section("Needs attention", attention)}
        {section("Servers", mine)}
        {section("claude.ai connectors", connectors)}
        {idle.length > 0 && (
          <div className="mcp-section">
            <button className="link-btn small" onClick={() => setShowIdle((v) => !v)} aria-expanded={showIdle}>
              {showIdle ? "Hide" : "Show"} {idle.length} claude.ai connector{idle.length === 1 ? "" : "s"} not connected
            </button>
            {showIdle && idle.map(row)}
          </div>
        )}
        {state && state.unparsed.length > 0 && (
          <div className="mcp-section">
            <div className="inbox-board">Couldn't read these lines</div>
            <pre className="mcp-raw">{state.unparsed.join("\n")}</pre>
          </div>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "remove" ? `Remove ${confirm.server.name}?` : `Log out of ${confirm.server.name}?`}
          confirmLabel={confirm.kind === "remove" ? "Remove" : "Log out"}
          busyLabel={confirm.kind === "remove" ? "Removing…" : "Logging out…"}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            if (confirm.kind === "remove") await api.mcpRemove(confirm.server.name);
            else await api.mcpLogout(confirm.server.name);
            setConfirm(null);
          }}
        >
          {confirm.kind === "remove"
            ? <p>Runs <code>claude mcp remove {confirm.server.name} --scope user</code>. Claude sessions (terminal and board) won't have it anymore.</p>
            : <p>Clears the saved login. Claude can't use this server until you log in again.</p>}
        </ConfirmDialog>
      )}
    </Modal>
  );
}

/** Registers `ckanban mcp` with Claude Code and Codex so they can create and manage tickets here. */
function AgentsSection() {
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.agents().then(setAgents, (e) => setErr(e.message));
  }, []);

  const act = async (a: AgentStatus, install: boolean) => {
    setBusy(a.id);
    setErr(null);
    try {
      setAgents(await (install ? api.agentInstall(a.id) : api.agentUninstall(a.id)));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mcp-section">
      <div className="inbox-board">Use this board from Claude Code / Codex</div>
      <span className="muted small">
        Adds the <code>ckanban</code> MCP server, so you can ask those agents things like "find what's left to do in this repo and put it on my board".
      </span>
      {err && <div className="form-error" role="alert">{err}</div>}
      {!agents && !err && <div className="muted small"><span className="spinner" /> Checking…</div>}
      {agents?.map((a) => {
        const [label, tone] = !a.installed ? ["Not added", "stopped"] : a.current ? ["Added", "ok"] : ["Old command", "blocked"];
        return (
          <div key={a.id} className="mcp-item">
            <div className="mcp-row">
              <div className="mcp-main">
                <div className="mcp-name">
                  <span>{a.label}</span>
                  <span className={`badge ${tone}`}>{label}</span>
                  {!a.available && <span className="badge stopped" title={`${a.id} isn't on PATH`}>not installed</span>}
                </div>
                {a.command && <span className="mcp-target" title={a.command}>{a.command}</span>}
                {a.installed && !a.current && <div className="mcp-msg">Points at another ckanban install. Click Update to use this one.</div>}
              </div>
              <div className="mcp-actions">
                {(!a.installed || !a.current) && (
                  <button className="btn small primary" disabled={busy === a.id} onClick={() => act(a, true)}>
                    {busy === a.id ? "Adding…" : a.installed ? "Update" : "Add"}
                  </button>
                )}
                {a.installed && (
                  <button className="btn small ghost danger" disabled={busy === a.id} onClick={() => act(a, false)}>Remove</button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

type Pair = { k: string; v: string };

function AddServerForm({ onAdded, initial, onCancel }: { onAdded: () => void; initial?: McpConfig; onCancel?: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? "stdio");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState(joinArgs(initial?.args ?? []));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [pairs, setPairs] = useState<Pair[]>(
    initial?.transport === "stdio" ? (initial.env ?? []).map((e) => ({ k: e.key, v: e.value }))
      : (initial?.headers ?? []).map((h) => ({ k: h.name, v: h.value })));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stdio = transport === "stdio";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const filled = pairs.filter((p) => p.k.trim() || p.v);
    const input: McpAddInput = stdio
      ? { name: name.trim(), transport, command: command.trim(), args: splitArgs(args), env: filled.map((p) => ({ key: p.k.trim(), value: p.v })) }
      : { name: name.trim(), transport, url: url.trim(), headers: filled.map((p) => ({ name: p.k.trim(), value: p.v })) };
    setBusy(true);
    setErr(null);
    try {
      if (initial) await api.mcpUpdate(initial.name, input);
      else await api.mcpAdd(input);
      onAdded();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const setPair = (i: number, patch: Partial<Pair>) => setPairs((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <form className="mcp-add" onSubmit={submit}>
      <div className="row two">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" spellCheck={false} autoFocus />
        </label>
        <div className="field">
          <div className="field-label">Transport</div>
          <div className="segmented" role="radiogroup" aria-label="Transport">
            {(["stdio", "http", "sse"] as const).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={transport === t} className={transport === t ? "on" : ""}
                onClick={() => { setTransport(t); setPairs([]); }}>
                {t === "stdio" ? "Command (stdio)" : t.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>
      {stdio ? (
        <div className="row two">
          <label>
            Command
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" spellCheck={false} />
          </label>
          <label>
            Arguments
            <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder='-y @modelcontextprotocol/server-github' spellCheck={false} />
          </label>
        </div>
      ) : (
        <label>
          URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
        </label>
      )}
      <div className="field">
        <div className="field-row">
          <span className="field-label">{stdio ? "Environment variables" : "Headers"}</span>
          <button type="button" className="link-btn small" onClick={() => setPairs((ps) => [...ps, { k: "", v: "" }])}>
            + Add {stdio ? "variable" : "header"}
          </button>
        </div>
        {pairs.map((p, i) => (
          <div key={i} className="mcp-pair">
            <input value={p.k} onChange={(e) => setPair(i, { k: e.target.value })} placeholder={stdio ? "API_KEY" : "Authorization"}
              aria-label={stdio ? "Variable name" : "Header name"} spellCheck={false} />
            <input type="password" value={p.v} onChange={(e) => setPair(i, { v: e.target.value })} placeholder="value"
              aria-label="Value" autoComplete="off" />
            <button type="button" className="icon-btn" aria-label="Remove" onClick={() => setPairs((ps) => ps.filter((_, j) => j !== i))}><CloseIcon /></button>
          </div>
        ))}
        <span className="muted small">
          {initial
            ? <>Saving runs <code>claude mcp remove</code> then <code>claude mcp add</code> with the new settings (user scope).</>
            : <>Added with <code>--scope user</code>, so every Claude session can use it.{!stdio && " If it uses OAuth, click Log in once it shows up."}</>}
        </span>
      </div>
      {err && <div className="form-error">{err}</div>}
      <div className="form-actions">
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
        <button type="submit" className="btn primary" disabled={busy || !name.trim() || (stdio ? !command.trim() : !url.trim())}>
          {initial ? (busy ? "Saving…" : "Save changes") : busy ? "Adding…" : "Add server"}
        </button>
      </div>
    </form>
  );
}
