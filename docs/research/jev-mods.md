# Jev mods with ckanban runs: evaluation

Date: 2026-10-14. Claude Code `2.1.296`. Mods from `github.com/davila7/claude-code-templates` at commit `5d3ef64` (`cli-tool/components/mods/productivity/jev-skill-suggestion` and `jev-model-router`). Jev backend: TypeSafe (`api.typesafe.ai/v1/systemone`, `jev-latest`).

## TL;DR

- **Install `jev-skill-suggestion` (default options, do NOT run its `/setup`)**: about **15% cheaper** per board run and **~8.8k fewer tokens** in every run's context, no quality loss seen. It does pick odd skills for board runs (see clashes), so add a short `neverSuggested` list.
- **`jev-model-router` only pays off with `routeMainModel` on** (off by default). With it, total spend over 4 typical tickets dropped **31%** (small edits went to Haiku: $0.32 → $0.007; a code review went to Sonnet: $0.55 → $0.21) with the same results. Without it, the router alone saved nothing (+3%).
- **The router's built-in model names are out of date** (`haiku` → `claude-haiku-4-5-20251001`, `sonnet` → `claude-sonnet-5`). Always set full model ids.
- **Jev failing never breaks a run.** A bad key, a refused connection and a server that never answers all ended in a normal, successful run. The mods give up after `timeoutMs` and let the prompt through untouched.
- **No ckanban code change is needed** for any of this. Mods installed for the user load in every board run.

Verdict: install both, with the options in [Install](#install-steps-for-leo). Treat main-model routing as a 1–2 week trial: the sample is small (2 repeats per cell) and the four tasks were not hard enough to show where a downgrade would hurt.

## How it was tested

- Each test is a throwaway `claude -p` session shaped like a board run (`src/server/runner.ts` `buildArgs`: stream-json in/out, `--permission-mode bypassPermissions`, `--session-id`), with the real board run prompt from `firstRunPrompt` (`src/server/prompts.ts`, auto mode, repo kind `local`), in a fresh clone of this repo under `/tmp` with no remote. Left out: `--mcp-config` (keeps tests off the board) and `--chrome` (keeps them out of the browser).
- Model and effort: the board default, inherited from `~/.claude/settings.json` (`opus[1m]`), as real board runs do.
- Mods loaded with `--plugin-dir`, options with `--settings <file>`. `~/.claude/settings.json` was never edited: its sha256 was the same before and after (`b6a14165…9279`).
- Four tasks: **fix2** (add a one-line doc comment and commit), **research** (explain graceful restart), **review** (review HEAD for bugs, no edits), **subagents** (three parallel Explore subagents, then a combined map).
- Five setups: `base` (no mods), `skill`, `router`, `both`, `both-main` (both + `routeMainModel`). Router options: full model ids, `timeoutMs` 1500. Skill options: defaults, `timeoutMs` 1500.
- Round 1: 1 run per cell with the router's default options, plus the offline fallback (`provider: builtin`). Round 2: 2 runs per cell with the options above. **The table uses round 2 only.**
- Costs are Claude Code's own `total_cost_usd` from the last `result` event. TypeSafe's own price per call is not included: it isn't shown anywhere the run can see.
- Total: 71 sessions, about $40.

## Measured numbers

Average of 2 runs per cell (round 2). Cost in USD; "ctx" = tokens in the first request of the main conversation (system prompt + tools + skill listing + prompt).

| Task | Setup | Cost | vs base | Wall s | ctx | Model used |
|---|---|---|---|---|---|---|
| fix2 | base | 0.323 | | 30 | 35,162 | opus |
| fix2 | skill | 0.234 | −28% | 29 | 26,801 | opus |
| fix2 | router | 0.319 | −1% | 25 | 34,280 | opus |
| fix2 | both | 0.229 | −29% | 28 | 29,056 | opus |
| fix2 | both-main | **0.007** | **−98%** | 38 | 29,888 | haiku-5-5 |
| research | base | 0.540 | | 56 | 34,020 | opus |
| research | skill | 0.411 | −24% | 58 | 24,908 | opus |
| research | router | 0.572 | +6% | 70 | 36,226 | opus |
| research | both | 0.438 | −19% | 58 | 26,227 | opus |
| research | both-main | 0.491 | −9% | 72 | 26,395 | opus |
| review | base | 0.545 | | 130 | 35,090 | opus |
| review | skill | 0.416 | −24% | 168 | 25,958 | opus |
| review | router | 0.537 | −1% | 137 | 34,267 | opus |
| review | both | 0.525 | −4% | 207 | 28,292 | opus |
| review | both-main | **0.209** | **−62%** | 54 | 25,924 | sonnet-5-5 |
| subagents | base | 1.362 | | 694* | 34,740 | opus |
| subagents | skill | 1.296 | −5% | 140 | 26,110 | opus |
| subagents | router | 1.437 | +6% | 148 | 35,278 | opus (+ sonnet subagents in 1 of 2) |
| subagents | both | 1.553 | +14% | 172 | 28,626 | opus |
| subagents | both-main | 1.203 | −12% | 146 | 29,616 | opus (+ sonnet subagents in 1 of 2) |

\* one base run took 1,266 s (a stuck subagent); the other took 122 s.

Totals over the 8 round-2 runs per setup: base **$5.54**, skill **$4.71 (−15%)**, router $5.73 (+3%), both $5.49 (−1%), both-main **$3.82 (−31%)**.

Why "router" and "both" save nothing: with main-model routing off, the router only sets effort. In these `-p` runs it reports the session effort as `medium` and mostly moved it **up** to `high` (the research and review prompts read as "ordinary engineering"), which costs more and cancels the skill picker's saving. Effort-only routing is not worth having here.

Quality: spot-checked. All fix2 runs made the same one-line doc comment and committed it, including Haiku. All review runs reached the same verdict on HEAD (no real bug, same reasoning about `box-sizing` and the 30vh cap), including Sonnet. Research answers were comparable. These tasks are small; a hard bug fix on Haiku was not tested.

Jev latency (TypeSafe, from the debug logs): router 395 ms on average (max 1,181 ms, 59 calls); skill ranking 448 ms on average (max 1,013 ms), plus a second re-rank call of about 300–400 ms. That adds about 1–1.5 s before the first turn, small next to 30–200 s runs. No call hit the 1,500 ms timeout in round 2. With the default 800 ms, 1 of the round-1 router calls timed out on the long board prompt.

The offline fallback (no key, `provider: builtin`) is not useful: it took 1.0–1.7 s per call, never suggested a skill ("nothing ranked"), and can only route *up* (it reports no confidence), so it never moved a request. Its runs were cheaper only because the skill listing was still withheld.

## Clashes with the board

| # | What | Severity | Evidence | Workaround |
|---|---|---|---|---|
| 1 | Router's built-in aliases point at old models: `haiku` → `claude-haiku-4-5-20251001`, `sonnet` → `claude-sonnet-5`. | High (if routing is on) | round 1 `fix-both-main`: `main loop → claude-haiku-4-5-20251001`; `review-both-main`: `→ claude-sonnet-5` | Set `fastModel: "claude-haiku-5-5"`, `balancedModel: "claude-sonnet-5-5"`, `deepModel: "claude-opus-5-5"`. Round 2 then used `claude-haiku-5-5` / `claude-sonnet-5-5`. |
| 2 | Skill picker reads the whole board prompt, so the board's own rules ("worktree", "commit", "deliverable") pick the skill, not the task: `superpowers:executing-plans` for a one-line doc comment, `docs` (the Claude Docs skill) for research, `caveman:caveman-review` for code review. | Medium | every fix2 run: `injected /superpowers:executing-plans`; every research run: `injected /docs` | Add `neverSuggested: "superpowers:executing-plans,superpowers:using-git-worktrees,docs"`. No run actually created a Claude Doc or changed its style, so the board's rules still won, but each wrong pick adds 1–2.5k tokens of noise. A board-side fix is a follow-up (see below). |
| 3 | `routeMainModel` makes the board show the wrong model: the ticket says Opus (board/ticket `model`), while the turn ran on Haiku or Sonnet. Cost tracking stays right: `src/server/ticket-usage.ts` reads `modelUsage` and huddles read `message.model`. | Low | `r2-fix2-both-main` `modelUsage`: only `claude-haiku-5-5` | Accept for a personal trial. Follow-up: show the model from `modelUsage`. |
| 4 | `routeMainModel` re-classifies every message, including follow-up chat messages and steering, so a long ticket conversation can switch model mid-session and lose the prompt cache. | Medium (long chats) | README of the router; not measured here (single-prompt runs) | Watch the cache-write numbers on long tickets during the trial. A per-run "Auto" model on the board (follow-up) avoids this. |
| 5 | `/jev-skill-suggestion:setup` (`skillOverrides` → `user-invocable-only`, `disableBundledSkills: true`) is **not needed**: the default `hideListing` already removed the listing (−8.8k tokens). `disableBundledSkills` would also drop `/simplify`, `/loop`, etc. from the ticket chat's `/` picker: the run's `init` event no longer lists them, and `rememberInit` (`src/server/commands.ts`) rewrites the saved bundled list from it. `user-invocable-only` skills stay in `init` and in the picker. | Medium if used | test run with `disableBundledSkills`: `init.skills` 78 → 62, `simplify` gone; `grill-me` (user-invocable-only) still listed | Don't run the setup command. |
| 6 | Hidden listing means Claude only gets a skill when Jev's "needs a skill" score is ≥ 0.3. A Planning-style prompt scored `superpowers:writing-plans` at 0.69 but the gate was 0.17, so nothing was given. If Jev is down, no skill is given and the listing is still hidden. | Low–Medium | `plan-both`: `no suggestion: needs a skill 0.17 < 0.3` | Skills named in `CLAUDE.md` or typed as `/name` still work. Put must-have skills in `alwaysListed`. |
| 7 | When Jev's server never answers, the session took ~25 s longer to **exit** after its result (36 s vs 11 s), though the answer itself was on time. | Low | `fail-blackhole` wall time | Nothing; rare. |
| 8 | Loading: auto-load from a project's `.claude/skills/` needs a trusted folder, and `-p` never asks, so ticket folder copies may silently run without the mod. | High for that install path | mod READMEs | Use `CLAUDE_CODE_PLUGIN_DIRS` (user-level), checked here: both modules loaded as `…@inline` and read options from `pluginConfigs` keys `jev-model-router` / `jev-skill-suggestion`. |

Checked and fine: Planning runs (`--permission-mode plan`) work with both mods. Subagents get their own classification (`agent.spawn`), and Explore subagents were sent to Sonnet when Jev was confident enough. Huddle agents are separate `claude -p` sessions, so they behave like ticket runs.

### Failure handling ("if Jev has a problem, just bypass it")

Both mods already fail open, by design (`$.http.fetch` wrapped in a race with `$.clock.sleep(timeoutMs)`; every error path logs and calls `next()` unchanged). Tested with both mods on:

| Case | Mod log | Run result |
|---|---|---|
| Wrong key | `typesafe responded 401` → `main loop: no decision`, `no suggestion: no answer` | success |
| Server refuses connection | `classification failed: … ECONNREFUSED` → no decision | success |
| Server never answers | `classification passed 800ms; leaving the turn alone` | success (exit ~25 s slower) |

No error reaches the board in any case. The only cost of a Jev outage is that turn runs as if the mods were absent, except that the skill listing stays hidden (clash 6).

Privacy: with the key set, every prompt (including the board's run instructions and ticket text), each subagent's prompt, and the names and descriptions of all installed skills, plus ~700-character excerpts of the 3 shortlisted ones, go to TypeSafe. The mods' code was read before running: the only network calls are to the configured backend URL, and the only file access is reading skill files under `~/.claude` (no writes outside the setup command, which is not used).

## Install steps for Leo

Not done by this ticket; `~/.claude/settings.json` was left as it was.

1. Put the mods somewhere stable (pinned commit):
   ```sh
   mkdir -p ~/.claude/mods && cd /tmp && rm -rf cct
   git clone --filter=blob:none --sparse https://github.com/davila7/claude-code-templates cct
   cd cct && git checkout 5d3ef64aca75f62027b4eb14bd20a65b86bcc99b
   git sparse-checkout set cli-tool/components/mods/productivity/jev-skill-suggestion cli-tool/components/mods/productivity/jev-model-router
   cp -R cli-tool/components/mods/productivity/jev-* ~/.claude/mods/
   ```
2. Add to `~/.claude/settings.json` (merge with what's there; replace `<TYPESAFE_API_KEY>`):
   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "/Users/leo/.claude/mods/jev-skill-suggestion:/Users/leo/.claude/mods/jev-model-router"
     },
     "pluginConfigs": {
       "jev-skill-suggestion": {
         "options": {
           "typesafeApiKey": "<TYPESAFE_API_KEY>",
           "timeoutMs": 1500,
           "neverSuggested": "superpowers:executing-plans,superpowers:using-git-worktrees,docs"
         }
       },
       "jev-model-router": {
         "options": {
           "typesafeApiKey": "<TYPESAFE_API_KEY>",
           "timeoutMs": 1500,
           "fastModel": "claude-haiku-5-5",
           "balancedModel": "claude-sonnet-5-5",
           "deepModel": "claude-opus-5-5",
           "routeMainModel": true,
           "routeMainEffort": false
         }
       }
     }
   }
   ```
   `routeMainEffort: false` follows from the numbers above (effort routing only raised cost); this exact combination was not run. To try only the skill picker, leave out the `jev-model-router` entries and its path.
3. No ckanban restart is needed: every run starts a fresh `claude`. Restart open interactive Claude Code sessions.
4. Check: `claude -p --debug-file /tmp/jev.txt "say OK"`, then `grep "ready on" /tmp/jev.txt`. It should show `ready on typesafe` twice. `no key set` means the `pluginConfigs` key is wrong.
5. Don't run `/jev-skill-suggestion:setup` (clash 5).

To undo: remove the `CLAUDE_CODE_PLUGIN_DIRS` line and both `pluginConfigs` entries, then `rm -rf ~/.claude/mods/jev-*`. Nothing else was changed, so there is nothing else to restore.

## Suggested follow-up tickets

1. **Board "Auto" model** (M): when a ticket's model is "Auto", the board asks Jev once at the start of a run (ticket title + body, not the board boilerplate) and passes the result as `--model`. This fixes clashes 2-for-models, 3 and 4: the board shows the real model, and the model stays fixed for the whole session, so the cache isn't lost. Fail open to the board model.
2. **Show the real model on a ticket** (S): show the models from the run's `modelUsage` next to the cost, so any routing (mod or board) is visible.
3. **Measure the trial** (S, after 1–2 weeks): compare per-ticket cost and outcome (done / blocked / reopened) before and after install, from `~/.claude-kanban` ticket usage, and decide whether main-model routing stays on.
