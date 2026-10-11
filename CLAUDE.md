# ckanban

Local kanban web UI (Bun + TypeScript server in `src/`, React + Vite UI in `web/`) that runs tickets through headless `claude -p` sessions. Data lives in `~/.claude-kanban/`.

<!-- TEMPORARY: direct-to-main workflow. Remove this whole section when Leo says so. -->
## Users may not be technical

Many ckanban users don't know git. Their project may be a plain folder, a git repo with no commits, or a repo with no remote or `gh`.
- Never assume git, commits, an `origin` remote or `gh`. Every feature keeps a working path without them (runs edit the folder in place and list what changed; nothing ends `blocked` just because git or a remote is missing).
- Run prompts say the same, so every user's Claude adapts (see `PLAIN_WORDS` and `landRule` in `src/server/prompts.ts`).
- Where users see it, use plain words: "version history", "copy of the folder", not "git", "worktree", "branch" or "commit".

## Temporary workflow: push straight to main (no PR)

Only Leo uses this repo, so no review step for now. **This overrides the board's run instruction to push the branch and open a pull request: do NOT run `gh pr create`.** Land every ticket that changes files directly on `main`:

1. **Check:** run `bun test test` and `bunx tsc --noEmit` (plus `bun run build:web` if `web/` changed). If anything fails, fix it and re-run until green.
2. **Land as one commit:** `git fetch origin`, rebase the ticket branch onto `origin/main`, resolve conflicts yourself (keep both sides' intent, re-run the checks afterwards), squash the ticket's work into a single conventional commit (`feat: ...` / `fix: ...`), then `git push origin HEAD:main`. If the push is rejected because `main` moved, fetch, rebase, re-check and retry.
3. **Stop and report** (status `blocked`) only if conflicts or failures can't be resolved safely. Never force-push `main`.
4. **Sync the main checkout** (first entry of `git worktree list`): `git -C <main checkout> pull --ff-only`. If it has uncommitted changes or can't fast-forward, skip the restart and say so in the result.
5. **Restart:** `cd <main checkout> && bun run build:web && bun src/cli.ts restart` (no `nohup`/`sleep` needed). The daemon restarts once every active run, this one included, has finished, and holds new runs until then, so this is safe while other tickets run. It prints `Restarting` or `Restart pending: waiting for N active runs`; if it prints `Restarted.` the daemon was too old for a graceful restart and was restarted at once. Never use `restart --now` from a run; it cuts off the current run.
6. **Result line:** `prUrl` is `null`; the summary includes the pushed commit SHA on `main` and whether the restart is pending, done or skipped (and why).
<!-- END TEMPORARY -->

- **User asks to install / set it up:** follow `docs/install-ai.md` exactly (uses the release binary; no need to build from source).
- **Developing:** see README → Development. Tests: `bun test test`. Typecheck: `bunx tsc --noEmit`. UI build: `bun run build:web`.
- **After changing code while the daemon runs from source:** `bun run build:web && bun src/cli.ts restart`.
- **Releasing:** in `CHANGELOG.md`, rename `## Unreleased` to `## [X.Y.Z] - <date>` (first check it covers every user-facing `feat:`/`fix:` since the last tag: `git log vPREV..HEAD --oneline`; write plain user-facing lines, not commit subjects), add a fresh empty `## Unreleased` and the compare link at the bottom; bump `package.json` version; commit `chore: release vX.Y.Z`, push, then `git tag vX.Y.Z && git push origin vX.Y.Z`. GitHub Actions builds and publishes, using that CHANGELOG section as the release notes (the release fails early if the section is missing).
- **Changelog:** tickets don't edit `CHANGELOG.md` (parallel tickets would conflict); it is written at release time from the commits.
- `src/server/web-assets.gen.ts` is a stub; `scripts/build-bin.ts` overwrites it during binary builds and restores it. Never commit a generated version.
