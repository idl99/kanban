# Automations and the Linear connection

An automation ("loop") turns something that happens in Linear into a ticket on one board. You set it up once; after that the board checks Linear about once a minute while ckanban runs.

## 1. Connect Linear (once, for all boards)

You don't need to create an app or an API key in Linear, and no admin has to. ckanban signs in the same way Claude does: it registers itself with Linear's own server and asks you to approve it. It only asks for read access.

1. In ckanban open **⋯ → Integrations**, pick **Linear** under *Add an integration* and press **Authorize with Linear**.
2. A new tab opens on Linear's page. Approve ckanban. The tab then says *Connected* and the Integrations list shows your Linear name and workspace.

Keep ckanban open on this computer while you do this: Linear sends you back to it. The sign-in is kept in `~/.claude-kanban/integrations.json`, which only you can read.

ckanban reads Linear through Linear's own MCP server, because the sign-in token only works there. If your workspace doesn't allow apps like this, Linear says so on its page or ckanban shows *Linear signed you in but did not let ckanban read your issues*. Ask a Linear admin to allow ckanban for you; that is the only admin step.

After each sign-in ckanban saves how Linear's tools look (names and the shape of a few answers, no tokens and no issue text) to `~/.claude-kanban/integrations-debug/linear.json`. It is only for fixing ckanban if Linear's answers differ from what it expects. If Linear later refuses the connection, the list shows *Needs sign-in*. Press **Authorize** again.

If you change ckanban's port, press **Authorize** again: ckanban registers itself again for the new address.

## 2. Make an automation (per board)

Open **⋯ → Automations**, then **+ New automation**.

- **When**: the connection and the trigger, *Issue created* or *Issue assigned*. Linear's tools say who an issue is assigned to but not when that changed, so *Issue assigned* fires the first time an issue with an assignee is created or edited after the loop was switched on (once per issue). Match the person with an *Assignee* rule.
- **Only when**: rules on team, project and assignee. Each rule is *is* or *is not* with one or more values. With two or more rules, choose whether **all** (AND) or **any** (OR) must hold. *Me* in the assignee list is the connected Linear user. No rules means every event counts.
- **Then**: create a ticket in Ready (starts right away), Planning (Claude interviews you) or Backlog.
- **Instructions**: the ticket description. Variables such as `{{issue.identifier}}`, `{{issue.title}}`, `{{issue.description}}`, `{{issue.url}}`, `{{issue.team}}`, `{{issue.project}}` and `{{issue.assignee}}` are filled in from the issue. The ticket title is the issue's ID and title, and the card has a link back to Linear.

Things to know:

- A loop only reacts to things that happen after you switch it on. Old issues are never imported. Switching it off and on again starts from that moment.
- One issue makes at most one ticket per loop, even after a restart.
- Checks happen about once a minute and only while ckanban is running. Issues created while it was off are picked up when it starts, if the loop was on at the time.
- If Linear is unreachable or rate limiting, the loop waits (2, 4, 8 ... minutes, at most 30) and says why on its page. **Check now** asks right away.
- **Copy to board…** (at the bottom of a loop) makes the same loop on another board. The copy is switched off, so check its column and rules there and switch it on; it starts with a clean memory and only looks forward from then.
- Deleting a loop or a connection never deletes tickets it made.

## For developers: adding another service

Each service is one `ProviderDef` (`src/server/integrations/types.ts`): id and name, setup steps and credential fields, how to sign in (OAuth, or a pasted token), who the account is, and its triggers. A trigger declares its filter fields (with the operators they allow and where their values come from), the variables the instructions can use, and how to poll for events since a cursor. Add the file next to `linear.ts` and list it in `src/server/integrations/index.ts`; the dialogs, rule editor, poller and filters need no changes. Actions work the same way (`ActionDef`, v1 has *create a ticket*). `test/fixtures/dummy-provider.ts` is a second, tiny provider used to prove this.
