import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmuxLeftovers } from "./artifact";
import { Board } from "./board";
import { Bus } from "./events";
import { createServer } from "./http";
import { Huddles } from "./huddle";
import { withUtf8Locale } from "./locale";
import { McpManager } from "./mcp";
import { startPoller } from "./prpoller";
import { Notifier } from "./notify";
import { PushService } from "./push";
import { RemoteAccess, remoteListenPort, remoteUrl } from "./remote";
import { Scheduler } from "./scheduler";
import { JobRunner } from "./jobs";
import { LimitWatcher } from "./limit";
import { startHuddleSessionWatcher } from "./huddle-session";
import { SessionCache, startSessionWatcher } from "./session";
import { ShellManager } from "./shell";
import { TerminalWatcher } from "./terminals";
import { defaultRoot, Store } from "./store";
import { VERSION } from "./version";
import { WEB_ASSETS } from "./web-assets.gen";
import { detectMissing } from "./worktree-setup";

export async function startDaemon(): Promise<void> {
  // Board runs and other children inherit this; an older launchd plist starts the daemon with no locale.
  Object.assign(process.env, withUtf8Locale(process.env));
  const store = new Store(defaultRoot());
  const config = store.config();
  const port = Number(process.env.CKANBAN_PORT) || config.port;
  const bus = new Bus();
  const sessions = new SessionCache();
  const shells = new ShellManager();
  void cleanupTmuxLeftovers();
  const board = new Board(store, bus, {
    claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude",
    sessionSummary: (id) => sessions.summary(id),
    findOwnedSession: (id) => shells.findSession(id),
    notify: (title, body) => notifier.macOnly(title, body),
  });
  // Links in notifications open the ticket on the phone when phone access is on (remote.json), else on this Mac.
  const remoteConfig = new RemoteAccess(store.root, () => 0);
  const push = new PushService(store.root);
  const notifier: Notifier = new Notifier(store, bus, {
    root: store.root, push, sessionSummary: (id) => sessions.summary(id), isRunning: (slug, id) => board.isRunning(slug, id),
    hostHuddles: (slug) => board.hostHuddles(slug),
    baseUrl: () => {
      const r = remoteConfig.active();
      return r ? remoteUrl(r.host) : `http://localhost:${server.port}`;
    },
  });
  const webDir = join(import.meta.dir, "..", "..", "web", "dist");
  const embedded = Object.keys(WEB_ASSETS).length > 0;
  if (!embedded && !existsSync(join(webDir, "index.html"))) console.warn("web UI not built yet: run `bun run build:web`");
  const terminals = new TerminalWatcher(store, bus, sessions);
  const mcp = new McpManager(bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude", seenFile: join(store.root, "mcp-seen.json") });
  const scheduler = new Scheduler(board, store, bus);
  const jobs = new JobRunner(board, store, bus, { notify: (title, body) => notifier.macOnly(title, body) });
  const huddles = new Huddles(store, board, bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude" });
  // launchd (KeepAlive) starts the daemon again once it exits.
  const restart = () => board.requestRestart(() => void shutdown());
  const remotePort = remoteListenPort(port, config.remotePort);
  const server = createServer({ store, bus, board, port, remotePort, webDir, sessions, terminals, shells, mcp, scheduler, jobs, huddles, assets: WEB_ASSETS, restart, notifier, push });
  console.log(`ckanban v${VERSION} listening on http://localhost:${server.port} (data: ${store.root})`);
  board.recover();
  huddles.recover();
  huddles.startWatchdog();
  void board.sweepWorktrees();
  void detectMissing(store, (profile) => bus.emit({ type: "profile.updated", slug: profile.slug, profile }));
  const stopPoller = startPoller(board, store, config.prPollMinutes);
  // After recover(): a missed run's ticket must not be mistaken for an interrupted one.
  const stopScheduler = scheduler.start();
  const stopJobs = jobs.start();
  const stopLimits = new LimitWatcher(board, store).start();
  const stopWatcher = startSessionWatcher(store, bus, sessions);
  const stopHuddleWatcher = startHuddleSessionWatcher(store, bus, (id) => sessions.version(id));
  const stopTerminals = terminals.start();
  const stopMcp = mcp.start();
  // After recover(): what already waits when the daemon starts doesn't notify again.
  const stopNotifier = notifier.start();

  const shutdown = async () => {
    console.log("ckanban shutting down");
    stopPoller();
    stopScheduler();
    stopJobs();
    stopLimits();
    stopWatcher();
    stopHuddleWatcher();
    stopTerminals();
    shells.killAll();
    stopMcp();
    stopNotifier();
    await Promise.all([board.shutdown(), huddles.shutdown()]);
    server.stop(true);
    server.remoteServer?.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
