// No imports from ./api: the server's tests import this file, and api.ts needs the browser's types.
interface Linkable { id: string; title: string; status: string; followUpOf?: string | null; createdAt: string }

/**
 * A proposal on this ticket becomes a follow-up (see ProposalCard's FollowUp) when the ticket already did its work:
 * it is in Review or Done, came back to Planning/Backlog from there, or ran before. Returns how the card names its
 * state ("Done", "In review", null when it only ran), or undefined for a ticket that never ran (Apply as usual).
 */
export function followUpState(t: { status: string; runCount: number; reopenedFrom?: { status: string; outcome?: string | null } | null }): string | null | undefined {
  const shaping = t.status === "planning" || t.status === "backlog";
  const was = shaping && t.reopenedFrom ? t.reopenedFrom.status : t.status;
  if (was === "done") return "Done";
  if (was === "review") return "In review";
  return t.runCount > 0 ? null : undefined;
}

/** The follow-up made from a proposal: a ticket linked to this one with the proposed title. */
export function followUpFor<T extends Pick<Linkable, "title" | "followUpOf">>(tickets: T[], of: string, title: string): T | undefined {
  return tickets.find((t) => t.followUpOf === of && t.title === title.trim());
}

/** Follow-up links for every ticket: the one it follows up, and its own follow-ups (oldest first). */
export interface FollowUpLinks { of?: Pick<Linkable, "id" | "title" | "status">; followUps: Pick<Linkable, "id" | "title">[] }
export function followUpLinks(tickets: Linkable[]): Map<string, FollowUpLinks> {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const out = new Map<string, FollowUpLinks>();
  const get = (id: string) => out.get(id) ?? out.set(id, { followUps: [] }).get(id)!;
  for (const t of [...tickets].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!t.followUpOf) continue;
    const src = byId.get(t.followUpOf);
    get(t.id).of = src ?? undefined;
    if (src) get(src.id).followUps.push(t);
  }
  return out;
}
