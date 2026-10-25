# Installing ckanban — guide for AI assistants

You are helping a user install **ckanban**: a local web kanban board where tickets are worked by headless Claude Code sessions. Follow these steps in order. Run each command, check its result, and only move on when the check passes. Tell the user briefly what you did at the end.

Supported: **macOS only** (Apple Silicon or Intel). If `uname -s` is not `Darwin`, stop and tell the user it is not supported yet.

## 1. Check prerequisites

```bash
uname -s && uname -m
command -v claude && claude --version
command -v git && git --version
command -v gh && gh auth status
```

- `claude` missing → tell the user to install Claude Code (https://claude.com/claude-code) and log in, then continue. The board cannot run tickets without it.
- `git` missing → `xcode-select --install` (needs user interaction; ask them to accept the dialog).
- `gh` missing or not logged in → optional. Without it Claude cannot open pull requests. Suggest `brew install gh && gh auth login` (interactive; the user must run the login themselves).

## 2. Install

```bash
curl -fsSL https://raw.githubusercontent.com/leoawesome/ckanban/main/install.sh | bash
```

This downloads the `ckanban` binary to `~/.local/bin/ckanban`, installs a launchd agent (`~/Library/LaunchAgents/io.ckanban.daemon.plist`), starts it, and opens http://localhost:7777.

If `curl` can't reach raw.githubusercontent.com but Node is installed, `npx --yes ckanban` does the same steps.

Options (environment variables, put before `bash`): `CKANBAN_VERSION=0.1.0` pins a version; `CKANBAN_BIN_DIR=/path` changes the install folder.

## 3. Make `ckanban` available on PATH

```bash
command -v ckanban || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

If you appended to `~/.zshrc`, tell the user to open a new terminal (or `source ~/.zshrc`). In your own shell use the full path `~/.local/bin/ckanban` until then.

## 4. Verify

```bash
~/.local/bin/ckanban --version
curl -s http://localhost:7777/api/health
launchctl print gui/$(id -u)/io.ckanban.daemon | grep -E "state|pid"
```

Expected: a version number, JSON like `{"claude":true,"git":true,"gh":true}`, and `state = running`.

- Health shows `"claude":false` → the service cannot find the `claude` binary on its PATH. Make sure `claude` works in the user's shell, then re-run `~/.local/bin/ckanban install` from that shell (it records the current PATH).
- `curl` fails to connect → check `~/.claude-kanban/daemon.log`. If port 7777 is in use by something else, tell the user.

## 5. Hand over to the user

Tell them:
- Open http://localhost:7777.
- Board switcher (top left) → **New board…** → pick a folder they have used Claude Code in (or Browse…). One board per folder.
- **New ticket** → describe the task. **Start planning** (default) has Claude ask clarifying questions in the ticket chat and propose a clear ticket; **Start now** (or moving the card to **Ready**) starts the work.
- Runs use `--permission-mode bypassPermissions`: Claude can run any command in that folder without asking. Only create boards for folders they trust Claude to change.

## Updating, restarting, uninstalling

```bash
ckanban update      # download latest release and restart the service
ckanban restart     # restart the service once active runs finish (--now: at once)
ckanban uninstall   # stop and remove the service; boards in ~/.claude-kanban are kept
```

To remove everything: `ckanban uninstall && rm ~/.local/bin/ckanban` (and `rm -rf ~/.claude-kanban` only if the user explicitly wants their boards deleted — it cannot be undone).

## Do not

- Do not run `sudo` for any step; everything installs in the user's home folder.
- Do not delete `~/.claude-kanban` unless the user explicitly asks.
- Do not enter passwords or tokens on the user's behalf (e.g. `gh auth login`); ask the user to run interactive logins themselves.
