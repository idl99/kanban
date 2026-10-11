# ckanban: features in detail

Everything the board does, in depth. Back to the [README](../README.md).

## All features

- **Boards**: one board per folder. *New board…* (board switcher, top left) lists the folders you've recently run Claude Code in (from `~/.claude.json`), or *Browse…* opens the macOS folder picker. Base branch is auto-detected; model defaults to your Claude Code setting (`~/.claude/settings.json`); max parallel defaults to 5.
   Git repos get a worktree + branch per ticket (`ck/<id>-<title>`); plain folders are worked in place.
- **Worktree setup**: a fresh worktree lacks git-ignored files (`.env`, `node_modules`), so the board prepares it before Claude's first step. *Board settings → Worktree setup* holds three things, filled in automatically when a board is created (once for older boards, on the first start after upgrading; *↺ Detect again* re-runs it), with an *Auto-detected* badge while untouched:
  - **Files to copy**: paths or globs relative to the folder. Detected: git-ignored `.env*` files in the folder and its first-level subfolders (never `node_modules` or build output). Missing files are skipped; files already in the worktree are left alone.
  - **Setup command**: runs in the new worktree through your login shell (10 minute limit). Detected from lockfiles in the folder and its first-level subfolders, joined with `&&`: `bun.lock`/`bun.lockb` → `bun install`, `pnpm-lock.yaml` → `pnpm install`, `yarn.lock` → `yarn install`, `package-lock.json` → `npm ci`, `uv.lock` → `uv sync`, `poetry.lock` → `poetry install`, `Gemfile.lock` → `bundle install` (subfolders as `(cd web && …)`; nothing for Go or Cargo, which fetch on build). If it fails, Claude starts anyway and is shown the last 40 lines of output.
  - **Cleanup command** (optional): runs in a worktree before the board removes it; its errors are logged and never block removal.
  The ticket chat shows one *Worktree setup · Ns* row (copied files, the command with ✓/✗, click for output). Setup only runs when the board creates a worktree, on git boards.
- **Auto pickup**: moving a card to Ready starts a run immediately, up to `maxParallel` per profile. Extra cards wait their turn.
- **Live activity**: the card shows Claude's latest action; the ticket drawer shows the full transcript (tool calls, results, cost).
- **One chat per ticket, like the terminal**: the ticket's Chat tab shows the whole Claude session (terminal messages and board runs) and has a message box. Send a message and Claude replies right away in the same session. Send one while Claude is working to steer it: like typing in interactive Claude Code, the current step finishes and Claude reads your message at its next step, without a restart.
  - **Backlog / Planning: refine.** Claude interviews you with a clickable question form (any number of questions, up to 8 options each), then proposes a clear title and description. *Apply & start work* applies it and starts the work in one click (`⌘⇧Enter` does the same); *Apply only* just updates the ticket. `R` in a Backlog ticket's panel asks Claude to refine it. Claude changes no files here. For UI work it also draws HTML mockups, which the board saves to the ticket's `outputs/mockups/` and previews (sandboxed) in the Outputs tab. Claude then asks one question per design decision in the chat's question form, with a *Preview* link per option: pick and comment on everything, then send once. The final ticket names the chosen mockups as its *Target design*, and the dev run builds against them.
  - **Ready: do the work** on its own (queued, up to max parallel).
  - **Review / Done: follow-up.** Your message is acted on straight away; the card shows In Progress, then returns to Review.
  - **Edit before Claude reads it.** A message still waiting for a run slot or a restart, or left unsent by Stop, shows *Edit* and *Discard* (`↑` in an empty box edits the last one). Once Claude has it, the bubble reads *sent · Claude reads it at its next step*.
  - **Planning chats can manage the board on request.** Ask a Planning chat to move, edit, create, comment on, chat with or stop other tickets on its board and it does, logged on each ticket. Deleting shows a *Delete* card you confirm; it never touches its own ticket or other boards.
- **Changes tab: review the diff, comment on lines**: tickets with a worktree get a *Changes* tab (with the changed-file count) showing the branch's diff against its merge-base with the base branch, including uncommitted and untracked files. The file sidebar shows a *Tree* (default) or a flat *List* (remembered); the diff is unified with old/new line numbers, *Hide whitespace* and *↻ Refresh*. Binary files and files over 3000 diff lines are listed without content. Hover a line and click **+** to comment; comments show under their line (edit, delete) and survive tab switches and reloads. *Send N comments to Claude* posts them as one follow-up message (`path:line`, the code line, your comment) and switches to the chat; *Discard all* drops them.
- **Terminal handoff**: *Copy resume command* (`cd <dir> && claude --resume <id>`) to continue any ticket's session yourself.
- **Terminal & files**: *Terminal & files* in the top bar (or ``Ctrl+` ``) opens a bottom panel for the board's folder: a real interactive shell (vim, `claude`, colours all work; `Shift+Enter` makes a new line in `claude`, like after `/terminal-setup`) and a read-only file tree with syntax highlighting (gitignored files hidden). The shell keeps running when you close the panel or reload, and picks up where you left off.
- **Skills in descriptions**: type `/` at the start of a word in a description (new ticket, ticket panel, schedule prompt) to insert a skill or custom command; known ones show as chips.
- **Prompt snippets**: text you reuse (e.g. "run the e2e tests before finishing") saved once under *⋯ → Snippets*, for all boards or just one. Type `@` at the start of a word in the chat box, the new-ticket description or the ticket description editor: a popup filters snippets by what you type (`@e` → `@e2e`); `↑`/`↓` choose, `Enter`/`Tab` insert, `Esc` closes. Inserting replaces `@name` with the full text, so tickets stay self-contained. Names use lowercase letters, digits and dashes.
- **Live replies**: Claude's text appears in the chat while it is being written.
- **"Need you" inbox**: the top bar counts tickets on every board where Claude is waiting on you (questions, a proposal or teammate card, a reply, review, blocked, failed); the browser tab shows the count too. Cards, counts and the Inbox use the same rule, each row shows how long it has waited, and a ticket whose huddle is still working isn't counted as blocked. Click to jump to one.
- **Links and shortcuts**: an open ticket is in the URL (`#/<board>/<ticket>`), so refresh keeps it and Back closes it. `⌘K` command bar, `N` new ticket, `/` search this board, `1`…`9` / `[` `]` / `B` switch board, `J`/`K` or arrows select a card, `Enter` open, `D` mark done, ``Ctrl+` `` terminal & files, `C` quick Claude chat, `T` Team, `Esc` close. Hold `⌘` to see key hints on buttons and in dialogs. `?` lists them all.
- **Command bar (`⌘K` / `Ctrl+K`)**: one box to jump anywhere without the mouse. Type part of a ticket title from any board (letters in order are enough; matches are highlighted; the current board's tickets come first), or words from its description, last result summary or PR number (shown with a snippet of the match), an action (New ticket, Terminal & files, Quick Claude chat, Team, Inbox, Schedules, Connections, Snippets, Usage, Board settings, Keyboard shortcuts, …) or a board name (*Switch to …*, with its `1`…`9` key). With nothing typed it lists the active tickets touched most recently. `↑`/`↓` move, `Enter` opens (switching board if needed), `Esc` closes. Works with no board selected; not inside the terminal, where `⌘K`/`Ctrl+K` belongs to the shell.
- **Connections**: *⋯ → Connections* in the top bar opens your Claude Code MCP servers, like `/mcp` (as `claude mcp list` sees them from your home folder, re-checked every 10 minutes). Log in again when an OAuth server expires (the browser opens; the status updates by itself), log out, add or remove user-scope servers. The chip next to it (and a dot on ⋯) counts servers that failed or used to work and now need you to log in.
- **Schedules**: *⋯ → Schedules* in the top bar holds recurring tickets for the board: a name, ticket title (`{date}` / `{time}` filled in), prompt and cron expression (presets, or any 5-field cron in local time). Each time one fires, a new ticket is created and starts right away; cards from schedules carry a clock badge, failed runs land in the inbox. Pause/resume, *Run now*, and a history of every fire (ticket + status, or "skipped" while the previous run is still going) and every edit (who, what, previous prompt). Claude can manage schedules too (see the MCP tools below). The daemon itself keeps time (no system crontab, no Claude Code `/loop`), so schedules only fire while it runs; a run missed while it was off fires once on start.
- **Plans**: in a ticket's Planning chat, ask Claude to split the work into tickets. It proposes them as cards (with dependencies between them); *Create all* adds them to Backlog, linked to the planner ticket. *Start plan* in the planner's details then runs them unattended: the board starts children in dependency order, a few at a time (*At once*, default 2), in auto mode. The planner's Claude session is only woken when a child fails, is blocked, asks questions or finishes with an open PR (it can retry, rewrite, split, skip, answer or merge, but only its own children), and once at the end to run the full checks and write `plan-summary.md`. If it can't continue, the plan pauses as *Stuck* and you get a notification (see **Notifications**); *Resume plan* continues. When every child is done, the planner shows *Plan finished · n of n tickets done* with *Move to Done* and *Add more tickets* (a new child brings the plan back).
- **Shared resources**: give tickets that use something only one may use at a time a *Needs* entry (e.g. `emulator`, via `propose_tickets`, `create_ticket`/`update_ticket` or `ckanban ticket update <id> --needs emulator`; the ticket's details show and edit it once set). Tickets that need the same thing never run at the same time, on any board of this machine, in any order; the others keep running. A ticket waiting for one shows *waiting* and keeps its place without taking a run slot.
- **Manager mode**: ask any ticket's chat (outside Backlog/Planning) to manage tickets, e.g. "run all Backlog tickets, the emulator ones one at a time". Its Claude adopts them (`adopt_tickets`; tickets in another plan or done are skipped), sets their order and needs, and starts the plan (`plan_control`). A plan never starts a child that waits on you (open questions, a proposal to apply, in Planning); it shows *Needs you* in the Plan tab.
- **Use the board from other agents**: Claude Code, Codex (or any MCP client) can create, list, update, move, start, steer and stop tickets through `ckanban mcp`, so you can say "find what's left to do in this repo and put it on my board". See [Use the board from Claude Code / Codex](#use-the-board-from-claude-code--codex).
- **PR tracking and checks**: Review cards with a PR are checked every 5 minutes via `gh`; merged → Done (worktree removed). Cards show chips for checks (passing, failing, pending), conflicts and comments. The ticket's PR box lists every check with a log link, plus mergeability, review and comments. *Send failures to Claude* sends the failing checks' log tails as a chat message. **Merge & done** is enabled only when the PR is open, green, mergeable and has no requested changes; after a confirm the server checks again and runs `gh pr merge --squash --delete-branch` (never `--admin`), then moves the card to Done. The *Has PR* filter shows tickets with an open PR.
- **Usage limit: continues at reset**: a run that stops on the Claude usage or spend limit isn't marked failed. The card shows *Limit hit · continues at 4:00* and the board sends "continue" a minute after the reset (through the normal run slots). *Continue now* goes at once; *Don't auto-continue* turns it off for that ticket (then it shows *resets 4:00* and counts as needing you). At most 3 automatic continues per ticket per day; any message from you or moving the card cancels the wait.
- **Stalled-run watchdog**: a run that sends no output for 20 minutes (board setting *Flag a run as stalled after*, 0 turns it off) is marked *Stalled* and lands in the Inbox, with *Restart* (stop the stuck process and continue in the same session), *Keep waiting* and *Stop* on the card and in the ticket. Nothing is killed by itself; runs waiting on background tasks don't count, and the flag clears as soon as output resumes.
- **One retry on temporary API errors**: a run that dies on an overloaded API, a 5xx or a dropped connection resumes the same session once after 30 seconds (logged in the chat) instead of failing; a second failure, or any lasting error, fails the run as before.
- **One-click recovery**: when a ticket's Claude session is lost, *Start fresh session* starts a new one in the same worktree and branch, told the ticket, last result and recent comments and to pick up from git. When the session is open in a terminal, *Take over here* closes it (if it runs in the board's own terminal) and resumes the run; an outside terminal falls back to *Start fresh session*.
- **Phone access**: `ckanban remote on` (or *⋯ → Phone access*, which also shows a QR code) runs `tailscale serve --bg --https=443` so `https://<your-mac>.<tailnet>.ts.net` reaches the board from devices on your tailnet. Serve points at a second loopback port of the daemon (the board port + 1, e.g. 7778; `remotePort` in `config.json` or `CKANBAN_REMOTE_PORT` to change it) where every request counts as a tailnet request, so a forged `Host: localhost` can't pass as local. It accepts only the tailnet host, only from the Tailscale login that turned it on (the `Tailscale-User-Login` header `tailscale serve` sets) and only while enabled; `ckanban remote off` removes the serve mapping, `ckanban remote status` shows the URL. Needs MagicDNS and HTTPS certificates on for the tailnet; tagged devices aren't supported. Only the Mac can turn it on or off. Narrow screens (≤720px) get a phone layout: **Now** lists what needs you on any board (with *Answer* / *Open* / *Mark done*), what runs and what's in Planning; a bottom bar switches to the **Board** (one column at a time, column chips, long-press to drag), **Schedules** and **More** (the ⋯ menu). Tickets open full screen with *Move* and a *Details* toggle. The board is installable (*Add to Home Screen*): a web manifest plus a service worker that keeps the app shell, never board data.
- **Notifications** (*⋯ → Notifications*): when a ticket starts needing you (questions, a proposal or proposed tickets, Ready for review, a failed run, the usage limit, blocked or a stuck plan, a huddle asking you; optionally *Claude replied* in Planning, off by default), the board tells you once. It follows the same rule as the Inbox and the cards' *Your turn* (`attention.ts`): one notification per transition into a kind, none while the ticket keeps waiting, and a change has to hold for 5 seconds first so a run ending and the next starting doesn't ping you. Tickets already waiting when the daemon starts don't notify. Where it goes: a **webhook URL** (an ntfy topic URL such as `https://ntfy.sh/<long-secret-topic>` works as-is: plain text body with `Title`, `Click` and `Tags` headers; any other URL gets a JSON POST `{board, boardName, ticketId, title, kind, label, url}`; *Format* forces ntfy or JSON) and/or a **macOS banner** on the Mac (also used for *Plan done*). Each kind has its own toggle. The link opens the ticket on the phone (`https://<your-mac>.<tailnet>.ts.net/#/<board>/<ticket>`) when Phone access is on, else `http://localhost:<port>/…`. *Send test notification* sends a sample through both. Settings live in `~/.claude-kanban/notify.json`; board runs can't read or change them. ntfy topics are public to anyone who knows the name, so pick a long, hard-to-guess one (the message holds the ticket title and board name, nothing else).
- **Huddles**: several Claude sessions work one ticket together. See [Huddles](#huddles).
- **Team**: the dock's *Team* tab holds your huddle teammates, templates and notes. See [Team](#team).

Columns: Backlog → Planning → Ready → In Progress → Review → Done.

## Huddles

A huddle is a shared room where several headless Claude sessions work on one ticket. The ticket's own session is `@main` (the coordinator); teammates such as `@reviewer`, `@qa`, `@engineer`, `@security`, `@researcher`, `@ux` or a `@facilitator` lead join it. They run outside the board's run slots (up to 8 participants).

- **Starting one**: ask the ticket's chat for a huddle and Claude proposes one as a card: roster (teammate, count, mode, model, focus), invited tickets and a budget. Edit it and click *Start huddle*. The Huddle tab (or a teammate's *Start huddle* in the Team tab) starts one by hand, optionally from a template.
- **Auto huddles**: while you are away, an unattended run (Ready / In Progress work, plan children, schedule runs) starts a review huddle itself (`start_huddle`) before landing work on a ⭐ Important ticket or a risky change (user-facing behaviour, data, security, payments, migrations), and posts why on the ticket. It uses the *Auto review* template (reviewer, QA, QA lead) or *Auto review (important)* (correctness and security reviewers, two QA testers, QA lead) for ⭐ tickets and security, data, payments or migration risks. Claude fixes the MUST findings, has the reviewer re-check once, lands the work, closes the huddle with its summary and lists the SHOULD/COULD findings in the result. If the $20 budget runs out with MUST findings open, it doesn't land and stops in Review. One auto huddle runs per board at a time; other tickets wait in In Progress ("Waiting for huddle slot") and resume on their own. The card shows "Auto huddle · reason" while it runs. Turn it off per board in Board settings (*Auto huddles*, on by default). Mark a ticket ⭐ Important in the new-ticket dialog or the drawer header (or ask Claude to).
- **Routing**: an `@tag` wakes that participant (it steers a running one, or resumes it with the unread messages). Participants in *monitor* mode read every message; *tagged* ones only wake when tagged. Leads always watch. `@all` only works from a lead, `@main` or you. A tag that wakes nobody (the target is done or stopped) tells `@main`, and a huddle idle for 5 minutes wakes `@main` once.
- **Huddle tab**: the live feed (system lines, findings, `@mention` chips, "↓ next for you"), a roster with each participant's status, current activity and cost, the pinned brief (goal and decisions, editable by leads, `@main` and you), the pinned findings checklist and a composer with `@` autocomplete. *+ Add agent*, *+ Invite ticket*, *Stop agents*, *Resume* and *Close huddle* are in the bar. Click a participant to watch its own Claude session read-only beside the feed (`J`/`K` to move between them).
- **Rounds**: a ticket can host several huddles. The round picker lists each one with its state, teammates, cost, findings and summary; earlier rounds open read-only. Each huddle writes its summary to `outputs/huddles/<id>/summary.md` (the board writes a fallback if nobody did).
- **Safety**: each huddle has a budget (default $20; leads are warned at 80%, everything stops at 100%, *Resume (+$10)* adds more). It also stops at 150 messages, pauses after 30 messages without you, and stops two participants who keep answering each other. Teammates that only read work in a detached snapshot of the host branch's committed code; ones that edit get their own worktree. Only you can close a huddle; it also closes when the ticket moves to Done.
- **Learnings**: when a teammate finishes it can propose up to 3 lessons. The **🎓 Learnings** button opens a drawer where you edit them, pick the scope (all repos or this one) and the role, then save or discard. Saved notes go into every future teammate of that role.
- **On the board**: cards show a huddle badge (live count and who is working, *paused* when a brake hit, closed with its message count) and the dock's *Huddles* tab lists live and recent huddles. In the host ticket's chat, huddle messages show as collapsible huddle blocks.

## Team

*Team* in the header (or `T`) opens the dock's Team tab:

- **Teammates**: built-in ones (main, reviewer, qa, qa-lead, engineer, security, researcher, ux-critic, facilitator) plus yours. Each has a role, prompt, default model, mode, lead and edit rights, with usage stats from every board's huddles, its notes and recent huddles. *Copy to customise* overrides a built-in; save for all boards or just this one (deleting falls back to the level below). *Start huddle with @name* uses the open ticket, or creates a new Planning ticket.
- **Templates**: whole huddles (roster, rounds, budget, report format), such as the built-in *Design review*. A huddle started from a template gets its rules as the pinned brief.
- **Notes for all**: notes every teammate gets, next to the per-role notes.
- **Claude proposes teammates**: in a ticket chat, Claude can suggest a new teammate (or a change to one) as a card with its prompt and reason. *Save teammate* saves it to all boards or this board, *Edit first* opens it in the Team tab. Runs can never save a teammate themselves.

## Runs in the background, survives restarts

The installer registers a macOS launch agent, so the board:
- starts automatically when you log in (after a reboot too),
- restarts itself if it crashes,
- keeps running when you close the browser or terminal.

Tickets that were **In Progress** when the Mac shut down or the service restarted go back to Ready and resume the same Claude session automatically. A chat or Planning reply that a restart cut off keeps what Claude had written so far (greyed out) and continues on its own after the restart. Nothing needs to stay open except your Mac being on.

## Use the board from Claude Code / Codex

`ckanban mcp` is an MCP server (stdio) that gives other agents tools for your board, so you can manage it from any Claude Code or Codex session:

```bash
ckanban mcp install            # register it with Claude Code (user scope) and Codex (~/.codex/config.toml)
ckanban mcp install --codex    # just one of them (--claude / --codex)
ckanban mcp status             # where it's registered
ckanban mcp uninstall
```

Or open *⋯ → Connections* on the board and click **Add** next to Claude Code / Codex. Other MCP clients can run `ckanban mcp` themselves.

Then ask, for example:

- "Scan this repo for TODOs and unfinished work and create a ticket on my board for each."
- "What's on my board? Start the dark-mode ticket."
- "Tell the ticket about the login bug to also cover password reset."
- "Every weekday at 9, check CI on main and fix what's failing." (creates a schedule)

Tools: `list_profiles`, `list_tickets`, `get_ticket`, `create_ticket`, `update_ticket`, `move_ticket`, `chat_ticket`, `stop_ticket`, `comment_ticket`, `delete_ticket`, `adopt_tickets`, `plan_control`, `report_bug`, for schedules `list_schedules`, `create_schedule`, `update_schedule` (also pause/resume), `delete_schedule`, `run_schedule`, `schedule_history`, and for huddles `list_huddle_presets`, `save_huddle_preset`, `delete_huddle_preset`, `start_huddle` (unattended runs, auto huddles) plus the tools huddle participants use (`huddle_post`, `huddle_read`, `huddle_status`, `huddle_brief`, `huddle_findings`, ...). Ticket chats also get cards for you to answer: `ask_questions`, `propose_ticket`, `propose_tickets`, `propose_branch`, `propose_huddle`, `propose_teammate` and `propose_delete`. New tickets land in **Backlog** in interview mode unless you ask otherwise. Every tool acts on the board whose folder contains the agent's working directory (a git worktree counts as its main checkout); pass `profile` to pick another. Answering a question form and applying a proposed ticket still happen on the board.

Board runs see the same server but can only read (except a Planning chat acting on your own request, see above): inside a run (`CKANBAN_TICKET` is set) every tool that changes the board refuses, so a run can't create or start other runs. `report_bug` doesn't touch the board, so it works from a ticket chat too. Schedule edits are the exception: `create_schedule`, `update_schedule` and `delete_schedule` work inside runs (ask for a schedule from any ticket chat; a scheduled run is told its schedule id and may refine its own prompt), because they only change future runs, which you can pause. Each edit is recorded in the schedule's history with who made it (you, or Claude in which ticket) and the previous title/prompt/timing. `run_schedule` starts a run immediately, so it stays refused inside runs. The other exception is a planner, on its own child tickets only: its wake-up runs while the plan runs, and its replies to your own messages in its chat (in any plan state, so you can still tidy up a finished plan's children; `adopt_tickets` and `plan_control` start/resume work there too, except that a finished plan can't be restarted). They may use `create_ticket`, `update_ticket`, `move_ticket`, `chat_ticket`, `stop_ticket` and `comment_ticket` on that plan's child tickets only (the daemon checks this; every change is logged on the child, and retries and new children are capped).

The same operations work from a terminal:

```bash
ckanban profiles
ckanban ticket list [--status ready]
ckanban ticket show <id>
ckanban ticket create --title "Add dark mode" --body-file notes.md   # or --body "...", or --body - (stdin)
ckanban ticket update <id> [--title ...] [--body ...] [--status ...] [--mode interview|auto]
ckanban ticket move <id> ready     # starts a run, like dragging the card
ckanban ticket chat <id> "also handle the empty state"
ckanban ticket comment <id> "note for the next run"
ckanban ticket stop <id>
ckanban ticket delete <id>
ckanban ticket report-bug [<id>] --title "Chat froze" --body "1. ..."   # files a ckanban bug on GitHub
```

Add `--profile <slug>` to pick a board explicitly and `--json` for machine-readable output. The daemon must be running.

## Reporting bugs

Found a bug in ckanban? Use **⋯ → Report a bug** in the header, or **Report a bug in ckanban** in a ticket's details to attach that ticket. You see everything that will be sent (version and OS, ticket details, last run result and log tail) and can untick any of it; home and data paths and secret-looking values are hidden. It's filed as an issue on `leoawesome/kanban` with `gh`. Without `gh` (or logged out) you get a prefilled GitHub link instead. `gh` can't upload images, so screenshots are listed for you to drag into the issue. In a ticket chat you can also ask Claude to "report this as a ckanban bug": it drafts the issue, asks you to confirm, then files it.

## claude.ai artifacts from board runs

Off by default: turn on **claude.ai artifacts** in the board's settings and runs and Planning chats learn how to publish and read artifacts (with it off their prompts leave this out). Board runs are headless (`claude -p`), where Claude Code turns the built-in Artifact tool off. Runs are told to use `ckanban artifact publish <file> [--url <artifact url>]` and `ckanban artifact read <url> --out <file>` instead. These start a short interactive `claude` in a hidden tmux session (in `~/.claude-kanban/artifact-helper`), which has the tool, and read the result from its transcript. Needs `tmux` (`brew install tmux`) and Claude Code signed in with `/login`. Published pages show on the ticket.

## Data layout

```
~/.claude-kanban/
  config.json                    { "port": 7777, "prPollMinutes": 5 } (optional "remotePort", default port + 1)
  remote.json                    phone access: { enabled, host, allowedLogin } (ckanban remote on|off)
  notify.json                    notifications: { webhookUrl, format, mac, kinds } (⋯ → Notifications)
  mcp-seen.json                  MCP servers seen connected (so "needs auth" there counts as expired)
  snippets.json                  prompt snippets (⋯ → Snippets; scope "global" or a board slug), inserted with @name
  huddle-presets.json            teammates saved for all boards (huddle-templates.json: templates)
  huddle-notes/<role>.md         notes every new teammate of that role gets
  profiles/<slug>/profile.json
  profiles/<slug>/tickets/<id>/ticket.md        YAML frontmatter + description
  profiles/<slug>/tickets/<id>/comments.jsonl
  profiles/<slug>/tickets/<id>/activity.jsonl   raw stream-json events
  profiles/<slug>/schedules/<id>.json           recurring ticket template
  profiles/<slug>/schedules/<id>.history.jsonl  fires, skips and errors
  profiles/<slug>/huddles/<id>.json              huddle (participants, findings) + <id>.messages.jsonl
  profiles/<slug>/huddle-presets.json            this board's teammates (also huddle-templates.json, huddle-notes/)
```

Env overrides: `CKANBAN_HOME`, `CKANBAN_PORT`, `CKANBAN_REMOTE_PORT`, `CKANBAN_CLAUDE_BIN`.
