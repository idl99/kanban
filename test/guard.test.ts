import { expect, test } from "bun:test";
import { commandMap, descendsFrom, drivenBrowser, fromUserBrowser, isBrowser, lsofPids, parentMap } from "../src/server/integrations/guard";

test("a process tree is walked up to the daemon", () => {
  const parents = parentMap("  10 1\n  20 10\n  30 20\n  40 1\n");
  expect(descendsFrom(30, 10, parents)).toBe(true);
  expect(descendsFrom(10, 10, parents)).toBe(true);
  expect(descendsFrom(40, 10, parents)).toBe(false);
  expect(lsofPids("p123\nf7\np456\n")).toEqual([123, 456]);
});

test("only browsers count as the user", () => {
  expect(isBrowser("/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper")).toBe(true);
  expect(isBrowser("/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking")).toBe(true);
  expect(isBrowser("/Applications/Firefox.app/Contents/MacOS/firefox")).toBe(true);
  expect(isBrowser("/usr/bin/curl")).toBe(false);
  expect(isBrowser("/opt/homebrew/bin/bun")).toBe(false);
  expect(isBrowser("/tmp/Google Chrome-ish/curl")).toBe(false);
  expect(commandMap("  12 /usr/bin/curl -s\n 3 /bin/zsh\n").get(12)).toBe("/usr/bin/curl -s");
});

test("a browser started headless or with remote debugging, or a helper under one, isn't the user", () => {
  const parents = parentMap("  50 1\n  51 50\n  60 1\n  61 60\n");
  const args = commandMap("  50 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-port=9222\n  51 /Applications/Google Chrome.app/.../Google Chrome Helper --type=utility\n  60 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n  61 /Applications/Google Chrome.app/.../Google Chrome Helper --type=utility\n");
  expect(drivenBrowser(51, parents, args)).toBe(true);
  expect(drivenBrowser(61, parents, args)).toBe(false);
});

test("a program, a child of the daemon or one that detached from it, is never the user; nothing found isn't either", async () => {
  const seen: boolean[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      seen.push(await fromUserBrowser(srv.requestIP(req)?.port ?? 0));
      return new Response("ok");
    },
  });
  try {
    // curl started by this process: a child, like a run's shell.
    await Bun.spawn(["curl", "-s", `http://127.0.0.1:${server.port}/`], { stdout: "ignore", stderr: "ignore" }).exited;
    // A double fork: curl reparented away from this process, like a run that detaches.
    await Bun.spawn(["/bin/sh", "-c", `( curl -s http://127.0.0.1:${server.port}/ >/dev/null & ) ; sleep 0.1`], { stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.sleep(500);
    // This process itself: the daemon's own pid is never counted, so nothing is found.
    await fetch(`http://127.0.0.1:${server.port}/`);
    expect(seen).toEqual([false, false, false]);
  } finally {
    server.stop(true);
  }
  expect(await fromUserBrowser(0)).toBe(false);
});
