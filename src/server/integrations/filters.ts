import type { FieldDef, IntegrationEvent, Identity, Operator, TriggerDef } from "./types";

export interface Rule {
  field: string;
  op: Operator;
  values: string[];
}

export type Match = "all" | "any";

export const OPERATOR_LABEL: Record<Operator, string> = { is: "is", is_not: "is not" };

/** Plain-words problem with the rules, or null when each rule uses a field of the trigger and an operator it allows. */
export function ruleError(trigger: TriggerDef, rules: Rule[]): string | null {
  for (const r of rules) {
    const f = trigger.fields.find((x) => x.id === r.field);
    if (!f) return `"${r.field}" is not a filter for ${trigger.label}`;
    if (!f.operators.includes(r.op)) return `${f.label} can't use "${OPERATOR_LABEL[r.op] ?? r.op}"`;
    if (!r.values.length) return `Pick a value for ${f.label}`;
  }
  return null;
}

function ruleHolds(f: FieldDef, r: Rule, event: IntegrationEvent, identity: Identity): boolean {
  const have = event.fields[r.field] ?? [];
  const want = r.values.map((v) => f.resolve?.(v, identity) ?? v);
  const hit = want.some((v) => have.includes(v));
  return r.op === "is" ? hit : !hit;
}

/** AND: every rule holds; OR: at least one does. No rules: everything matches. A rule on an unknown field never holds. */
export function matches(trigger: TriggerDef, match: Match, rules: Rule[], event: IntegrationEvent, identity: Identity): boolean {
  if (!rules.length) return true;
  const held = rules.map((r) => {
    const f = trigger.fields.find((x) => x.id === r.field);
    return f ? ruleHolds(f, r, event, identity) : false;
  });
  return match === "any" ? held.some(Boolean) : held.every(Boolean);
}
