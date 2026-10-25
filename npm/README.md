# ckanban

Kanban board for Claude Code. Move a ticket to Ready and Claude works on it by itself, in any folder, with or without git.

```bash
npx ckanban
```

This downloads the ckanban Mac app, checks it against the release's checksums, puts it in `~/.local/bin/ckanban`, starts it as a background service and opens the board at http://localhost:7777. You need [Claude Code](https://claude.com/claude-code) installed and logged in. macOS only.

After that, `npx ckanban` opens the board, and `npx ckanban <command>` runs any ckanban command (for example `npx ckanban update`).

Settings: `CKANBAN_VERSION=0.14.0` picks a version, `CKANBAN_BIN_DIR` picks the folder, `CKANBAN_NO_DAEMON=1` skips the background service.

Everything else: https://github.com/leoawesome/ckanban
