import { expect, test } from "bun:test";
import { fetchUsage, normalizeUsage, parseCredentials, USAGE_URL } from "../src/server/usage";
import { pillText, resetText, shortLabel, usageTone, worstTone } from "../web/src/usage";

const FULL = {
  five_hour: { utilization: 42, resets_at: "2026-10-05T16:10:00+00:00" },
  seven_day: { utilization: 81.4, resets_at: "2026-10-09T09:00:00+00:00" },
  seven_day_opus: { utilization: 12, resets_at: "2026-10-09T09:00:00+00:00" },
  seven_day_oauth_apps: null,
  extra_usage: { is_enabled: false, used_credits: null },
};

test("normalizeUsage maps a full response in plan order", () => {
  expect(normalizeUsage(FULL)).toEqual([
    { key: "five_hour", label: "Current session (5h)", percent: 42, resetsAt: "2026-10-05T16:10:00+00:00" },
    { key: "seven_day", label: "Week · all models", percent: 81.4, resetsAt: "2026-10-09T09:00:00+00:00" },
    { key: "seven_day_opus", label: "Week · Opus", percent: 12, resetsAt: "2026-10-09T09:00:00+00:00" },
  ]);
});

test("normalizeUsage skips null windows and keeps unknown window keys", () => {
  const w = normalizeUsage({
    seven_day_sonnet: { utilization: 3, resets_at: null },
    five_hour: null,
    seven_day: { utilization: 150, resets_at: "not a date" },
    seven_day_haiku_extra: { utilization: 5 },
    some_flag: true,
  })!;
  expect(w.map((x) => x.key)).toEqual(["seven_day", "seven_day_sonnet", "seven_day_haiku_extra"]);
  expect(w[0]).toMatchObject({ percent: 100, resetsAt: null });
  expect(w[2].label).toBe("Week · haiku extra");
});

test("normalizeUsage rejects a bad shape", () => {
  expect(normalizeUsage(null)).toBeNull();
  expect(normalizeUsage("nope")).toBeNull();
  expect(normalizeUsage([1, 2])).toBeNull();
  expect(normalizeUsage({ error: { type: "x" } })).toBeNull();
  // Known keys but all empty: valid, just no windows.
  expect(normalizeUsage({ five_hour: null, seven_day: null })).toEqual([]);
});

test("parseCredentials", () => {
  expect(parseCredentials('{"claudeAiOauth":{"accessToken":"t","expiresAt":5}}')).toEqual({ token: "t", expiresAt: 5 });
  expect(parseCredentials("{}")).toHaveProperty("error");
  expect(parseCredentials("garbage")).toHaveProperty("error");
});

const creds = (expiresAt: number | null = null) => async () => ({ token: "secret-token", expiresAt });

test("fetchUsage sends the token only to Anthropic and never returns it", async () => {
  let seen: { url: string; auth: string | null } | null = null;
  const f = (async (url: string, init: RequestInit) => {
    seen = { url, auth: new Headers(init.headers).get("authorization") };
    return new Response(JSON.stringify(FULL));
  }) as unknown as typeof fetch;
  const r = await fetchUsage({ credentials: creds(), fetchFn: f, now: () => 0 });
  expect(seen!).toEqual({ url: USAGE_URL, auth: "Bearer secret-token" });
  expect("windows" in r && r.windows.length).toBe(3);
  expect(JSON.stringify(r)).not.toContain("secret-token");
});

test("fetchUsage explains failures in plain words", async () => {
  const never = (async () => { throw new Error("should not fetch"); }) as unknown as typeof fetch;
  expect(await fetchUsage({ credentials: async () => ({ error: "Not logged in to Claude Code" }), fetchFn: never }))
    .toMatchObject({ error: "Not logged in to Claude Code" });
  expect(await fetchUsage({ credentials: creds(1000), fetchFn: never, now: () => 2000 }))
    .toMatchObject({ error: expect.stringContaining("Token expired") });
  const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  expect(await fetchUsage({ credentials: creds(), fetchFn: offline })).toMatchObject({ error: expect.stringContaining("offline") });
  const status = (n: number) => (async () => new Response("{}", { status: n })) as unknown as typeof fetch;
  expect(await fetchUsage({ credentials: creds(), fetchFn: status(401) })).toMatchObject({ error: expect.stringContaining("Token rejected") });
  expect(await fetchUsage({ credentials: creds(), fetchFn: status(500) })).toMatchObject({ error: "Anthropic answered HTTP 500" });
  const weird = (async () => new Response("<html>")) as unknown as typeof fetch;
  expect(await fetchUsage({ credentials: creds(), fetchFn: weird })).toMatchObject({ error: expect.stringContaining("Unexpected") });
});

test("pill colour thresholds", () => {
  expect(usageTone(0)).toBe("ok");
  expect(usageTone(79.9)).toBe("ok");
  expect(usageTone(80)).toBe("warn");
  expect(usageTone(94.9)).toBe("warn");
  expect(usageTone(95)).toBe("err");
  const w = (key: string, percent: number) => ({ key, label: key, percent, resetsAt: null });
  expect(worstTone([w("five_hour", 10), w("seven_day", 85)])).toBe("warn");
  expect(worstTone([w("five_hour", 99), w("seven_day", 85)])).toBe("err");
  expect(worstTone([])).toBe("ok");
});

test("pillText and resetText", () => {
  const w = (key: string, percent: number) => ({ key, label: key, percent, resetsAt: null });
  expect(pillText([w("five_hour", 42.4), w("seven_day", 81), w("seven_day_opus", 12)])).toBe("Usage · 5h 42% · week 81%");
  const now = Date.parse("2026-10-05T12:00:00Z");
  expect(resetText(null, now)).toBeNull();
  expect(resetText("2026-10-05T14:15:00Z", now)).toMatch(/^Resets .+ \(in 2h 15m\)$/);
  expect(resetText("2026-10-09T09:00:00Z", now)).not.toContain("(in");
  expect(resetText("2026-10-05T11:00:00Z", now)).toBe("Resets now");
});

test("shortLabel names the 5h and week windows briefly, keeps other labels", () => {
  const w = (key: string, label: string) => ({ key, label, percent: 0, resetsAt: null });
  expect(shortLabel(w("five_hour", "Current session (5h)"))).toBe("5h");
  expect(shortLabel(w("seven_day", "Week · all models"))).toBe("Week");
  expect(shortLabel(w("seven_day_opus", "Week · Opus"))).toBe("Week · Opus");
});
