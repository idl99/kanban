/**
 * The shapes a provider (Linear, ...) and an action (create a ticket, ...) declare. Everything generic (the loop
 * poller, the filter and variable code, the Automations and Integrations dialogs) reads only these, so a new
 * provider, trigger, filter field or action is one definition plus one registry entry (registry.ts).
 */

export type Operator = "is" | "is_not";

export interface FieldOption {
  value: string;
  label: string;
}

/** What a provider gets to call its service: the clock and fetch are injected so tests need no network. */
export interface Deps {
  fetch: typeof fetch;
  now: () => Date;
}

export interface Identity {
  userId: string;
  userName: string;
  workspace: string;
}

export interface Tokens {
  access: string;
  refresh?: string;
  /** ISO time the access token stops working; missing: it doesn't expire. */
  expiresAt?: string;
}

/** The account a trigger polls as. `token()` refreshes the access token when it is about to expire. */
export interface AccountContext {
  id: string;
  identity: Identity;
  token(): Promise<string>;
  deps: Deps;
}

/** The service refused our credentials: the account needs to be connected again. */
export class AuthError extends Error {}

/** The service is rate limiting us: wait this long before the next call. */
export class RateLimitError extends Error {
  constructor(message: string, public retryAfterMs: number) {
    super(message);
  }
}

export interface FieldDef {
  id: string;
  label: string;
  operators: Operator[];
  /** The values to pick from (loaded when the user edits a rule); missing: the user types them. */
  options?: (ctx: AccountContext) => Promise<FieldOption[]>;
  /** Turns a picked value into what events carry, e.g. "@me" into the connected user's id. */
  resolve?: (value: string, identity: Identity) => string;
}

export interface VariableDef {
  /** Used as `{{name}}` in the instructions. */
  name: string;
  label: string;
}

/** One thing that happened in the service, in the generic shape loops work with. */
export interface IntegrationEvent {
  /** Stable per thing (e.g. the issue): a loop makes at most one ticket per key. */
  key: string;
  at: string;
  /** Ticket title. */
  title: string;
  /** Where to open it in the service. */
  url: string;
  /** Per filter field id: the values this event has (ids, to compare with the rule's values). */
  fields: Record<string, string[]>;
  /** Per variable name: its text. */
  vars: Record<string, string>;
  /**
   * Fetches what a list left out (e.g. a full description). Called only for an event that is about to run its action;
   * its values replace `vars`. If it fails the action still runs with `vars`.
   */
  load?: () => Promise<Record<string, string>>;
}

export interface PollResult {
  events: IntegrationEvent[];
  /** Where the next poll starts. Opaque to the poller. */
  cursor: string;
}

export interface TriggerDef {
  id: string;
  label: string;
  fields: FieldDef[];
  variables: VariableDef[];
  /** Instructions a new loop on this trigger starts with (using its variables). */
  defaultInstructions: string;
  /** The cursor a new (or newly enabled) loop starts from: it only sees events after this. */
  initialCursor(now: Date): string;
  /** Events since the cursor. May return events it already returned: loops skip keys they handled. */
  poll(ctx: AccountContext, cursor: string): Promise<PollResult>;
}

export interface SetupField {
  id: string;
  label: string;
  secret?: boolean;
}

export interface OAuthDef {
  /**
   * Registers ckanban with the service for this callback address (dynamic client registration), so nobody has to
   * create an app by hand. Returns the credentials to keep (e.g. clientId). Missing: the user pastes them.
   */
  register?(redirectUri: string, deps: Deps): Promise<Record<string, string>>;
  /** Sign in with a one-time proof (PKCE), for clients that have no secret. */
  pkce?: boolean;
  authorizeUrl(creds: Record<string, string>, redirectUri: string, state: string, challenge?: string): string;
  exchange(creds: Record<string, string>, code: string, redirectUri: string, deps: Deps, verifier?: string): Promise<Tokens>;
  refresh(creds: Record<string, string>, refreshToken: string, deps: Deps): Promise<Tokens>;
}

export interface ProviderDef {
  id: string;
  name: string;
  /** Plain-words setup steps; `{callback}` is replaced by the address the service sends the user back to. */
  steps: string[];
  fields: SetupField[];
  /** Missing: no sign-in step; the credential fields hold an access token under the id `token`. */
  oauth?: OAuthDef;
  /** Who the account is, once it can make calls (shown in Integrations; "Me" in filters). */
  identify(token: string, deps: Deps): Promise<Identity>;
  /** Optional: what the service's API looks like, saved after sign-in for a developer (no tokens, no private text). */
  diagnose?(token: string, deps: Deps): Promise<unknown>;
  triggers: TriggerDef[];
}

export interface SettingDef {
  id: string;
  label: string;
  kind: "select";
  options: FieldOption[];
  default: string;
}

export interface ActionContext {
  slug: string;
  loopId: string;
  loopName: string;
  provider: ProviderDef;
  /** The instructions with the event's variables filled in. */
  instructions: string;
  event: IntegrationEvent;
}

export interface ActionDef {
  id: string;
  label: string;
  settings: SettingDef[];
  /** Checks the loop's settings for this action; returns the cleaned copy or throws a plain-words message. */
  validate(settings: Record<string, unknown>): Record<string, string>;
  /** Does the thing; returns a short line for the loop's log ("created ticket t_..."). */
  run(ctx: ActionContext, settings: Record<string, string>): Promise<string>;
}
