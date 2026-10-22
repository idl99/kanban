# Contributing to ckanban

Thanks for wanting to help. Bug reports, ideas, docs fixes and code are all welcome.

## Reporting bugs and asking for features

Open an issue on GitHub. For a bug, include:

- What you did, what you expected and what happened instead.
- Your ckanban version (`ckanban --version`) and macOS version.
- Any error text from the board or the daemon log.

For a feature, describe the problem you want solved before the solution you have in mind.

## Setting up

You need [Bun](https://bun.sh) 1.3.5 or newer.

```bash
git clone https://github.com/<your-fork>/ckanban.git
cd ckanban
bun install && (cd web && bun install)
```

Layout:

- `src/` is the Bun + TypeScript server and CLI.
- `web/` is the React + Vite board UI.
- `test/` holds the server tests. They use a fake `claude` binary, so no real sessions run.
- `docs/` holds user docs and design notes.

Run from source:

```bash
bun run dev            # API + UI on :7777
cd web && bun run dev  # Vite dev server with /api proxy
```

More detail is in the README under Development.

## Making a change

1. Fork the repo and branch from `main`.
2. Keep each change focused on one thing.
3. Add or update tests for behavior you change.
4. Before pushing, run:

   ```bash
   bun run test
   bunx tsc --noEmit
   bun run build:web   # only if you touched web/
   ```

5. Open a pull request against `main` and describe what changed and why. Link the issue if there is one.

## Code and wording

- Match the style of the code around you.
- Many users are not technical and may not know git. Never assume git, commits, a remote or `gh` in a feature; always keep a path that works without them.
- In anything users see, use plain words ("version history", "copy of the folder") instead of "git", "worktree", "branch" or "commit".

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`. Keep the subject short and in the present tense.

## Changelog

Do not edit `CHANGELOG.md` in a pull request. Maintainers write it at release time from the commit history, so a clear commit message is what counts.

## Releases

Maintainers only. The steps are in the README under Releasing.

## License

By contributing you agree your work is released under the [MIT License](LICENSE).
