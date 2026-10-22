import type { Board } from "../board";
import type { Status } from "../types";
import type { ActionDef } from "./types";

const COLUMNS = [
  { value: "ready", label: "Ready" },
  { value: "planning", label: "Planning" },
  { value: "backlog", label: "Backlog" },
];

/** The one action in v1: a ticket in the chosen column, with a link back to where the event came from. */
export function createTicketAction(board: Board): ActionDef {
  return {
    id: "create_ticket",
    label: "Create a ticket",
    settings: [{ id: "column", label: "Create the ticket in", kind: "select", options: COLUMNS, default: "ready" }],
    validate(settings) {
      const column = settings.column === undefined ? "ready" : String(settings.column);
      if (!COLUMNS.some((c) => c.value === column)) throw new Error("Pick Ready, Planning or Backlog for the new ticket");
      return { column };
    },
    async run(ctx, settings) {
      const t = await board.createTicket(ctx.slug, {
        title: ctx.event.title, body: ctx.instructions, status: settings.column as Status,
        source: { provider: ctx.provider.name, label: ctx.event.title, url: ctx.event.url, loopId: ctx.loopId },
      });
      return `created ticket ${t.id}`;
    },
  };
}
