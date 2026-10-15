<p align="center">
  <img src="docs/assets/logo.svg" width="88" height="88" alt="ckanban logo">
</p>

<h1 align="center">ckanban</h1>

<p align="center"><b>Kanban for Claude Code.</b> Drop a ticket into Ready and a headless Claude Code session picks it up, does the work and moves it to Review, with a GitHub PR when it changed code.</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/board-dark.webp">
    <img src="docs/assets/screenshots/board.webp" alt="The ckanban board: Backlog, Planning, In Progress, Review and Done columns with tickets Claude is working on">
  </picture>
</p>

## What it does

- 🤖 **Tickets run by headless Claude.** Move a card to Ready and a `claude -p` session works it in its own git worktree and branch, up to 5 at once per board.
- 💬 **Planning chat.** Claude interviews you with a clickable question form, draws HTML mockups for UI work and proposes a clear ticket. *Apply & start work* is one click.
- 🗺️ **Plans.** Split a big ticket into child tickets that run unattended in dependency order; Claude is only woken when one needs it.
- 🗣️ **Huddles.** A team of Claude teammates (reviewer, QA, researcher, UX critic, facilitator, ...) discuss one ticket in a shared room, tag each other and pin findings, with a budget you set. While you're away, Claude starts a review huddle on its own before landing ⭐ Important or risky work.
- ✅ **Review with PR checks.** See the diff, comment on lines, watch the PR's checks on the card, send failures back to Claude, or **Merge & done**.
- 👥 **Team tab.** Your teammates, their prompts and the notes they've learned, for every board or just one.
- ⌘ **`⌘K` everywhere.** Jump to any ticket on any board by title, description, result or PR number, or run any action.

All data lives in plain files under `~/.claude-kanban/`.

## Install (macOS)

You need [Claude Code](https://claude.com/claude-code) installed and logged in, plus `git`. For PRs, also install `gh` and run `gh auth login`.

```bash
curl -fsSL https://raw.githubusercontent.com/leoawesome/kanban/main/install.sh | bash
```

This downloads one self-contained binary to `~/.local/bin/ckanban` (no Bun/Node needed), starts it as a background service that launches at login, and opens http://localhost:7777.

Or paste this into Claude Code (or any coding assistant with a terminal):

```text
Install ckanban for me by following
https://raw.githubusercontent.com/leoawesome/kanban/main/docs/install-ai.md
```

Then open the board switcher (top left) → **New board…**, pick a folder you've used Claude Code in, and create a ticket.

## How it works

**Backlog → Planning → Ready → In Progress → Review → Done.** Park ideas in Backlog. In Planning, Claude asks questions and shapes the ticket without changing files. Ready starts a run; In Progress shows Claude's latest step on the card. In Review you check the diff and the PR, chat to change it, and merge. A merged PR moves the card to Done.

## Screenshots

| | |
|---|---|
| **One chat per ticket**, like the terminal: steer it while it runs.<br><img src="docs/assets/screenshots/ticket-chat.webp" alt="A ticket drawer: details and description on the left, Claude's chat on the right"> | **Planning**: Claude interviews you before it starts.<br><img src="docs/assets/screenshots/planning.png" alt="A Planning ticket: Claude asks questions in a clickable form with a recommended option"> |
| **Plans** run child tickets in order, unattended.<br><img src="docs/assets/screenshots/plan.webp" alt="The Plan tab: 13 of 14 child tickets done, with their dependencies"> | **Huddles**: teammates discuss, pin findings and stay on budget.<br><img src="docs/assets/screenshots/huddle.webp" alt="The Huddle tab: a facilitator's ranked list in the feed, the brief, participants with cost and pinned findings"> |
| **Team**: teammates, their prompts and saved notes.<br><img src="docs/assets/screenshots/team.webp" alt="The Team tab in the dock: built-in teammates and the facilitator's prompt and notes"> | **`⌘K`** finds tickets by title, description, result or PR.<br><img src="docs/assets/screenshots/command-bar.webp" alt="The command bar matching 'spend limit' in a ticket's description, with a snippet"> |

## More features

Inbox of everything waiting on you, Changes tab with line comments, worktree setup (`.env` copy and install), auto-continue after a usage limit, one-click session recovery, schedules on a cron, prompt snippets, terminal & files panel, MCP connections, branching a ticket, and tickets that ask each other questions.

Every feature in detail: **[docs/features.md](docs/features.md)**. What changed in each release: **[CHANGELOG.md](CHANGELOG.md)**.

## Everyday commands

```bash
ckanban update      # get the latest release (the board also shows a banner when one is out)
ckanban restart     # restart the background service once active runs finish (--now: at once)
ckanban open        # open the board
ckanban remote on   # open the board from your phone over Tailscale (off / status too)
ckanban uninstall   # stop and remove the service (your boards in ~/.claude-kanban stay)
```

It runs in the background and survives restarts ([details](docs/features.md#runs-in-the-background-survives-restarts)). Logs: `~/.claude-kanban/daemon.log`. If `ckanban` isn't found, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc`.

## On your phone

With [Tailscale](https://tailscale.com/download) on your Mac and phone (same account, MagicDNS and HTTPS certificates on for the tailnet), run `ckanban remote on` or use **⋯ → Phone access**. You get `https://<your-mac>.<tailnet>.ts.net` and a QR code. On a phone the board opens on **Now** (what needs you, what runs, what's being planned); tickets open full screen. Add it to the Home Screen to use it like an app.

## Use the board from Claude Code / Codex

```bash
ckanban mcp install    # register the MCP server with Claude Code and Codex
```

Then ask, for example, "Scan this repo for unfinished work and create a ticket on my board for each." Tools, CLI equivalents and rules for runs: [docs/features.md](docs/features.md#use-the-board-from-claude-code--codex).

Found a bug? **⋯ → Report a bug** in the header ([how it works](docs/features.md#reporting-bugs)).

## Security

Runs use `--permission-mode bypassPermissions`: Claude can execute any command in the ticket's folder without asking. Only put tickets on boards whose folders you trust Claude to modify.

The server binds to `127.0.0.1` only and rejects requests with a non-localhost `Host` or cross-site `Origin`, so other websites cannot drive it.

Phone access (`ckanban remote on`) uses `tailscale serve`, which reaches only devices on your tailnet (never Tailscale Funnel, never public). Serve points at a separate loopback port (the board port + 1) where every request is treated as coming from the tailnet: it must use the `*.ts.net` name and come from the Tailscale login that turned it on (the `Tailscale-User-Login` header `tailscale serve` sets). Phone access can only be turned on or off on the Mac, and board runs can't change it. `ckanban remote off` turns it off again.

## Development

Requires [Bun](https://bun.sh) ≥ 1.3.5 (the embedded terminal uses Bun's built-in PTY; on older Bun everything else works and the terminal says to upgrade).

```bash
bun install && (cd web && bun install)
bun run test           # server tests, files in parallel (use a fake claude binary)
bun run build:web      # build the UI into web/dist
bun run dev            # API + UI on :7777 from source
cd web && bun run dev  # Vite dev server with /api proxy
bun run build:bin      # standalone binaries in dist/ (UI embedded)
```

`bun run test` runs test files side by side (`bun test --parallel`), slowest first using `test/timings.json`; refresh that file with `bun run test:timings` after adding or splitting slow test files. `bun test test/<file>` runs one file.

Run from source as the daemon: `bun src/cli.ts install`. Data layout and env overrides: [docs/features.md](docs/features.md#data-layout).

### Releasing

Move the `## Unreleased` notes in [CHANGELOG.md](CHANGELOG.md) under `## [X.Y.Z] - <date>`, bump `version` in `package.json`, commit, then:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

GitHub Actions takes the release notes from that CHANGELOG section, runs the tests, builds `ckanban-darwin-arm64` / `ckanban-darwin-x64` with the UI embedded, and publishes a GitHub Release. Users get it with `ckanban update`.

Design: `docs/superpowers/specs/2026-09-29-claude-kanban-design.md`.

---

Made by Leo. MIT License, see [LICENSE](LICENSE).
