# Changelog

What changed in each ckanban release. Get the latest with `ckanban update`.

## Unreleased

## [0.10.0] - 2026-10-11

### Added
- **Huddles**: several Claude sessions work one ticket together in a shared room. The ticket's own session is `@main`; teammates (reviewer, QA, engineer, security, researcher, ux-critic, facilitator, ...) are woken by `@tags`, post findings and report back. Claude proposes a huddle as an editable card in the chat; the **Huddle tab** shows the live feed, roster with status and cost per agent, pinned findings, a pinned brief and a composer with `@` autocomplete.
- Huddle safety: a budget per huddle (default $20, Resume adds more), message and loop brakes, read-only teammates working in a snapshot of the committed code, and only you can close a huddle.
- Click a huddle participant to watch its own Claude session, read-only, next to the feed.
- Switch between a ticket's huddle rounds; each huddle gets its own summary.
- Teammates propose lessons when they finish; you review them in the **🎓 Learnings** drawer and save them as notes that every future teammate of that role gets.
- Whole-huddle templates (roster, rounds, budget, report format), including a built-in *Design review*.
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
