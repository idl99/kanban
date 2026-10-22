// What the server's automations API sends. Kept apart from api.ts (no browser types) so tests can import the helpers.

/** What the server's integrations registry offers: drawn by the Integrations and Automations dialogs, no provider-specific code. */
export interface IntegrationCatalog {
  callbackUrl: string;
  providers: {
    id: string;
    name: string;
    steps: string[];
    fields: { id: string; label: string; secret?: boolean }[];
    oauth: boolean;
    triggers: {
      id: string;
      label: string;
      fields: { id: string; label: string; operators: string[]; pick: boolean }[];
      variables: { name: string; label: string }[];
      defaultInstructions: string;
    }[];
  }[];
  actions: { id: string; label: string; settings: { id: string; label: string; kind: "select"; options: { value: string; label: string }[]; default: string }[] }[];
}

/** A signed-in account of another service; secret fields only show as "set". */
export interface IntegrationAccount {
  id: string;
  provider: string;
  providerName: string | null;
  status: "pending" | "connected" | "needs_reconnect";
  error: string | null;
  identity: { userId: string; userName: string; workspace: string } | null;
  createdAt: string;
  credentials: Record<string, string>;
  secretsSet: string[];
}

export interface LoopRule {
  field: string;
  op: string;
  values: string[];
}

export interface Loop {
  version: number;
  id: string;
  name: string;
  enabled: boolean;
  accountId: string;
  provider: string;
  trigger: string;
  match: "all" | "any";
  rules: LoopRule[];
  action: { type: string; settings: Record<string, string> };
  instructions: string;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
  state: "ok" | "unsupported" | "no_connection" | "needs_reconnect";
  problems: string[];
  account: string | null;
}

export type LoopInput = Pick<Loop, "name" | "enabled" | "accountId" | "trigger" | "match" | "rules" | "action" | "instructions">;
