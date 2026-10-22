import { AuthError, RateLimitError, type ProviderDef, type TriggerDef } from "../../src/server/integrations/types";

export interface Thing {
  id: string;
  name: string;
  color: string;
  size: string;
  at: string;
}

/**
 * A second integration that is not Linear: no sign-in step (a pasted token), one trigger with two filter fields.
 * It proves the generic loop, filter, template and catalog code needs no change to host a new provider.
 */
export function dummyProvider(world: { things: Thing[]; polls: number; fail: Error | null; load?: "ok" | "fail" }): ProviderDef {
  const trigger: TriggerDef = {
    id: "thing_added",
    label: "Thing added",
    fields: [
      {
        id: "color", label: "Color", operators: ["is", "is_not"],
        options: async () => [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }, { value: "@favorite", label: "My favorite" }],
        resolve: (value) => (value === "@favorite" ? "red" : value),
      },
      { id: "size", label: "Size", operators: ["is"] },
    ],
    variables: [{ name: "thing.name", label: "Name" }, { name: "thing.color", label: "Color" }],
    defaultInstructions: "Look at {{thing.name}}",
    initialCursor: (now) => now.toISOString(),
    async poll(_ctx, cursor) {
      world.polls++;
      if (world.fail) throw world.fail;
      // Includes the thing at the cursor itself, like a real "since" query: loops must not act on it twice.
      const events = world.things.filter((t) => t.at >= cursor).map((t) => ({
        key: t.id, at: t.at, title: `Thing ${t.name}`, url: `https://dummy.test/${t.id}`,
        fields: { color: [t.color], size: [t.size] }, vars: { "thing.name": t.name, "thing.color": t.color },
        ...(world.load ? { load: async () => { if (world.load === "fail") throw new Error("nope"); return { "thing.name": `Full ${t.name}` }; } } : {}),
      }));
      return { events, cursor: events.length ? events[events.length - 1].at : cursor };
    },
  };
  return {
    id: "dummy", name: "Dummy", steps: ["Paste any token."], fields: [{ id: "token", label: "Token", secret: true }],
    identify: async (token) => {
      if (token === "bad") throw new AuthError("bad token");
      return { userId: "u1", userName: "Dum", workspace: "Dummyland" };
    },
    triggers: [trigger],
  };
}

export { AuthError, RateLimitError };
