import { listOf, McpClient, shapeOf } from "./mcp-client";
import {
  AuthError, type AccountContext, type Deps, type FieldOption, type Identity, type IntegrationEvent, type ProviderDef, type Tokens, type TriggerDef,
} from "./types";

// Linear's own MCP server signs clients in by itself (RFC 7591), so no workspace admin has to create an OAuth app.
// Its tokens only work on that server (Linear's GraphQL API answers 401), so ckanban reads issues through its tools.
const MCP_URL = "https://mcp.linear.app/mcp";
const TOKEN_URL = "https://mcp.linear.app/token";
const AUTHORIZE_URL = "https://mcp.linear.app/authorize";
const REGISTER_URL = "https://mcp.linear.app/register";
/** Items asked for per page (Linear's list_projects allows 50, the others 250), and most pages one poll reads: a loop that falls further behind catches up on the next polls. */
const PAGE = 50;
const MAX_PAGES = 10;
/** What a poll asks list_issues to include. Named fields come back as null when empty; the default answer leaves some out. */
const ISSUE_FIELDS = ["id", "title", "description", "url", "createdAt", "updatedAt", "team", "teamId", "assignee", "assigneeId", "project", "projectId"];
/** "Me" in the assignee filter: the connected user. */
export const ME = "@me";

async function tokenCall(creds: Record<string, string>, params: Record<string, string>, deps: Deps): Promise<Tokens> {
  const res = await deps.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: creds.clientId ?? "", ...(creds.clientSecret ? { client_secret: creds.clientSecret } : {}) }).toString(),
  });
  let b: any = {};
  try {
    b = await res.json();
  } catch {}
  if (!res.ok || !b.access_token) {
    const why = String(b.error_description ?? b.error ?? `status ${res.status}`);
    if (params.grant_type === "refresh_token") throw new AuthError(`Linear refused to renew the connection: ${why}`);
    throw new Error(`Linear refused the sign-in: ${why}`);
  }
  const seconds = Number(b.expires_in);
  return {
    access: String(b.access_token),
    ...(b.refresh_token ? { refresh: String(b.refresh_token) } : {}),
    ...(Number.isFinite(seconds) && seconds > 0 ? { expiresAt: new Date(deps.now().getTime() + seconds * 1000).toISOString() } : {}),
  };
}

const client = async (ctx: AccountContext) => new McpClient(MCP_URL, await ctx.token(), ctx.deps);

const text = (v: unknown): string => (typeof v === "string" ? v : "");
/** Linear's issue `id` is its identifier ("ENG-123"); a long id with dashes only is a UUID. */
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v);
/** A reference to a team, project or person comes as an object, or as just its name. */
const nameOf = (v: any): string => (typeof v === "string" ? v : text(v?.name) || text(v?.displayName));
const idOf = (v: any): string => text(v?.id);

/** Every item of a listing tool, following its cursor. */
async function listAll(c: McpClient, tool: string, keys: string[], args: Record<string, unknown> = {}, pages = 5): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    const data: any = await c.call(tool, { ...args, limit: PAGE, ...(cursor ? { cursor } : {}) });
    out.push(...listOf(data, ...keys));
    cursor = data?.hasNextPage && typeof data.cursor === "string" ? data.cursor : undefined;
    if (!cursor) break;
  }
  return out;
}

const byName = (a: FieldOption, b: FieldOption) => a.label.localeCompare(b.label);
const option = (x: any): FieldOption => ({ value: idOf(x), label: nameOf(x) });

const teamOptions = async (ctx: AccountContext): Promise<FieldOption[]> =>
  (await listAll(await client(ctx), "list_teams", ["teams"])).map(option).filter((o) => o.value && o.label).sort(byName);

const projectOptions = async (ctx: AccountContext): Promise<FieldOption[]> =>
  (await listAll(await client(ctx), "list_projects", ["projects"])).map(option).filter((o) => o.value && o.label).sort(byName);

const assigneeOptions = async (ctx: AccountContext): Promise<FieldOption[]> => [
  { value: ME, label: `Me (${ctx.identity.userName})` },
  ...(await listAll(await client(ctx), "list_users", ["users"])).filter((u) => u.isActive !== false && u.active !== false).map(option).filter((o) => o.value && o.label).sort(byName),
];

const FIELDS: TriggerDef["fields"] = [
  { id: "team", label: "Team", operators: ["is", "is_not"], options: teamOptions },
  { id: "project", label: "Project", operators: ["is", "is_not"], options: projectOptions },
  {
    id: "assignee", label: "Assignee", operators: ["is", "is_not"], options: assigneeOptions,
    resolve: (value, identity) => (value === ME ? identity.userId : value),
  },
];

const VARIABLES: TriggerDef["variables"] = [
  { name: "issue.identifier", label: "Issue ID, like ENG-123" },
  { name: "issue.title", label: "Title" },
  { name: "issue.description", label: "Description" },
  { name: "issue.url", label: "Link to the issue" },
  { name: "issue.team", label: "Team name" },
  { name: "issue.project", label: "Project name" },
  { name: "issue.assignee", label: "Assignee name" },
];

const DEFAULT_INSTRUCTIONS = "Work on Linear issue {{issue.identifier}}: {{issue.title}}\n\n{{issue.description}}\n\nLink: {{issue.url}}";

/** Teams, projects and people by id, name and uuid, for answers that give an issue's team, project or person only by name. Loaded once per poll, only when needed. */
class Lookup {
  private loaded = new Map<string, Promise<any[]>>();
  constructor(private c: McpClient) {}
  private all(tool: string, key: string) {
    let p = this.loaded.get(tool);
    if (!p) {
      p = listAll(this.c, tool, [key]);
      this.loaded.set(tool, p);
    }
    return p;
  }
  /** Every id the item is known by (its `id` and `uuid`), for items matching a given id or uuid or the name. */
  async ids(tool: string, key: string, known: string[], name: string): Promise<string[]> {
    const out = new Set(known);
    if (!known.length && !name) return [];
    for (const x of await this.all(tool, key)) {
      if (known.some((k) => k === idOf(x) || k === text(x?.uuid)) || (!known.length && name && nameOf(x) === name)) {
        for (const id of [idOf(x), text(x?.uuid)]) if (id) out.add(id);
      }
    }
    return [...out];
  }
}

async function eventOf(issue: any, at: string, lookup: Lookup, c: McpClient): Promise<IntegrationEvent> {
  const id = text(issue.id);
  const identifier = text(issue.identifier) || (isUuid(id) ? "" : id);
  const team = nameOf(issue.team);
  const project = nameOf(issue.project);
  const assignee = nameOf(issue.assignee);
  const own = (flat: unknown, nested: any) => [text(flat), idOf(nested)].filter(Boolean);
  const [teams, projects, people] = await Promise.all([
    lookup.ids("list_teams", "teams", own(issue.teamId, issue.team), team),
    lookup.ids("list_projects", "projects", own(issue.projectId, issue.project), project),
    lookup.ids("list_users", "users", own(issue.assigneeId, issue.assignee), assignee),
  ]);
  return {
    key: id, at, title: `${identifier} ${text(issue.title)}`.trim(), url: text(issue.url),
    fields: { team: teams, project: projects, assignee: people },
    vars: {
      "issue.identifier": identifier, "issue.title": text(issue.title), "issue.description": text(issue.description),
      "issue.url": text(issue.url), "issue.team": team, "issue.project": project, "issue.assignee": assignee,
    },
    // Lists cut the description short; the full text is only fetched for an issue that runs an action.
    load: async (): Promise<Record<string, string>> => {
      const full: any = await c.call("get_issue", { id, fields: ["description"] });
      return typeof full?.description === "string" ? { "issue.description": full.description } : {};
    },
  };
}

/** Issues whose `dateField` is after `since`, oldest first, up to MAX_PAGES pages. */
async function issuesSince(ctx: AccountContext, dateField: "createdAt" | "updatedAt", since: string): Promise<{ issues: any[]; lookup: Lookup; c: McpClient }> {
  const c = await client(ctx);
  const issues = await listAll(c, "list_issues", ["issues"], { orderBy: dateField, [dateField]: since, fields: ISSUE_FIELDS }, MAX_PAGES);
  return {
    issues: issues.filter((i) => text(i.id) && text(i[dateField]) >= since).sort((a, b) => text(a[dateField]).localeCompare(text(b[dateField]))),
    lookup: new Lookup(c), c,
  };
}

const created: TriggerDef = {
  id: "issue_created", label: "Issue created", fields: FIELDS, variables: VARIABLES, defaultInstructions: DEFAULT_INSTRUCTIONS,
  initialCursor: (now) => now.toISOString(),
  async poll(ctx, cursor) {
    const { issues, lookup, c } = await issuesSince(ctx, "createdAt", cursor);
    return {
      events: await Promise.all(issues.map((i) => eventOf(i, text(i.createdAt), lookup, c))),
      cursor: issues.length ? text(issues[issues.length - 1].createdAt) : cursor,
    };
  },
};

// Linear's tools say who an issue is assigned to, not when that changed. So an issue counts as assigned the first
// time it shows up with an assignee after the loop started (it was created or edited since). The loop's dedupe
// keeps that to one ticket per issue.
const assigned: TriggerDef = {
  id: "issue_assigned", label: "Issue assigned", fields: FIELDS, variables: VARIABLES, defaultInstructions: DEFAULT_INSTRUCTIONS,
  initialCursor: (now) => now.toISOString(),
  async poll(ctx, cursor) {
    const { issues, lookup, c } = await issuesSince(ctx, "updatedAt", cursor);
    const withAssignee = issues.filter((i) => nameOf(i.assignee) || text(i.assigneeId));
    return {
      events: await Promise.all(withAssignee.map((i) => eventOf(i, text(i.updatedAt), lookup, c))),
      cursor: issues.length ? text(issues[issues.length - 1].updatedAt) : cursor,
    };
  },
};

export const linear: ProviderDef = {
  id: "linear",
  name: "Linear",
  steps: [
    "Press Authorize with Linear. A new tab opens on Linear's own page.",
    "Approve ckanban there. It only asks to read your issues, teams, projects and people.",
    "If Linear says your workspace doesn't allow it, ask a Linear admin to allow ckanban for you.",
  ],
  fields: [],
  oauth: {
    pkce: true,
    async register(redirectUri, deps) {
      const res = await deps.fetch(REGISTER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "ckanban", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"], token_endpoint_auth_method: "none", scope: "read",
        }),
      });
      let b: any = {};
      try {
        b = await res.json();
      } catch {}
      if (!res.ok || !b.client_id) throw new Error(String(b.error_description ?? b.error ?? `status ${res.status}`));
      return { clientId: String(b.client_id) };
    },
    authorizeUrl: (creds, redirectUri, state, challenge) => `${AUTHORIZE_URL}?${new URLSearchParams({
      client_id: creds.clientId ?? "", redirect_uri: redirectUri, response_type: "code", scope: "read", state,
      ...(challenge ? { code_challenge: challenge, code_challenge_method: "S256" } : {}),
    })}`,
    exchange: (creds, code, redirectUri, deps, verifier) =>
      tokenCall(creds, { grant_type: "authorization_code", code, redirect_uri: redirectUri, ...(verifier ? { code_verifier: verifier } : {}) }, deps),
    refresh: (creds, refreshToken, deps) => tokenCall(creds, { grant_type: "refresh_token", refresh_token: refreshToken }, deps),
  },
  async identify(token, deps): Promise<Identity> {
    const c = new McpClient(MCP_URL, token, deps);
    const me: any = await c.call("get_user", { query: "me" }).catch((e) => {
      // Signed in, but Linear's server turns the new token away: say so instead of "no longer accepts".
      if (e instanceof AuthError) throw new Error("Linear signed you in but did not let ckanban read your issues. Ask a Linear admin to allow ckanban for your workspace.");
      throw e;
    });
    const workspace: any = await c.call("get_workspace", {}).catch(() => null);
    return { userId: idOf(me), userName: nameOf(me) || "Linear user", workspace: nameOf(workspace) || text(workspace?.urlKey) || "Linear" };
  },
  /** What Linear's tools look like (their definitions, and the shape of a few answers without private text), for a developer. */
  async diagnose(token, deps) {
    const c = new McpClient(MCP_URL, token, deps);
    const tools = await c.listTools();
    const sample = async (name: string, args: Record<string, unknown>) => ({ name, args, shape: await c.call(name, args).then((r) => shapeOf(r)).catch((e) => `failed: ${(e as Error).message}`) });
    return {
      tools: tools.filter((t) => /^(list|get)_(issues?|teams?|projects?|users?|workspace)$/.test(t.name)),
      samples: [
        await sample("get_user", { query: "me" }), await sample("get_workspace", {}), await sample("list_teams", { limit: 2 }),
        await sample("list_projects", { limit: 2 }), await sample("list_users", { limit: 2 }), await sample("list_issues", { limit: 2, orderBy: "updatedAt" }),
      ],
    };
  },
  triggers: [created, assigned],
};
