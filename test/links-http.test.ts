import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { SessionCache } from "../src/server/session";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

let server: ReturnType<typeof createServer>;
let store: Store;
let base: string;
const configDir = tempDir("ck-claude-");

beforeAll(() => {
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const sessions = new SessionCache({ configDir });
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  server = createServer({ store, bus, board, sessions, port: 0, webDir: tempDir("ck-web-") });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const line = (o: object) => JSON.stringify(o);
const publish = (id: string, file: string, url: string, at: string) => [
  line({ type: "assistant", uuid: `a-${id}`, timestamp: at, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: `ckanban artifact publish ${file}` } }] } }),
  line({ type: "user", uuid: `u-${id}`, timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id, content: `Published ${file} at ${url}` }] } }),
].join("\n");
const writeSession = (sid: string, raw: string) => {
  mkdirSync(join(configDir, "projects", "-x"), { recursive: true });
  writeFileSync(join(configDir, "projects", "-x", `${sid}.jsonl`), raw + "\n");
};

test("ticket view lists the ticket's, its huddle teammates', its results' and its share links", async () => {
  let r = await fetch(`${base}/api/profiles`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "L", path: tempDir("ck-plain-") }) });
  const slug = ((await r.json()) as any).slug;
  r = await fetch(`${base}/api/profiles/${slug}/tickets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "T" }) });
  const id = ((await r.json()) as any).id;

  const own = crypto.randomUUID();
  const mate = crypto.randomUUID();
  writeSession(own, publish("t1", "/o/report.html", "https://claude.ai/artifact/Own1", "2026-10-11T09:00:00Z"));
  writeSession(mate, publish("t2", "/o/findings.html", "https://claude.ai/artifact/Mate1", "2026-10-11T10:00:00Z"));
  store.updateTicket(slug, id, {
    sessionId: own,
    shareLinks: [{ file: "out/page.html", url: "https://claude.ai/artifact/Share1", at: "2026-10-11T08:00:00Z" }],
  });
  store.addComment(slug, id, "ai", "Done: https://claude.ai/artifact/Res1 and https://docs.google.com/document/d/x");
  store.saveHuddle(slug, {
    id: "h_links", hostTicket: id, status: "closed", participants: [
      { handle: "researcher", kind: "agent", sessionId: mate, sessionStarted: true },
      { handle: "idle", kind: "agent", sessionId: crypto.randomUUID(), sessionStarted: false },
    ],
  } as any);

  r = await fetch(`${base}/api/profiles/${slug}/tickets/${id}`);
  const t = (await r.json()) as any;
  expect(t.links.map((l: any) => [l.url, l.source])).toEqual([
    ["https://claude.ai/artifact/Res1", "result"],
    ["https://claude.ai/artifact/Mate1", "huddle:@researcher"],
    ["https://claude.ai/artifact/Own1", "ticket"],
    ["https://claude.ai/artifact/Share1", "share"],
  ]);
});
