import type { Board } from "../board";
import { createTicketAction } from "./actions";
import { linear } from "./linear";
import { Registry } from "./registry";

/**
 * The registry the daemon uses. A new integration is one file that exports a ProviderDef, plus one line here;
 * a new action is one ActionDef in the second list.
 */
export function defaultRegistry(board: Board): Registry {
  return new Registry([linear], [createTicketAction(board)]);
}
