import { expect, test } from "bun:test";
import { caffeinateArgv, StayAwake, type Hold } from "../src/server/awake";

/** A stand-in for spawn: records each hold; end() makes one exit on its own. */
function fakeSpawn() {
  const holds: { argv: string[]; killed: boolean; end: () => void }[] = [];
  const spawn = (argv: string[]): Hold => {
    let end!: () => void;
    const exited = new Promise<void>((r) => (end = r));
    const h = { argv, killed: false, end };
    holds.push(h);
    return { kill: () => { h.killed = true; end(); }, exited };
  };
  return { holds, spawn };
}

function setup(platform = "darwin") {
  let busy = false;
  const changes: boolean[] = [];
  const { holds, spawn } = fakeSpawn();
  const awake = new StayAwake({ wanted: () => busy, onChange: (h) => changes.push(h), platform, pid: 4242, spawn });
  return { awake, holds, changes, setBusy: (b: boolean) => (busy = b) };
}

test("caffeinate prevents idle sleep and exits with the daemon", () => {
  expect(caffeinateArgv(4242)).toEqual(["caffeinate", "-i", "-w", "4242"]);
});

test("holds the Mac awake while there is work and lets go once it is done", () => {
  const { awake, holds, changes, setBusy } = setup();
  awake.check();
  expect(holds).toHaveLength(0);
  setBusy(true);
  awake.check();
  awake.check();
  expect(holds).toHaveLength(1);
  expect(holds[0].argv).toEqual(["caffeinate", "-i", "-w", "4242"]);
  expect(awake.held()).toBe(true);
  setBusy(false);
  awake.check();
  expect(holds[0].killed).toBe(true);
  expect(awake.held()).toBe(false);
  expect(changes).toEqual([true, false]);
});

test("does nothing on other systems", () => {
  const { awake, holds, setBusy } = setup("linux");
  setBusy(true);
  awake.check();
  expect(holds).toHaveLength(0);
  expect(awake.held()).toBe(false);
});

test("starts a new hold when caffeinate exits on its own while work goes on", async () => {
  const { awake, holds, changes, setBusy } = setup();
  setBusy(true);
  awake.check();
  holds[0].end();
  await Bun.sleep(0);
  expect(awake.held()).toBe(false);
  awake.check();
  expect(holds).toHaveLength(2);
  expect(changes).toEqual([true, false, true]);
});

test("a caffeinate that can't start is tried once, not on every check", () => {
  let tries = 0;
  const awake = new StayAwake({ wanted: () => true, platform: "darwin", spawn: () => { tries++; throw new Error("ENOENT"); } });
  awake.check();
  awake.check();
  expect(tries).toBe(1);
  expect(awake.held()).toBe(false);
});

test("stopping the watcher ends the hold", () => {
  const { awake, holds, setBusy } = setup();
  setBusy(true);
  const stop = awake.start();
  expect(awake.held()).toBe(true);
  stop();
  expect(holds[0].killed).toBe(true);
  expect(awake.held()).toBe(false);
});
