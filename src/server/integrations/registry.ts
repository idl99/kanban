import type { ActionDef, ProviderDef, TriggerDef } from "./types";

/** What the UI needs to draw an integration, trigger or action, without any provider-specific code. */
export interface Catalog {
  callbackUrl: string;
  providers: {
    id: string;
    name: string;
    steps: string[];
    fields: ProviderDef["fields"];
    oauth: boolean;
    triggers: {
      id: string;
      label: string;
      fields: { id: string; label: string; operators: string[]; pick: boolean }[];
      variables: TriggerDef["variables"];
      defaultInstructions: string;
    }[];
  }[];
  actions: { id: string; label: string; settings: ActionDef["settings"] }[];
}

/** The providers and actions this build knows. To add one, write its definition and list it where the registry is made (index.ts). */
export class Registry {
  private providers = new Map<string, ProviderDef>();
  private actions = new Map<string, ActionDef>();

  constructor(providers: ProviderDef[], actions: ActionDef[]) {
    for (const p of providers) this.providers.set(p.id, p);
    for (const a of actions) this.actions.set(a.id, a);
  }

  provider(id: string): ProviderDef | null {
    return this.providers.get(id) ?? null;
  }

  trigger(providerId: string, triggerId: string): TriggerDef | null {
    return this.provider(providerId)?.triggers.find((t) => t.id === triggerId) ?? null;
  }

  action(id: string): ActionDef | null {
    return this.actions.get(id) ?? null;
  }

  catalog(callbackUrl: string): Catalog {
    return {
      callbackUrl,
      providers: [...this.providers.values()].map((p) => ({
        id: p.id, name: p.name, fields: p.fields, oauth: !!p.oauth,
        steps: p.steps.map((s) => s.replaceAll("{callback}", callbackUrl)),
        triggers: p.triggers.map((t) => ({
          id: t.id, label: t.label, variables: t.variables, defaultInstructions: t.defaultInstructions,
          fields: t.fields.map((f) => ({ id: f.id, label: f.label, operators: f.operators, pick: !!f.options })),
        })),
      })),
      actions: [...this.actions.values()].map((a) => ({ id: a.id, label: a.label, settings: a.settings })),
    };
  }
}
