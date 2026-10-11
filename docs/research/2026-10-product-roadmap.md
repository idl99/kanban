# ckanban: what to build next (2026-10)

Research from a huddle on 2026-10-11 (ticket t_20261011_anky, huddle h_sq3ak68q) at snapshot `4cabc58`. Six researchers each covered one angle: competitors, own UX audit, power-user workflows, community demand, contrarian/simplify, growth/onboarding. A facilitator merged their ideas, removed duplicates and ranked them.

**Ranking view:** Leo is the engineer and product owner, works solo, uses the board daily and pushes straight to `main`. Each idea is weighed on value to the product against effort and the complexity it adds.
**Scores:** Impact 1-5 · Effort S/M/L · Confidence low/med/high · Complexity added low/med/high.

## TL;DR: top 5 and why

1. **Push "needs you" off the Mac.** Today the only alert is a macOS banner (osascript), and only when a plan finishes or gets stuck (`src/server/board.ts:49,1334,1410`). Unattended runs are the point of the product, but you have to be at the Mac to learn that one is waiting. `attention.ts` already computes every Inbox kind, and phone access already exists, so this is mostly wiring. Ship an ntfy/webhook URL first (S), Web Push through the PWA later (M).
2. **Inbox triage on desktop.** Desktop Inbox rows can only jump to the ticket (`web/src/Inbox.tsx:72-88`). The audit found 16 items, the oldest waiting 12 days, so the count has stopped meaning anything. The phone Now view already has the actions (Mark done / Snooze / Answer); reuse them.
3. **Cost visible and capped.** Cost is a grey chip deep in the drawer (`TicketDrawer.tsx:592`), and the huddle roster showed $0.00 while agents worked. Add $ on cards, "today $X" in the header and an optional per-run cap via `claude --max-budget-usd` (not used anywhere in `src/`).
4. **Bug: auto huddles ignore the ticket's budget.** This ticket asked for about $40 and got the $20 default, because `src/server/http.ts:1170-1182` never passes `maxCostUsd` to `startAuto`. A tiny fix.
5. **Simplification pass.** Over 258 tickets there are 0 real `ask_ticket`/`reply_ticket` calls and 2 artifact-helper calls, yet every run prompt teaches them. There are 42 MCP tools, `mcp-server.ts` is 81 KB and `prompts.ts` is 622 lines. Cut or opt-in the unused paths and measure tokens before and after.

**Suggested order:** #4 and #9 (quick fixes) → #1 → #2 → #3 → #5 → #6 → #8 → #7 → #10.

**Market context:** Vibe Kanban, the closest peer (~28k stars), shut down on 2026-04-10. It never found a business model for its cloud and team features, and its users are asking for a local, solo, no-account board ([shutdown post](https://vibekanban.com/blog/shutdown), [vibe-kanban#3354](https://github.com/BloopAI/vibe-kanban/issues/3354)). ckanban is exactly that, but it has 1 star and about 0 release downloads. No competitor found has anything like huddles.

## Competitor matrix

Y = yes, P = partial, N = no, ? = not stated in the sources. ckanban cells were checked against `docs/features.md` and a grep of `src/` and `web/src`.

| Capability | ckanban | Vibe Kanban | Claude Squad | Conductor | Nimbalyst | Sculptor | Cline Kanban | Superset | Cursor Cloud | Devin | Codex cloud | Jules | Copilot agent |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Kanban board UI | Y | Y | N (TUI) | N (sidebar) | Y | N | Y | N | N | N | N | N | N |
| Worktree/branch per task | Y | Y | Y | Y | P | N (container) | Y | Y | N (VM) | N | N | N | N |
| Runs unattended | Y | P | P (auto-yes) | P | ? | Y | Y | Y | Y | Y | Y | Y | Y |
| Runs with laptop closed (cloud) | N | N | N | Y (Cloud, 2026-07) | ? | P | N | P | Y | Y | Y | Y | Y |
| Several agent CLIs | N (Claude only) | Y (10+) | Y | Y (4) | Y | P | Y | Y | n/a | n/a | n/a | n/a | P |
| Planning interview before work | Y | N | N | P (plan mode) | ? | N | N | N | N | P | N | Y (plan approval) | N |
| Dependency-ordered plans | Y | N | N | N | ? | N | Y (linked cards) | N | N | N | N | N | N |
| Inline diff comments to the agent | Y | Y | N | P | P | P | Y | Y | N | N | P | N | P |
| PR checks on card + merge | Y | P | N | Y (Checks tab) | ? | N | P | ? | Y | Y | Y | Y | Y |
| Start from Linear/GitHub issue or Slack | N | N | N | Y | ? | N | P (Linear MCP) | ? | Y | Y | P | P | Y |
| Schedules / automations | Y (cron) | N | N | N | ? | N | N | Y | N | N | N | N | Y |
| Phone access | Y (PWA over Tailscale) | P | N | Y (iOS app) | Y (iOS) | N | N | N | Y (iOS + PWA) | Y | Y | Y | Y |
| Push notification "needs you" | N | ? | N | ? | Y | N | N | ? | Y | Y | Y | Y (browser) | Y |
| Dev-server preview per task | N | Y | N | P (run script + port) | ? | N | N | Y | Y | Y | N | N | N |
| Per-repo run/setup script | P (setup + cleanup) | Y | N | Y | ? | N | ? | ? | Y | ? | Y | Y | Y |
| Repo-committed shared config | N | ? | N | Y | ? | N | ? | ? | Y | ? | ? | Y (AGENTS.md) | Y |
| Parallel-conflict awareness | P (manual Needs) | N | N | N | N | P | N | N | N | N | N | N | N |
| Multi-agent team review (huddles) | Y | N | N | N | N | N | N | N | N | N | N | N | N |
| Cost visibility / limits | P | ? | N | ? | ? | ? | ? | ? | Y (spend limit) | Y (ACU) | P | P | P |
| Screenshot/video artifacts | P (mockups) | N | N | P | ? | N | N | N | Y | Y | N | N | N |
| Multiplayer | N | Y (closed) | N | Y | Y | N | N | N | Y | Y | Y | N | Y |
| Free + local | Y | Y | Y | Y (BYO keys) | Y | free preview | Y | Y (1 user) | N | N | N | N | N |

**Sources:**
- **Vibe Kanban:** [repo](https://github.com/BloopAI/vibe-kanban), [shutdown](https://vibekanban.com/blog/shutdown)
- **Claude Squad:** [repo](https://github.com/smtg-ai/claude-squad)
- **Conductor:** [docs](https://www.conductor.build/llms-full.txt), [changelog](https://www.conductor.build/changelog) (Cloud 0.78.0 on 2026-07-30, iOS 0.90.0 on 2026-10-02)
- **Crystal → Nimbalyst:** [Crystal repo](https://github.com/stravu/crystal), [Nimbalyst blog](https://nimbalyst.com/blog/best-agent-management-tools-2026/) (vendor)
- **Sculptor:** [imbue.com/sculptor](https://imbue.com/sculptor)
- **Cline Kanban:** [cline.bot/cli](https://cline.bot/cli), [review](https://azukiazusa.dev/en/blog/cline-kanban/)
- **Superset:** [comparison](https://superset.sh/compare/superset-vs-vibe-kanban) (vendor)
- **Cursor:** [cloud agent docs](https://cursor.com/docs/cloud-agent)
- **Devin:** [docs](https://docs.devin.ai/get-started/devin-intro)
- **Codex cloud:** [docs](https://learn.chatgpt.com/docs/cloud)
- **Jules:** [docs](https://jules.google/docs)
- **Copilot agent:** [docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)
- **Others** (Mux, Opcode, Emdash...): [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)

**Takeaways:**
- Conductor has the most momentum: cloud runs, an iOS app, a Series A.
- Every cloud tool can notify you on your phone. Push notification is ckanban's clearest gap among things that are cheap for it to build.
- Planning interviews, dependency plans, schedules and huddles are where ckanban is ahead.

## Ranked ideas: top 10

| # | Idea | Angles | Impact | Effort | Conf | Cplx | Rationale and evidence |
|---|------|--------|-------|--------|------|------|----------|
| 1 | **Push "needs you" off the Mac**: ntfy/webhook URL first, Web Push through the PWA later. Fire on every Inbox transition (questions, review, failed, limit, blocked) with title and deep link, toggle per kind | power, competitors | 5 | S→M | high | low | Only osascript, only for plans (`board.ts:49,1334,1410`); `web/public/sw.js` has no push handler. Conductor, Cursor and Jules all notify. Users build it themselves with hooks + ntfy ([dev.to](https://dev.to/pederaa/how-to-know-when-a-claude-code-agent-needs-your-approval-without-watching-the-terminal-5ekf)) |
| 2 | **Desktop Inbox triage**: Mark done / Snooze 1d / Answer on each row, reusing the NowView actions | ux | 4 | S | high | low | `Inbox.tsx:72-88` rows can only jump; 16 items, oldest 12 days. Also covers most of "review queue mode" |
| 3 | **Cost visible and capped**: $ on running/review cards, "today $X" in the header, live per-agent huddle cost, optional `--max-budget-usd` per run (board default + per ticket) | ux, power, competitors | 4 | S-M | med | low | `TicketDrawer.tsx:592`; only huddles have budgets (`types.ts:446`). Cursor requires a spend limit ([docs](https://cursor.com/docs/cloud-agent)) |
| 4 | **Auto huddles honour the requested budget** (bug) | ux | 3 | S | high | low | `http.ts:1170-1182` never passes `maxCostUsd`; this ticket asked for ~$40 and got $20 |
| 5 | **Simplification pass**: cut ask/reply_ticket, make the artifact helper opt-in, hide Needs unless set, trim prompts/MCP surface and measure tokens | contrarian, ux | 3 | S-M | high | removes | Tool-call counts over 258 tickets (see cut list) |
| 6 | **Run resilience**: a watchdog flags runs with no output for N minutes and puts them in the Inbox; auto-retry once on transient failures | power, community | 3 | S | med | low | The idle timer only starts after Claude finishes (`runner.ts:158-172`), so a hung tool stays In Progress forever. `api_retry` is only displayed (`activity.ts:90`). [vibe-kanban#3039](https://github.com/BloopAI/vibe-kanban/issues/3039) |
| 7 | **First run that works**: say "board", not "profile"; open New board with recent folders right away; offer a sample ticket; installer checks SHA256SUMS | growth | 4 (new users) | S | high | low | "No profiles yet" (`App.tsx:726`); recent folders already exist (`ProfileDialog.tsx:145`); `install.sh` ignores the published checksums |
| 8 | **"Resolve conflicts" button** next to the conflict chip: sends "rebase onto base and fix" | power | 3 | S | high | low | Chip at `prstatus.ts:42` has no action; "Send failures to Claude" is the same pattern |
| 9 | **Honest header counts**: "1 working · 6 huddle agents" instead of "0/5 running"; label scope ("7 here · 16 all boards"); fix Backlog badge | ux | 3 | S | high | low | `App.tsx:645` counts slots; `Card.tsx:57` vs `attention.ts:66` |
| 10 | **Launch package aimed at Vibe Kanban users**: demo GIF, install near the top, "Coming from Vibe Kanban?", repo homepage + social preview, then Show HN | growth, community | 4 (reach) | S | med | none | 1 star, ~0 downloads; [vibe#3354](https://github.com/BloopAI/vibe-kanban/issues/3354), [#2727](https://github.com/BloopAI/vibe-kanban/issues/2727). Do it after #7 |

## Ranked ideas: everything else

| Idea | Angle | I | E | Conf | Cplx | Why lower |
|------|-------|---|---|------|------|-----------|
| File-overlap radar between parallel tickets | power, competitors | 4 | M | med | med | Real problem ([study summary](https://codex.danielvaughan.com/2026/07/28/agent-pr-merge-conflicts-concurrent-coding-agents-codex-cli-worktree-isolation-coordination-defence/)), but landing already rebases and #8 covers PRs cheaply |
| Review queue mode / batch-merge green PRs | power | 4 | M | med | low | #2 covers most of it at S |
| Usage-aware throttling of Ready pickup | power | 4 | M | med | med | Auto-continue recovers; do #3 first |
| Repo-committed config (`.ckanban.json`) | community, competitors | 3 | M | med | low | Value is sharing; solo user, setup is auto-detected |
| Per-ticket model choice | community | - | - | - | - | Already exists (`/model`, `types.ts:100`) |
| Model fallback when rate-limited | community | 2 | M | low | med | Limits are account-wide; auto-continue covers it |
| Stacked / dependent PRs | community | 2 | L | med | high | Plans run children after their deps; repo pushes to main |
| Per-commit diff + mark file viewed | community | 3 | M | med | low | One discussion; cheaper review wins first |
| Start from an existing branch/PR, branch templates | community | 2 | S | high | low | Demand in claude-squad (#86, #88, #124), rarely Leo's flow |
| Import GitHub/Linear issues as tickets | community, competitors | 2 | M | med | med | Already possible through `ckanban mcp` from Claude Code; at most a doc line |
| "Open in editor" button | community | 2 | S | med | low | Terminal panel + Copy resume command cover it; filler task |
| Per-repo run/preview script + port per worktree | competitors | 3 | M | med | med | Mostly web-app value; adds moving parts |
| Review strip (deployments/todos, needs approval vs finished) | competitors | 2 | S-M | low | low | Inbox kinds already split these |
| Screenshot/video artifacts in Review | competitors | 3 | M-L | low | med | Heavy; mockups already exist |
| Readable huddle roster (full handles, verbs not raw tool args) | ux | 3 | S-M | med | low | Only matters while a huddle runs; cost part is in #3 |
| Header declutter (Team into ⋯ etc.) | ux | 2 | S | med | removes | Polish; pair with #9 |
| Homebrew tap | growth | 3 | S-M | med | low | After #10 shows demand |
| Linux build + systemd | growth | 4 | L | med | med | Only matters once there are users |
| `npx ckanban` shim | growth | 2 | M | low | med | Binary is macOS-only |
| Phone nav: Schedules tab → Inbox/Huddles | contrarian | 2 | S | high | removes | Tiny; see cut list |

## Cut / simplify list

Counts come from real tool_use calls across 258 tickets on 6 boards in `~/.claude-kanban`. Several features are only 4-10 days old, so "0 uses" is partly because they are new.

| Proposal | Evidence | Verdict |
|----------|----------|---------|
| Cut `ask_ticket` / `reply_ticket` | 0 calls; 10-min blocking wait + timeout logic (`src/mcp-server.ts:117-124`, `:1250`) | **Cut** (in #5) |
| claude.ai artifact helper opt-in | 2 calls; tmux + hidden interactive claude (`src/server/artifact.ts`, 217 lines); taught in every run prompt | **Opt-in** (in #5) |
| Hide the Needs editor unless set | 0 values in 258 tickets; sits above the description (`web/src/Needs.tsx`) | **Hide** (in #5) |
| Trim run prompts / MCP surface | 42 tools, `mcp-server.ts` 81 KB, `prompts.ts` 622 lines | **Do** (in #5), measure tokens |
| Manager mode (`adopt_tickets`) | 0 calls; overlaps Plans (20 uses) | **Revisit 2026-11-10** |
| Branch/fork (`propose_branch`) | 0 calls; `fork.ts` 70 + `BranchCard.tsx` 46 lines | **Revisit 2026-11-10** |
| Snippets | `snippets.json` never created; ~408 lines | **Revisit 2026-11-10** |
| Phone bottom bar: Schedules → Inbox/Huddles | 2 schedules ever (`PhoneNav.tsx:28`) | **Do**, S |

**Not cut (used):** huddles/Team/Learnings (21 huddles), Plans (20), question form (98 uses), schedules backend, phone access.
**Complexity warning:** `src/server/huddle.ts` is the largest file (1994 lines) and was touched in about 20 of the last 150 commits. Weigh any new huddle feature against that.

## Rejected ideas

| Idea | Reason |
|------|--------|
| Cloud runs | Vibe Kanban died on cloud/team monetisation ([shutdown](https://vibekanban.com/blog/shutdown)); local is the differentiator; Mac-on + phone PWA covers most of the need |
| Multiplayer / teams | Solo product, no evidence of need |
| Other agent CLIs as runners (Codex, opencode, Cline) | ckanban is "Kanban for Claude Code"; large surface |
| Multi-repo boards | One board = one folder is core; high complexity |
| Inter-agent messaging, forking, manager agent, snippet library | Already built in ckanban with ~0 use (see cut list) |

## Watch item

Anthropic once planned to bill `claude -p` from a separate credit ([vibe-kanban#3417](https://github.com/BloopAI/vibe-kanban/issues/3417)); the plan is currently paused. ckanban runs 100% on `claude -p`, so a revival would hit every run. #3 (cost visibility) is the hedge.
