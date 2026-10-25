# Changelog

What changed in each ckanban release. Get the latest with `ckanban update`.

## Unreleased

## [0.14.0] - 2026-10-25

### Added
- **Ask Claude without a ticket, on your phone too**: phones get an *Ask* tab in the bottom bar. On a computer, the *Claude* button opens the same chats as bubbles, with a list of past chats. Chats are kept, so you can reopen one, rename or delete it, and carry on from phone or computer. *Make ticket* turns a chat into a Backlog ticket that continues the conversation.
- **Tags filter**: a *Tags* chip next to *Has PR* lists the board's tags with how many tickets have each. Tick the ones you want. On a phone it opens as a sheet from the bottom.
- When you ask in a ticket's own chat, Claude can move that card to Done, Backlog or Ready.
- Resume a paused huddle with +$5, +$10 or +$20.

### Changed
- **Bottom panel shows one thing at a time**: the top buttons are now *Terminal*, *Files* (`F`), *Claude* and *Team*, and each opens just that. Click another to switch, or the lit one to hide it. Each keeps its own height. Huddles moved into *Team*, and the *Team* button shows how many huddles are live.
- The old terminal-style Claude tab is replaced by the saved chats. You can still run `claude` in the Terminal.
- Picking several tags now shows tickets with any of them, not only tickets with all of them.
- Sending a message on a Backlog card moves it to Planning.
- On a phone, menus open as a sheet from the bottom, the ticket header stays on one row, and the app icon and opening screen look right on the home screen.
- In a huddle, scrolling down shrinks the ticket header to one line. A paused huddle shows a small folded box where the message box was, with *Summary*, *Close* or *Resume*.

### Fixed
- A long Claude reply could vanish from the chat while Claude was still using tools.
- A huddle started from a Done ticket's chat closed at once. It now keeps running, and the card waits in Review.
- A huddle's budget counted the ticket's earlier chat spend, so it could stop on its first reply.
- Long words in the chat or huddle no longer push the page sideways on phones.

## [0.13.0] - 2026-10-25

### Added
- **Model and effort per ticket**: pick the model and reasoning effort for one ticket, next to its tags. Boards also get a default effort.
- **Automations**: turn Linear issues, or new items from any service a small check script can read on a timer, into tickets by themselves.
- **Huddles with a lead**: a lead hands out the work and collects the results, and the ticket's Claude waits until it is needed. Helpers can change files in their own copy and hand the changes in.
- Ask for a huddle in a ticket's chat and it starts. In Planning, ask for a review of the plan before any work starts.
- Claude can send you a phone notification in its own words when it still needs your answer.
- The Mac stays awake while runs, chats, huddles or scheduled jobs are working.

### Changed
- **Ticket page**: the whole title always shows, on its own line under the buttons. Tags, model and effort share one small row. On a phone the Move button shows the current column, the Ticket tab is tighter, and the tab bar fades at the edge when more tabs are hidden.
- File names in chats and descriptions are underlined links instead of boxes, and long paths wrap neatly.

### Fixed
- Pressing Esc while editing a ticket's title saved the edit anyway; it now throws the edit away.
- A message you sent no longer shows twice while Claude is replying.
- Long links, paths and code wrap on phones, and the Move menu shows every column without scrolling.
- A huddle that runs out of budget after its work is done points you to Close instead of Resume.
- Connections always shows the Board column.
- Phone access finds Tailscale when the board runs in the background.

## [0.12.0] - 2026-10-18

### Added
- **Follow-ups**: when work waits on something outside (an email reply, a person, a deploy), Claude sets a time to come back to the ticket by itself, or you ask it to ("check for a reply every morning"). The card shows *Follows up tomorrow 09:00*, with the note, history, cost, *Follow up now* and *Stop following up*. A message you type stops it.
- **One-time scheduled jobs**: Claude (or you) can start a ticket or run a command at a set time ("post this Tuesday at 22:00"). *Schedules* opens on an *Upcoming* list with *Run now*, *Change time* and *Cancel*, and the ticket that scheduled them shows *⏰ N scheduled*. A job that runs late still starts and is told how late it is.
- **Tags**: short labels on tickets, shown as colored chips. Click a chip or type `#tag` in search to filter the board. Schedules tag their tickets, and Claude can suggest tags that you keep or drop.
- **Attach any file**: PDF, Word, Excel, PowerPoint, text and code files (up to 25 MB), not just images, in ticket descriptions and chats. Claude gets the files and knows how to open them.
- **PDF preview** in the Outputs tab, on phone and desktop.
- **File names in chat open with one tap**: a file Claude mentions opens in a full-screen viewer (Markdown, images, PDF and web pages previewed). Files Claude asks you to review are also copied to Outputs.
- **Phone notifications from the board itself**: turn them on in *Notifications → This phone*, no extra app needed. Tapping one opens the ticket. On iPhone and iPad, add the board to the Home Screen first; the board shows how.
- **Works without git**: a board can be a plain folder. Runs edit the folder in place, one ticket at a time, and list what changed. New board and Board settings offer *Turn on version history* to keep a history of changes.
- **Workspace setting** per board: a separate copy of the folder for each ticket (default), or work straight in the project folder.
- **Help me understand** menu in the ticket header: *What happened while I was away?* and *Explain the changes* answer as cards in the chat, without touching the ticket's session.
- **Learn from this ticket**: after you corrected Claude on a ticket, it suggests up to 3 lessons. Add one to the project's rules, turn it into a ticket, or dismiss it.
- **Say it simpler** under Claude's replies rewrites the reply in plain words.
- Runs and Planning chats start with a short brief of related past tickets on the board, so Claude doesn't redo or undo earlier work.
- Planning and Backlog chats can do things outside the project when you ask (call a service, use the browser, run a command). They still don't change the project's files.
- New huddle teammates: *blast-radius* (what else a small change can break) and *breaker* (tries to break risky logic). The review for ⭐ Important work checks the blast radius.
- Phone *More* menu shows your Claude plan usage with reset times and today's spend.
- *Copy text* bar under grey text boxes in the chat.
- Outputs tab: a *Links* section with the ticket's claude.ai artifacts and share links, and a ↗ artifact chip on board cards.
- Huddle teammates get the ticket's description, show how full their conversation is, and their cost counts in the ticket's spend.
- Huddle sidebar: each participant on its own readable rows, and you can drag the sidebar wider.
- New shortcuts: in the New ticket dialog `⌘S` creates in Backlog, `⌘I` switches mode, `⌘D` stars. In the ticket panel `S` stars, `M` moves, `[` `]` switch tabs, `⌘.` stops Claude.

### Changed
- **Huddles run after the main work.** A huddle you want goes into the ticket as a *Review huddle* section; the run does the work first, then starts the huddle itself, even with Auto huddles off.
- Auto huddles start only for real risk (security, data or payments), say which one, and use a team picked for the change.
- A new requirement on a ticket in Review or Done becomes a linked **add-on** ticket, so the original keeps its title and description.
- Each ticket's copy starts from the latest version others have shared, and project dependencies are installed only when Claude needs them, so writing and question tickets start at once.
- Run summaries and replies use plainer words, and Planning plays back the goal before proposing a ticket.
- Sharing claude.ai artifacts no longer needs tmux.
- Phones: *Photo* opens the gallery straight away, with a paperclip for other files. A *Ticket* tab shows and edits the description. Outputs open in a full-screen reader. Toasts are a light card at the top with a clear *Undo*; swipe to dismiss. Full output file names, a bigger huddle chat and slimmer message boxes.

### Fixed
- A message stopped before Claude read it comes back unsent (Send, Edit or Discard) instead of sticking in the chat.
- A ⭐ before a title marks the ticket Important, and planners can mark proposed tickets Important.
- Connections shows a claude.ai connector as needing login when Claude sessions can't use it, and the Connections window works on phones and shows added or edited servers right away.
- On the Mac, notifications open the ticket when clicked, through the browser, instead of a macOS banner that opened Finder.
- A ticket with very large output folders no longer freezes the browser.
- Phone access says when Tailscale is off on the Mac instead of showing a green *On*.
- On phones, Enter in chat boxes adds a new line and the Send button sends. The message box uses the full width, its hint fits, and it grows line by line. Web pages in Outputs made for a desktop fit the screen. The description box has *Image*, *Snippet* and *Skill* buttons.
- Huddle proposals keep the budget Claude was asked for.
- Huddle teammates no longer fail to start in projects with checkout hooks (such as husky).
- *Mark done* moves to the next ticket at once, and closing the panel meanwhile no longer reopens it.
- The test suite runs in about a minute instead of four and a half.

## [0.11.0] - 2026-10-11

### Added
- **Phone access** over Tailscale: `ckanban remote on` (or ⋯ → Phone access, with a QR code) opens the board on your phone, on your tailnet only. Phones get their own layout: a *Now* home with what needs you, a bottom tab bar, one column at a time, and an installable app.
- **Notifications** when a ticket needs you, sent to ntfy, a webhook or a macOS banner, with a link straight to the ticket. Set them up under More → Notifications.
- **Inbox triage**: *Mark done*, *Snooze (1 day)* and *Answer/Open* on each entry (keys `d`, `s`, `Enter`). A snoozed entry comes back when the time runs out or the ticket changes.
- **Cost at a glance**: `$` on running and review cards, today's spend across all boards in the header, live costs for huddle agents, and a spending cap per run (per board, with a per-ticket override). A run that hits its cap waits in the Inbox with *Continue with +$Y*.
- **Resolve conflicts** button next to a PR's conflict chip: Claude rebases onto the base branch, resolves the conflicts, runs the checks and pushes.
- **Image** button in the description, chat and bug report boxes, to pick photos on phones.
- First run: the New board dialog opens by itself, and a read-only sample ticket is offered after your first board. Downloads from `install.sh` and `ckanban update` are checked against the release's SHA256 checksums.
- Auto huddles use the budget a ticket asks for (up to $100).
- *claude.ai artifacts* is now a board setting (off by default).

### Changed
- Removed the unused ticket-to-ticket question tools, which makes run prompts shorter.
- The ticket drawer shows the *Needs* editor only once a ticket has needs.
- "Profile" is now called "board" everywhere in the UI.

### Fixed
- Huddles in a repo with no commits yet: every teammate failed at start. They now work in the board's folder.
- A huddle teammate that fails to start shows the reason in the participant list and posts it in the huddle, instead of just "failed".
- The huddle tab on phones scrolls and fits the screen.
- The phone *Now* view shows the board you're on.
- A planner's chat can tidy up a finished plan's tickets when you ask.

## [0.10.0] - 2026-10-11

### Added
- **Huddles**: several Claude sessions work one ticket together in a shared room. The ticket's own session is `@main`; teammates (reviewer, QA, engineer, security, researcher, ux-critic, facilitator, ...) are woken by `@tags`, post findings and report back. Claude proposes a huddle as an editable card in the chat; the **Huddle tab** shows the live feed, roster with status and cost per agent, pinned findings, a pinned brief and a composer with `@` autocomplete.
- Huddle safety: a budget per huddle (default $20, Resume adds more), message and loop brakes, read-only teammates working in a snapshot of the committed code, and only you can close a huddle.
- Click a huddle participant to watch its own Claude session, read-only, next to the feed.
- Switch between a ticket's huddle rounds; each huddle gets its own summary.
- Teammates propose lessons when they finish; you review them in the **🎓 Learnings** drawer and save them as notes that every future teammate of that role gets.
- Whole-huddle templates (roster, rounds, budget, report format), including a built-in *Design review*.
- **Auto huddles**: in unattended runs, Claude starts a review huddle on its own before landing important or risky work, fixes the MUST findings, gets a re-check, then lands. Mark a ticket **⭐ Important** (new-ticket dialog, ticket header, or ask Claude) for the bigger review roster. One auto huddle runs per board at a time; others wait for the slot and resume on their own. Turn it off in *Board settings → Auto huddles*.
- Huddle badges on board cards and a *Huddles* list in the dock.
- **Team tab** in the dock (header *Team* button or `T`): every teammate with its prompt, notes, usage and recent huddles, plus templates and notes for all roles. Teammates and templates can be saved for all boards or just one, and *Start huddle* starts one from there.
- **Claude proposes new teammates** as a card in the chat; save it with one click, or edit it first.
- New built-in teammates: researcher, ux-critic and facilitator.
- **Review cards show PR checks**, conflicts and comments. The ticket's PR box lists every check, *Send failures to Claude* sends the failing logs, and **Merge & done** squash-merges a green PR and moves the card to Done.
- **Spend limit**: a run that hits the Claude usage limit shows *Limit hit · continues at 4:00* and continues by itself when the limit resets (or click *Continue now*; you can turn auto-continue off per ticket).
- **One-click recovery**: *Start fresh session* when a ticket's session is lost (same worktree and branch), or *Take over here* when the session is open in a terminal.
- **Edit chat messages** Claude hasn't received yet (waiting for a run slot, a restart, or left unsent by Stop); `↑` in an empty box edits the last one.
- **Apply & start work** on proposal cards applies Claude's ticket and starts it in one click.
- Planning chats can move, edit, create, comment on and stop other tickets on the board when you ask; deletes go through a confirm card.
- `⌘K` also finds tickets by their description, last result summary and PR number, with a snippet of the match.
- A finished plan offers *Move to Done* and *Add more tickets* instead of Start work / Start plan.
- The Inbox shows how long each ticket has been waiting.
- Type `/` in a ticket description to insert a skill or command; known ones show as chips.
- Hold `⌘` for key hints in dialogs too; `R` refines a Backlog ticket.

### Changed
- Cards, counts and the Inbox use one "needs you" rule; a ticket whose huddle is working no longer shows *Blocked*.
- The header's running pill counts every active run, chat replies and huddle teammates included.
- The *Has PR* filter only counts open PRs.
- Huddle roles and templates moved from Board settings to the Team tab. Board settings is titled *Board settings · <name>*.
- Claude's questions form takes any number of questions with up to 8 options each.

### Fixed
- `1`–`9` in the board switcher picks that board instead of searching for the digit.
- The chat no longer says *Moved to Planning* when a reply was blocked and the card stayed put.
- Huddle messages show as huddle blocks in the host ticket's chat, not as your own messages.

## [0.9.0] - 2026-10-08

### Added
- **Keyboard control in the ticket panel**: `⌘⇧Enter` does the ticket's next step (apply Claude's proposal, then Start work, or Mark done in Review); `↑`/`↓` or `J`/`K` switch tickets; `E` edits the description, `Esc` cancels and `⌘Enter` saves.
- **Hold ⌘** (Ctrl on Windows/Linux) to see key hints on the buttons in the ticket panel and on the board.
- `Enter` confirms the *Start work?* and *Branch* dialogs.

### Fixed
- Previous / next in the ticket panel stays in the ticket's column, and marking a ticket Done moves on to the next ticket in that column.
- Links in the chat, descriptions and outputs open in a new tab instead of replacing the board.
- A ticket whose PR is merged stays in Review while it still waits on you (questions, a proposal or proposed tickets).

## [0.8.0] - 2026-10-08

### Added
- **Changes tab**: review a ticket's diff in the board (file tree or list, unified diff), comment on lines and send all comments to Claude as one message.
- **Worktree setup**: each new worktree gets your git-ignored `.env` files copied and dependencies installed before Claude starts. Both are auto-detected from your folder (*Board settings → Worktree setup*), with an optional cleanup command.
- **Prompt snippets**: save text you reuse under *⋯ → Snippets* and insert it with `@name` in the chat, new-ticket and description boxes.
- **⌘K command bar**: jump to any ticket on any board, any board, or run an action.
- **Subagents in the chat**: agents Claude launches show as rows with live status, their steps and result.
- **Slash commands in the ticket chat**: type `/` to pick a Claude Code command; only commands that can run headless are offered.
- Click a tool call in the ticket chat to see its full input and output.
- This changelog, also used as the release notes.
- `Shift+Enter` makes a new line when running `claude` in the embedded terminal.

### Fixed
- Switch boards with plain `1`–`9` instead of `Alt+1`–`9`.
- Copying non-ASCII text from the dock terminal pastes as UTF-8 instead of Mac Roman.
- A run whose Claude session was never saved starts a new session instead of failing every time.
- Reopened Done tickets get their worktree back; leftover worktrees are cleaned up on start.
- Finished chat replies no longer show twice under the *Moved to Planning* box.

## [0.7.0] - 2026-10-07

### Added
- Claude in Chrome in every board run and planning chat.
- Keyboard shortcuts to switch boards, select cards and mark tickets done (`?` lists them).
- Planner tickets control their children on request, adopt existing tickets, and respect exclusive resources (*Needs*, e.g. `emulator`).

### Fixed
- Chat replies that resume work respect the board's max parallel runs.
- A streamed chat reply no longer vanishes before its saved copy loads.

## [0.6.0] - 2026-10-06

### Added
- Branch a ticket into a new one with a copy of its conversation and code.
- Per-ticket Claude usage tab (≈% of the 5h window, cost, tokens).
- Share menu for output files, share links and file cards in the chat.
- Planning chats can read, update and publish claude.ai artifacts.
- New name and logo (ckanban), leaner header, image-first README.

### Fixed
- Runs stay alive while Claude waits on background tasks.

## [0.5.0] - 2026-10-05

### Added
- HTML mockups in planning, with feedback through the chat question form.
- Planning questions and ticket proposals via MCP tools; Review/Done chats can propose follow-up child tickets.
- Tickets can ask another ticket's Claude a question and get the reply.
- Outputs tab with folder sidebar, filter and image preview.
- New ticket dialog with *Start planning* / *Start now*; Ready merged into In Progress as a queue.
- Claude plan usage (5h / weekly %) as a header pill.
- Resizable ticket sidebar, session menu, wider profile switcher with letter avatars.
- Shows when a pending restart is holding runs.

### Fixed
- Chat replies cut off by a daemon restart resume; restart waits for active runs.
- Stale "Plan stuck" cleared; the plan has its own tab.
- Ticket drawer sizing (never wider than needed, can be dragged wider again).

## [0.4.2] - 2026-10-02

### Fixed
- Blank board on load when no ticket is open.

## [0.4.1] - 2026-10-02

### Fixed
- Drawer prev/next keeps the order from when it opened.

## [0.4.0] - 2026-10-02

### Added
- Plans: a planning chat proposes child tickets as cards, and the planner runs them unattended in dependency order.
- Drawer prev/next navigation, multi-line answers, full-height outputs.

### Fixed
- Planner wake-ups keep the planner's column and its own PR link.
- API connection retries show on the card instead of a frozen step.

## [0.3.0] - 2026-10-01

### Added
- Report ckanban bugs as GitHub issues from the board, ticket chat, MCP and CLI.
- MCP schedule tools so Claude can create and manage schedules.
- Calmer cards with one spinner, readable activity and live run time.

### Fixed
- Closing a ticket keeps its board; replies show as normal chat messages.
- Quick Claude chat is dark, fits the dock and knows the board.

## [0.2.0] - 2026-10-01

### Added
- Claude Code / Codex can manage the board via `ckanban mcp` and the `ckanban ticket` CLI.
- Quick Claude chat in the dock (no ticket needed), opened from the header's Claude button.

### Fixed
- Runs are never blocked by repo setup: base branch recovered, plain folders and empty repos work.

## [0.1.0] - 2026-10-01

First release.

- Kanban board per folder where a headless `claude -p` session works each ticket in its own git worktree and opens a PR; merged PRs move the card to Done.
- One terminal-like chat per ticket: refine in Planning with a question form, steer mid-run, follow up in Review.
- Link existing Claude Code sessions to tickets; live replies; "Need you" inbox across boards.
- Paste or drop images into descriptions and chat.
- Terminal & file explorer panel, Connections panel for MCP servers, scheduled tickets on a cron, claude.ai artifacts from runs.
- Standalone binary, installer, `ckanban update` and a background service that starts at login.

[0.14.0]: https://github.com/leoawesome/kanban/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/leoawesome/kanban/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/leoawesome/kanban/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/leoawesome/kanban/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/leoawesome/kanban/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/leoawesome/kanban/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/leoawesome/kanban/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/leoawesome/kanban/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/leoawesome/kanban/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/leoawesome/kanban/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/leoawesome/kanban/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/leoawesome/kanban/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/leoawesome/kanban/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/leoawesome/kanban/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/leoawesome/kanban/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/leoawesome/kanban/releases/tag/v0.1.0
