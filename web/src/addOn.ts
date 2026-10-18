// No imports from ./api: the server's tests import this file, and api.ts needs the browser's types.
interface Linkable { id: string; title: string; status: string; addOnOf?: string | null; createdAt: string }

/**
 * A proposal on this ticket becomes an add-on ticket (see ProposalCard's AddOn) when the ticket already did its work:
 * it is in Review or Done, came back to Planning/Backlog from there, or ran before. Returns how the card names its
 * state ("Done", "In review", null when it only ran), or undefined for a ticket that never ran (Apply as usual).
 */
export function addOnState(t: { status: string; runCount: number; reopenedFrom?: { status: string; outcome?: string | null } | null }): string | null | undefined {
  const shaping = t.status === "planning" || t.status === "backlog";
  const was = shaping && t.reopenedFrom ? t.reopenedFrom.status : t.status;
  if (was === "done") return "Done";
  if (was === "review") return "In review";
  return t.runCount > 0 ? null : undefined;
}

/** The add-on made from a proposal: a ticket linked to this one with the proposed title. */
export function addOnFor<T extends Pick<Linkable, "title" | "addOnOf">>(tickets: T[], of: string, title: string): T | undefined {
  return tickets.find((t) => t.addOnOf === of && t.title === title.trim());
}

/** Add-on links for every ticket: the one it is an add-on to, and its own add-ons (oldest first). */
export interface AddOnLinks { of?: Pick<Linkable, "id" | "title" | "status">; addOns: Pick<Linkable, "id" | "title">[] }
export function addOnLinks(tickets: Linkable[]): Map<string, AddOnLinks> {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const out = new Map<string, AddOnLinks>();
  const get = (id: string) => out.get(id) ?? out.set(id, { addOns: [] }).get(id)!;
  for (const t of [...tickets].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!t.addOnOf) continue;
    const src = byId.get(t.addOnOf);
    get(t.id).of = src ?? undefined;
    if (src) get(src.id).addOns.push(t);
  }
  return out;
}
