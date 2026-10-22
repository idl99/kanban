import { expect, test } from "bun:test";
import { descendsFrom, fromBoardProcess, lsofPids, parentMap } from "../src/server/integrations/guard";

test("a process tree is walked up to the daemon", () => {
  const parents = parentMap("  10 1\n  20 10\n  30 20\n  40 1\n");
  expect(descendsFrom(30, 10, parents)).toBe(true);
  expect(descendsFrom(10, 10, parents)).toBe(true);
  expect(descendsFrom(40, 10, parents)).toBe(false);
  expect(lsofPids("p123\nf7\np456\n")).toEqual([123, 456]);
});

test("a request from a child of the daemon is from a board process; one from the daemon's own process isn't", async () => {
  const seen: boolean[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      seen.push(await fromBoardProcess(srv.requestIP(req)?.port ?? 0));
      return new Response("ok");
    },
  });
  try {
    // curl started by this process: a descendant, like a run's shell.
    const p = Bun.spawn(["curl", "-s", `http://127.0.0.1:${server.port}/`], { stdout: "ignore", stderr: "ignore" });
    await p.exited;
    // This process itself: the daemon's own pid is never counted.
    await fetch(`http://127.0.0.1:${server.port}/`);
    expect(seen).toEqual([true, false]);
  } finally {
    server.stop(true);
  }
});
