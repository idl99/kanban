import type { IntegrationAccount, IntegrationCatalog, Loop, LoopRule } from "./automationTypes";

type Provider = IntegrationCatalog["providers"][number];
export type CatalogTrigger = Provider["triggers"][number];

export const OPERATOR_LABEL: Record<string, string> = { is: "is", is_not: "is not" };
export const MATCH_LABEL = { all: "all (AND)", any: "any (OR)" } as const;
/** The columns a loop may create tickets in come from the action's settings; this is only the fallback label. */
export const NO_RULES = "No rules: every event counts.";

export const providerOf = (catalog: IntegrationCatalog | null, id: string): Provider | undefined => catalog?.providers.find((p) => p.id === id);

export const triggerOf = (catalog: IntegrationCatalog | null, provider: string, trigger: string): CatalogTrigger | undefined =>
  providerOf(catalog, provider)?.triggers.find((t) => t.id === trigger);

/** "Linear · Issue assigned": what the list shows under a loop's name. */
export function loopSubtitle(catalog: IntegrationCatalog | null, l: Pick<Loop, "provider" | "trigger">): string {
  const p = providerOf(catalog, l.provider);
  const t = p?.triggers.find((x) => x.id === l.trigger);
  return `${p?.name ?? l.provider} · ${t?.label ?? l.trigger}`;
}

/** A new rule on the trigger's first field, with that field's first operator. */
export function newRule(trigger: CatalogTrigger): LoopRule {
  const f = trigger.fields[0];
  return { field: f?.id ?? "", op: f?.operators[0] ?? "is", values: [] };
}

/** Changing a rule's field resets what only fitted the old one (the operator if not allowed, the values). */
export function withField(trigger: CatalogTrigger, rule: LoopRule, field: string): LoopRule {
  const f = trigger.fields.find((x) => x.id === field);
  return { field, op: f?.operators.includes(rule.op) ? rule.op : f?.operators[0] ?? "is", values: [] };
}

/** The text with `insert` in place of the selection, and where the caret goes after it. */
export function insertAt(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  const a = Math.max(0, Math.min(start, text.length));
  const b = Math.max(a, Math.min(end, text.length));
  return { text: text.slice(0, a) + insert + text.slice(b), caret: a + insert.length };
}

/** Plain-words label and badge colour for a connection's state. */
export function accountState(a: Pick<IntegrationAccount, "status">): { label: string; tone: "ok" | "blocked" | "failed" } {
  if (a.status === "connected") return { label: "Connected", tone: "ok" };
  if (a.status === "needs_reconnect") return { label: "Needs sign-in", tone: "failed" };
  return { label: "Waiting for sign-in", tone: "blocked" };
}

/** Plain-words label for a loop in the list: why it isn't running, or whether it is. */
export function loopStatus(l: Pick<Loop, "enabled" | "state">): { label: string; tone: "ok" | "stopped" | "blocked" | "failed" } {
  if (l.state === "unsupported") return { label: "Not supported", tone: "failed" };
  if (l.state !== "ok") return { label: "Needs connection", tone: "blocked" };
  return l.enabled ? { label: "On", tone: "ok" } : { label: "Off", tone: "stopped" };
}

/** Values added once, in order; removing one that isn't there changes nothing. */
export const addValue = (values: string[], v: string): string[] => (v && !values.includes(v) ? [...values, v] : values);
export const removeValue = (values: string[], v: string): string[] => values.filter((x) => x !== v);
