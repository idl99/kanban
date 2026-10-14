# Script schedules, follow-up timers and heartbeats

Research and design note, 2026-10-14. No code yet: this is for the user to approve before the build tickets at the end.

## TL;DR

- **Today** every schedule fire creates a ticket and starts a full `claude -p` run (`Scheduler.fire`, `src/server/scheduler.ts`), even when there is nothing to do. A run has no way to say "check back on this ticket later".
- **Recommendation: build two small pieces and combine them, not three features.**
  1. A **check** (an optional shell command) the board runs without Claude. It wakes Claude only when it prints a `CKANBAN_WAKE` line.
  2. A **follow-up** on a ticket (one pending timer per ticket, saved on the ticket). The board wakes that ticket's own Claude later, in the same conversation.
- From those two:
  - **Script schedule** = a schedule with a check. It creates a ticket only when the check says so; otherwise the output goes to the schedule's history.
  - **Follow-up timer** = a one-shot follow-up without a check.
  - **Heartbeat** = a repeating follow-up with a check. The check runs every N minutes for free; Claude wakes only when something changed.
- **Claude decides when to follow up and when to stop. Nothing is hard-coded.** Each time it wakes, the board shows it what happened since it last looked: its earlier follow-ups, any replies, whether you've opened the card, and what the follow-ups have cost so far. Claude picks the next time, or decides not to follow up again, the way a good assistant would. The only money limit is one you set yourself (the run cap that already exists, plus an optional follow-up budget), and it's off unless you turn it on.
- **Build order:** (1) follow-ups that Claude manages itself, with the card badge, (2) checks on schedules, (3) checks on follow-ups (heartbeats), (4) routing wakes to an open ticket by key, (5) plain-words UI for checks plus spend display.

## What exists today (and what we reuse)

| Piece | Where | What it already does | Reuse for |
|---|---|---|---|
| Scheduler | `src/server/scheduler.ts` (`Scheduler.tick`, `fire`, `activeTicket`) | 30 s tick; fires due schedules; one catch-up after missed slots (`MISSED_AFTER_MS` 90 s marks it `missed`); `skipIfRunning`; JSONL history (`fired`/`skipped`/`error`/`edited`) | Script schedules: same tick, new branch in `fire` |
| Cron | `src/server/cron.ts` (`parseCron`, `nextRun`, `describeCron`) | Local-time cron, plain-English summary | Unchanged |
| Usage-limit auto-continue | `src/server/limit.ts` (`LimitWatcher`), `Board.dueContinues`, `Board.continueAfterLimit` (`src/server/board.ts`) | **This is already a persisted one-shot timer on a ticket.** It stores `limit.resetAt` on the ticket, a 30 s watcher finds due tickets, sends "continue" through `Board.chat`, and caps itself at `AUTO_CONTINUE_PER_DAY = 3` | Follow-ups copy this pattern almost line for line |
| Planner wake-ups | `Board.wake`, `wakeupCap`, `stuck` (`src/server/board.ts`, `src/server/plan.ts`) | Wakes a ticket's Claude with a full prompt (`raw`, `returnTo`), counts wakes, marks the plan stuck at `max(5, children*3)` and pings the user | Wake prompt shape, `returnTo`, the "stuck, needs you" ending |
| PR poller | `src/server/prpoller.ts` (`startPoller`, `refreshPr`) | A built-in heartbeat: polls `gh` every N min and moves cards with no Claude | Proof that cheap polling with no AI fits the daemon |
| Spending cap | `runCapFor` (`src/server/types.ts`), `Board.capReached` | Stops a run at its cap and blocks the card | Per-wake cap for follow-up runs |
| Attention | `attentionFor` (`src/server/attention.ts`) | Decides what puts a card in **Needs you** | New reason: "Follow-ups stopped" |
| MCP tools | `src/mcp-server.ts` (`create_schedule` … `schedule_history`); run identity via `RUN_HEADER` (`scheduler.ts`) | Runs can create and edit schedules, credited to their ticket | New `follow_up` / `cancel_follow_up` tools, new `check` field on schedule tools |

**Why the board must own the timers.** Claude Code's own `ScheduleWakeup` and `CronCreate` live inside one interactive Claude session. A board run is `claude -p`: the process exits when the turn ends, so any timer it set dies with it. Even if one survived, it would wake a process that no longer exists. The daemon is the only long-lived process, so timers must be saved in `~/.claude-kanban` and fired by the daemon. Board runs should never be told to use those built-in tools; the run prompt should point at `follow_up` instead.

**Real usage today.** There are 2 schedules, both on the `rocketbots` board (weekly tech review `0 9 * * 1`, daily standup `0 9 * * 2-5`), with 7 fires and 0 skips so far (from `~/.claude-kanban/profiles/rocketbots/schedules/*.history.jsonl`). Both need Claude every time, so checks would not save anything on them. The savings are for the new kinds of jobs below (hourly inbox checks, post queues, uptime), which are too expensive to build today: an hourly Claude run is 24 runs a day even when nothing happened.

---

## 1. Script schedules: a check before (or instead of) Claude

### Problem
Many recurring jobs only need Claude sometimes ("is there anything new?") or never ("back up this folder"). Today each one costs a full run and leaves a card on the board.

### Use cases
- **Nightly backup / cleanup** (`0 2 * * *`): copy a folder or prune old files. History only. Never wakes Claude.
- **Uptime check** (`*/10 * * * *`): `curl` a site. Wake Claude only when it's down, with one ticket per outage (see wake keys below).
- **Inbox poll** (WhatsApp, email, form submissions, hourly): wake only when there are new messages. Walked through below.
- **Post queue**: wake only when a draft is due. Walked through below.
- **"Only if changed" reports**: weekly report only if the data file changed since last time.
- **Dependency / advisory watch** (weekly): `bun outdated` / `npm audit --json`. Wake only when something is new.
- **Price / availability watch**: fetch a page, compare it with the last saved value, wake on change.

### Design sketch

**Data model.** One optional field on `Schedule` (`src/server/types.ts`, validated in `Scheduler.validate`):

```ts
interface ScriptCheck {
  command: string;      // run with /bin/sh -c (zsh-compatible), in the board folder
  timeoutSec?: number;  // default 60, max 600
}
interface Schedule {
  // ...existing fields
  check?: ScriptCheck | null;
}
```

- **No `check`:** today's behaviour (creates a ticket and Claude runs).
- **With a `check`:** the board runs the command first, with no Claude.
  - It prints no wake line: the run is history only. This covers "script-only" schedules: a check that never prints a wake line is a plain cron job.
  - It prints one or more wake lines: one ticket per line (at most 5 per fire), built from the schedule's title and prompt with the wake message added.

**The wake contract (exact).** One line on stdout per thing that needs Claude:

```
CKANBAN_WAKE {"message":"3 new messages from Aisha: …","key":"wa:+60123456789","title":"Reply to Aisha"}
```

- `message` (required): what the check found. It is appended to the ticket's prompt under a "What the check found" heading.
- `title` (optional): overrides the schedule's title template for this ticket.
- `key` (optional): a dedupe key. If an open ticket (not Done) from this schedule already has this key, the board **sends the message into that ticket's chat** instead of creating a new one (see §4). Saved as `Ticket.scheduleKey` next to `scheduleId` (`Store.createTicket`, `src/server/store.ts`).
- Exit code: `0` is a normal run. Non-zero means the check itself failed: it is recorded as `error` and sets `lastError`, the same as a fire that couldn't create its ticket. It does **not** wake Claude, because a broken check would otherwise burn runs. A check that should wake on failure (uptime) prints the wake line itself (`curl -fsS … || echo 'CKANBAN_WAKE {"message":"site down","key":"outage"}'`).
- Lines that aren't wake lines are just output. The last 4 KB of stdout+stderr is kept in history.

**Environment given to the check:** `CKANBAN_BOARD` (slug), `CKANBAN_SCHEDULE` (id), and `CKANBAN_STATE_DIR` = `~/.claude-kanban/profiles/<slug>/schedules/<id>.state/`. That is a private folder that survives between runs, where the check stores "last seen" ids so it only reports new things. It is created on first run and deleted with the schedule (`Store.deleteSchedule`).

**Daemon loop.** Unchanged `Scheduler.tick`; `Scheduler.fire` gets a branch:
1. `skipIfRunning` still applies to the *tickets* this schedule created. Checks also never overlap themselves: if the previous check is still running, the fire is `skipped`.
2. Run the command through a new small module `src/server/script.ts` (`runCheck(check, cwd, env) → { code, output, wakes, durationMs, timedOut }`), built with `Bun.spawn` like `run` in `src/server/git.ts`, and killed at the timeout.
3. No wakes: append `{ kind: "checked", trigger, code, durationMs, output, wakes: 0 }`.
4. Wakes: for each wake (max 5), create or route the ticket as today's path does, then append `{ kind: "checked", …, wakes: n, ticketIds: [...] }`.

**New history entry** (`ScheduleHistoryEntry`, `src/server/types.ts`):
```ts
| { at: string; kind: "checked"; trigger: ScheduleTrigger; code: number | null; durationMs: number;
    output: string; timedOut?: boolean; ticketIds?: string[]; routed?: string[] }
```
`Scheduler.history` already joins ticket states for `fired`. It would do the same for `ticketIds`.

**MCP tools** (`src/mcp-server.ts`): `create_schedule` and `update_schedule` take an optional `check: { command, timeoutSec }` (or `check: null` to remove it), and `schedule_history` prints `checked` lines (`10:00 checked · nothing new · 0.4 s`). The `create_schedule` description gains one sentence: "For jobs that only sometimes need Claude, add a check: a shell command that prints a `CKANBAN_WAKE {…}` line when Claude is needed."

### Guardrails (defaults)
- Check timeout: **60 s** (max 600 s).
- Wakes per fire: **5** tickets max. Extra wake lines are dropped and recorded in the history output.
- Tickets created per schedule per day: **20**. After that, wakes are recorded but not acted on, `lastError` says why, and the schedule shows a warning.
- **3 failed checks in a row**: the schedule pauses itself (`enabled: false`), with a history entry and a notification (`src/server/notify.ts`), so a broken script doesn't spam errors all day.
- Shortest cron for a check schedule: every 5 minutes (`*/5`). The validator refuses anything faster.

### Failure cases
- **Daemon down or laptop asleep:** same as today. One catch-up fire marked `missed`, then the schedule moves on from now. For a check that is right (an inbox check after a night asleep reports everything new once).
- **Board folder missing:** the existing `existsSync(profile.path)` error path.
- **Check hangs:** killed at the timeout and recorded as `timedOut`, which counts towards the 3-in-a-row pause.
- **Check prints malformed JSON after `CKANBAN_WAKE`:** treated as a wake with the raw text as the `message`. Missing a real event is worse than a bad format.

### Without git or technical knowledge
Checks are optional, and nobody has to write one by hand. The user says in plain words "check my shop's website every 10 minutes and tell me if it's down", and the ticket's Claude writes the check and calls `create_schedule`. In the UI the field is called **"Check first (optional)"**, explained as "A quick command the board runs first. Claude only starts when it finds something." It is not called "script". Nothing here needs git.

---

## 2. Follow-up timers: "wake me on this ticket later"

### Problem
A run often ends waiting on something: the user's answer, CI, a deploy, a third party. Today the ticket just sits there. Nothing brings Claude back unless the user does.

### Use cases
- **No reply from the user:** Claude asked a question and the run ended `questions`. "If there's no answer in 4 h, re-ask in one line, then stop."
- **No reply from a third party** (WhatsApp/email contact): "In 24 h, if they haven't answered, nudge once."
- **CI / deploy check-back:** "In 15 min check whether the deploy finished; fix it if it failed." With a check, this becomes a heartbeat (§3).
- **Long job:** "A data export takes ~1 h; in 70 min, pick up the file and finish the report."
- **Time-boxed waiting:** "Remind me to merge this on Monday morning" (absolute time).

### Design sketch

**Data model.** One pending follow-up per ticket, saved on the ticket (`Ticket`, `src/server/types.ts`), so it survives restarts like `limit` does:

```ts
interface FollowUp {
  id: string;
  dueAt: string;              // ISO
  message: string;            // note to its future self (shown to Claude when it wakes, and on the card's tooltip)
  cancelOnReply: boolean;     // chosen by Claude per call
  createdAt: string;
  every?: number | null;      // minutes; set = heartbeat (§3)
  check?: ScriptCheck | null; // set = gated by a check (§3)
  until?: string | null;      // heartbeat end time
}
interface FollowUpLogEntry {   // what Claude did and why; shown to it on every later wake
  at: string;
  kind: "set" | "woke" | "cancelled" | "replied";
  message?: string;             // the note / why it chose this time
  costUsd?: number;             // cost of the wake run (from ticket-usage.ts)
}
interface Ticket {
  // ...existing fields
  followUp?: FollowUp | null;
  followUpLog?: FollowUpLogEntry[];   // last 50 kept
  userSeenAt?: string | null;         // last time the user opened this card (new: the board doesn't track this today)
  followUpBudgetUsd?: number | null;  // optional, set by the user; unset = no limit
}
```

Setting a new follow-up replaces the pending one. One is enough and is easy to show on a card.

**MCP tools** (`src/mcp-server.ts`, calling a new route `POST/DELETE /api/profiles/:slug/tickets/:id/follow-up` in `src/server/http.ts`). They work on the **caller's own ticket only**, identified by `RUN_HEADER` like schedule edits:

```
follow_up({ after?: "10m" | "4h" | "2d", at?: ISO-or-"2026-10-20 09:00",
            message: string,             // why, and what to do then: "No reply to the quote yet; nudge once if still silent"
            cancelOnReply?: boolean = true,
            every?: "30m", check?: { command, timeoutSec }, until?: ... })
  → "Follow-up set: wakes at 14:40 (in 4 h). Cancels if the user replies."
cancel_follow_up() → "Follow-up cancelled."
```

The board does not change the time Claude picks. The `message` is Claude's reasoning for its future self, shown on the card so the user can see why it will come back.

**Daemon loop.** A new `FollowUpWatcher` in `src/server/followup.ts`, copied from `LimitWatcher` (30 s interval, `busy` flag), started in `src/server/main.ts` next to `LimitWatcher`. It calls a new `Board.dueFollowUps(slug)` (like `Board.dueContinues`), and for each due ticket:
1. Skip it for now if the ticket is running or queued. The next tick tries again; it doesn't stack a message onto a live run.
2. Only if the user set a follow-up budget and it's used up: don't wake. Clear the follow-up, add a comment, and the card goes to **Needs you · Follow-up budget used**.
3. Wake through `Board.chat(slug, id, text, { followUp: true })`, a new `ChatOptions` flag next to `hostWake` (`src/server/board.ts:135`). Like a planner wake, the card goes back to its column afterwards (`returnTo`), and `limit` is not cleared. The wake text, built in `src/server/prompts.ts`:
   > ⏰ You set this follow-up on 14 Oct 10:40: "No reply to the quote yet; nudge once if still silent."
   > Since then: no reply from the user; they haven't opened this card since 13 Oct 18:02; 2 messages you sent are still unanswered.
   > Your follow-ups on this ticket so far: 3 (10:40 Mon, 09:00 Tue, 09:00 Wed), $0.21 in total.
   > Decide what makes sense now. If following up again is useful, call `follow_up` with the time you judge right and say why. If it isn't (nobody is reading, or you've already nudged enough), don't: end with a one-line note on the card saying you stopped and why.
4. Log the wake in `followUpLog` with its cost, and clear `followUp` (one-shot), or move `dueAt` on (heartbeat, §3).

**How Claude decides (prompt, not code).** The rules live in the wake prompt and in a short paragraph in the run prompt (`src/server/prompts.ts`), next to `PLAIN_WORDS`, not in the daemon:
- Pick the delay like a person would: minutes for a deploy, hours for a colleague, a day or more for a customer. Space follow-ups further apart when nobody answers.
- Look at the signals before following up again: several unanswered messages, or a user who hasn't opened the card for days, usually means stop and leave a note rather than keep nudging.
- Never follow up just to check whether there's anything to do. Use a check (§3) for that, because checks are free.
- When it stops, say so on the card in one line ("Stopped following up: 3 nudges, no reply since Monday").

These are judgment instructions, so they can be improved without code changes.

**Cancel on reply.** In `Board.chat`, a message from the user clears a pending follow-up with `cancelOnReply: true` and logs `replied`. That means a message that is not `peer`, `hostWake`, `fromPlanner` or `followUp`. A routed check wake (§4) counts as a reply too: the third party answered. Moving the card to **Done** or **Backlog**, or deleting it, always cancels (handled in `Board.updateTicket`).

**History.** Each set, wake, cancel and stop goes into `followUpLog` (which Claude sees on its next wake) and as a short `ai` comment ("Follow-up set for 14:40", "Woke for follow-up", "Follow-up cancelled: you replied"). No new history store is needed.

**UI** (described here; no mockup asked for): a small badge on the card, **"⏰ in 8 min"**, next to where `LimitActions` sits in `web/src/Card.tsx`, with the `message` as the tooltip. Clicking it opens a menu with **Wake now**, **Cancel**, the follow-up history ("3 follow-ups · $0.21") and an optional **Follow-up budget** field. Opening the card sets `userSeenAt` (a new `POST …/seen` call from the card's detail view), which is how Claude can tell "the user isn't looking at this".

### Limits: Claude's judgment first, your budget as the only hard stop

The first draft had fixed counts (3 a day, 8 in a row, delays that double). The user asked for a proactive agent instead, so those are gone. What keeps an unreachable contact from burning credit:

| What | How | Who decides |
|---|---|---|
| When to come back, and whether to come back at all | Claude, from the facts in the wake prompt (earlier follow-ups, replies, `userSeenAt`, cost so far) | Claude |
| Cost of one wake | the run cap you may already have (`runCapFor`, `src/server/types.ts`); no new default | You (existing setting) |
| Total follow-up spend on a ticket | optional `followUpBudgetUsd`; unset means no limit | You (optional) |
| Done / Backlog / deleted card | any pending follow-up is cancelled | Board (that's just what those columns mean) |
| A follow-up less than 1 minute away | refused as a probable mistake (the board ticks every 30 s anyway) | Board (technical floor only) |

**Why this is enough in practice:** a nudge run costs a few cents (estimate; real numbers per run are in `src/server/ticket-usage.ts`). Claude sees the running total on every wake, so a runaway loop would have to ignore numbers in front of it. And because every follow-up and its cost show on the card, any odd pattern is easy to spot.

**Something to watch after release:** if logs show Claude following up too eagerly, fix the wake prompt first. A board-wide budget setting can be added later if prompts alone don't hold.

### Failure cases
- **Daemon restart:** the follow-up is saved on the ticket, so it survives (open question answered: **yes, persist**).
- **Daemon down / laptop asleep past `dueAt`:** fire once when it comes back if it is ≤ **12 h** late. The wake text says "this follow-up is 7 h late". If it is more than 12 h late, don't wake Claude: post a comment and show **Needs you · Missed follow-up**, because the situation may have moved on.
- **Restart pending** (`restartPending` in `Board.chat`): the message is queued like any other, and `recover()` delivers it.
- **Usage limit hit during the wake:** the existing limit path takes over.
- **Ticket running when due:** wait for it to end (step 1 above). If the run itself calls `follow_up`, the new one replaces the old one.

### Without git or technical knowledge
Nothing here touches git. Plain words on the card: "Claude will check back at 14:40", "Stop checking back".

---

## 3. Heartbeats / watchers: a check that wakes a ticket on change

### Problem
"Keep an eye on X and act when it changes" is either a full Claude run every few minutes (expensive) or the user remembering to come back.

### Is a heartbeat just a script schedule bound to a ticket, or a one-shot follow-up repeated?
**It is a follow-up with `every` and a `check`.** That's the smallest model:
- Schedules *create* tickets; heartbeats *wake an existing* ticket. Making a schedule point at a ticket would mix two lifecycles (a schedule outlives its tickets, a heartbeat lives and dies with its ticket).
- A follow-up already has everything a heartbeat needs: it belongs to the ticket, is saved on it, has a log Claude reads, a badge and cancel-on-reply. Adding `every` + `check` makes it repeat cheaply.
- Both share the same `runCheck` (`src/server/script.ts`) and the same `CKANBAN_WAKE` contract.

So the full set is: **check** (runner + contract) × **where it lives** (schedule creates tickets / follow-up wakes one).

| | No check | With check |
|---|---|---|
| **Schedule** (creates tickets) | today's schedule | script schedule (§1) |
| **Follow-up** (wakes this ticket) | follow-up timer (§2) | heartbeat (§3) |

### Use cases
- **CI / deploy watch:** `every: "2m"` is too fast, so the minimum of 5 min applies. Check: `gh run view <id> --json status -q .status | grep -q completed && echo 'CKANBAN_WAKE {"message":"CI finished"}'`. Without `gh` or git, Claude writes a check that curls the deploy's status URL instead.
- **Reply watch for a third party:** check the contact's chat every 15 min; wake when they've answered. `until` = 2 days, then fall back to a one-shot "nudge once" follow-up.
- **Waiting for a file:** a long export that drops `report.csv`: `test -f exports/report.csv && echo 'CKANBAN_WAKE {"message":"export ready"}'`.
- **PR merge watch:** already covered by `prpoller.ts`. Not needed.
- **A whole-board heartbeat** (one Claude that scans the board periodically): **not recommended.** It's expensive, and the Inbox / attention system (`src/server/attention.ts`) already shows what needs the user.

### Design sketch
Same `FollowUp` record with `every` (minutes) and `check`. In `FollowUpWatcher`, when due:
1. Run the check (no Claude; it doesn't count as a wake). No wake line: `dueAt += every`, nothing else happens (no comment, so checks don't fill the card's activity). Keep a running "last checked 14:30 · nothing new" on the badge tooltip.
2. A wake line: wake Claude exactly as in §2 with the check's `message` included. The heartbeat **stays** (with `dueAt += every`) unless Claude calls `cancel_follow_up`, or `until` has passed.
3. Past `until`: clear it, with a comment "Stopped watching: time limit reached".

Claude picks `every` and `until` itself, and can change or cancel them on any wake. Checks don't wake Claude, so they cost nothing however often they run. The board keeps two technical rules: checks never overlap (a check still running when the next one is due is skipped), and after **3 failed checks in a row** the heartbeat pauses and Claude is woken once to fix or drop it. Neither is a spending rule.

### Failure cases
Same as §2. A heartbeat that was asleep runs its check once on wake-up, with no flood of missed runs.

---

## 4. Routing wakes to an open ticket (wake keys)

Needed for the inbox case. Without it, every hourly check with new messages from the same person would create a new ticket.

- A `CKANBAN_WAKE` with a `key` from a **schedule check**: the board looks for a ticket with `scheduleId === schedule.id && scheduleKey === key && status !== "done"`.
  - **Found:** `Board.chat` sends the message into it (the conversation continues). That counts as a reply for `cancelOnReply` and is logged as `replied`. History records it as `routed`.
  - **Not found:** a new ticket is created with `scheduleKey: key`.
- Routing is **not** limited by `skipIfRunning`: a running ticket gets the message queued (the existing `queued` path).

---

## 5. The user's use cases, end to end

### A. WhatsApp inbox (hourly check; one ticket per conversation; follow-up when nobody answers)

**How a check can see new WhatsApp messages without Claude**, from most to least realistic for a personal Mac:

| Option | Cost per check | Reliability | Risk | Verdict |
|---|---|---|---|---|
| Read the WhatsApp **desktop app's local database** (macOS keeps chats in an SQLite file under `~/Library/Group Containers/…WhatsApp…/ChatStorage.sqlite`), read-only, `sqlite3` query for messages newer than the last seen id | ~0 (milliseconds) | Good while the desktop app is installed and synced. The schema is undocumented and may change with app updates | Low (read-only, no automation flagged by WhatsApp) | **Recommended for detection.** On the user's Mac the containers `group.net.whatsapp.WhatsApp.shared` and `group.net.whatsapp.WhatsAppSMB.shared` exist (checked 2026-10-14). The DB file name and schema were not opened here, so verify them first |
| Headless browser (Playwright) with a saved WhatsApp Web login, scraping unread chats | Seconds; needs Node + Playwright | Fragile (DOM changes, QR re-login) | Medium: WhatsApp can flag automation | Fallback |
| Unofficial libraries (`whatsapp-web.js`, Baileys) | Low | Fair | **High: against WhatsApp terms; accounts get banned** | Not recommended |
| WhatsApp Business Cloud API (webhooks) | Free tier | High | None | Only for a business number. Needs Meta setup; a separate ticket if wanted |
| Claude-in-Chrome every hour | A full Claude run every hour | Good | Low | Defeats the point (that's the cost we're avoiding). Use it only for **sending** |

**Flow:**
1. **Schedule** "WhatsApp inbox", cron `0 * * * *`, mode `auto`. The check is `wa-check.sh`: it queries the desktop DB for messages newer than the id saved in `$CKANBAN_STATE_DIR/last-id` and prints one wake line per chat with new messages:
   `CKANBAN_WAKE {"key":"wa:+60123456789","title":"Reply to Aisha","message":"3 new messages (10:02–10:41): …"}`
   An hour with no new messages ends as history only: `10:00 checked · nothing new`. **$0.**
2. **New conversation:** a ticket "Reply to Aisha" is created with the messages. Claude drafts a reply. For the first weeks it ends `questions` with the draft so the user approves it. Once trusted, it sends via Claude-in-Chrome (WhatsApp Web), which is realistic because that run is Claude anyway.
3. Claude then calls `follow_up({ after: "24h", cancelOnReply: true, message: "If Aisha hasn't answered, send one short nudge, then stop following up." })`. The card shows **⏰ in 24 h**.
4. **Aisha answers at 15:20:** the 16:00 check routes her messages into the *same* ticket (key match, §4). That counts as a reply, so the follow-up is cancelled and Claude continues the conversation in context.
5. **Aisha never answers:** on day 2 Claude wakes, sees one unanswered message and nudges once, setting a follow-up for 3 days later "in case she replies late". On day 5 it sees two unanswered messages, decides a third nudge would be pushy, doesn't set another follow-up, and notes "Stopped: 2 nudges, no reply" on the card. That was its call, not a fixed rule.
6. **Done:** the user (or Claude after the conversation ends) moves the card to Done. The next message from Aisha opens a fresh ticket.

**Cost:** 24 free checks a day, plus one Claude run per conversation turn. Today's equivalent would be 24 Claude runs a day.

### B. Post queue (drafts saved, posted at scheduled times)

**Where the queue lives:** a folder in the board, visible in the board's Files view and editable by non-technical users through the ticket chat ("save this as a post for Friday 10am"):

```
posts/
  queue/   2026-10-17-1000-new-kitchen.md   ← optional "publish: 2026-10-17 10:00" line at the top
  posting/ (in flight)
  posted/  2026-10-10-1000-launch.md       ← Claude appends "Posted 2026-10-10 10:01 · <link>"
  failed/
```

Folders rather than ticket attachments: they survive tickets being deleted, need no new board feature, and "pick one" is just "the first file in name order".

**Two ways to schedule, both just a schedule with a check:**
- **Fixed slots** (e.g. Mon/Wed/Fri 10:00): cron `0 10 * * 1,3,5`. The check prints a wake for the **first** file in `posts/queue/` whose `publish:` time (if any) has passed.
- **Each post has its own time:** cron `*/15 * * * *`. Same check, and most runs find nothing due, so they cost nothing.

**Flow:**
1. The check finds `queue/2026-10-17-1000-new-kitchen.md` due and prints `CKANBAN_WAKE {"key":"post","title":"Post: new kitchen","message":"Post posts/queue/2026-10-17-1000-new-kitchen.md"}`.
2. The ticket's Claude first **moves the file to `posting/`** (so a crash or a repeat fire can't pick it again), posts it (platform API or Claude-in-Chrome), then moves it to `posted/` and appends the date and link. If posting fails, the file goes to `failed/` with the reason and the run ends `blocked`.
3. **No repeats:** the file's folder is the state, and `skipIfRunning` plus the `"post"` key mean only one posting ticket is open at a time.
4. **Empty queue:** the check prints nothing (history: "queue empty"). After **3 empty fires in a row** the check prints a wake with `{"key":"queue-empty","message":"Post queue is empty"}`. That ticket ends `questions` ("The queue is empty — want me to draft 3 posts?"), and the key makes sure the user is asked only once.

---

## 6. Open questions (answered)

1. **Where do checks run, and with what timeout?** In the **board folder** (`profile.path`), not a worktree. Checks read the user's things (inbox DB, queue folder), and worktrees are per ticket. Persistent state goes in `CKANBAN_STATE_DIR` under `~/.claude-kanban`, so nothing clutters the user's folder. Timeout **60 s** default, **600 s** max. Output is kept up to 4 KB.
2. **Should follow-ups survive a daemon restart?** **Yes.** They are saved on the ticket JSON like `limit`, and late ones are handled as in §2's failure cases (≤ 12 h late fires once; later than that needs the user).
3. **Show per-ticket wake spend next to the badge?** **Not on the badge itself** (keep it "⏰ in 8 min"), but **yes in its menu**: "3 follow-ups · $0.42 so far". The numbers come from `src/server/ticket-usage.ts` filtered to follow-up runs. That is where the user decides whether to cancel, so the cost belongs there.

## 7. Options judged

| Option | Value | Cost to build | Run cost | Risk |
|---|---|---|---|---|
| **Follow-ups (one-shot)** | High: every waiting ticket can come back by itself | Low (copy `LimitWatcher`) | Claude's judgment, shown on the card; optional budget | Low |
| **Checks on schedules** | High for inbox/queue/uptime; none for today's 2 schedules | Medium (runner, contract, history) | Lowers it | Medium: arbitrary shell commands, so only the user or their Claude can set them, and they run as the user (same trust as the board's setup command) |
| **Heartbeats** | Medium (CI, reply watch) | Low once the two above exist | Low (free checks) | Low |
| **Wake keys** | Needed for the inbox; useful for outages | Low | — | Low |
| Whole-board heartbeat | Low (the Inbox already does it) | Medium | High | — Not recommended |

## 8. Build order (follow-up tickets)

1. **Follow-ups that Claude manages itself, with card badge.** Add `Ticket.followUp`/`followUpLog`/`userSeenAt`/`followUpBudgetUsd`, `FollowUpWatcher` (`src/server/followup.ts`, modeled on `LimitWatcher`), `Board.dueFollowUps`, the `followUp` chat flag, `follow_up`/`cancel_follow_up` MCP tools and HTTP route. Include cancel-on-reply, the wake prompt with the facts Claude needs (earlier follow-ups, replies, last seen, cost so far) and the judgment rules in `prompts.ts`, the optional budget with tests, the card badge (**⏰ in 8 min**, Wake now / Cancel / history), and a run-prompt line telling runs to use `follow_up` (not Claude Code's own timers).
2. **Checks on schedules (script schedules).** Add `src/server/script.ts` (`runCheck`, `CKANBAN_WAKE` parsing), `Schedule.check`, the `checked` history entry, `CKANBAN_STATE_DIR`, the §1 guardrails (5 wakes/fire, 20 tickets/day, pause after 3 failures, `*/5` minimum), and `check` on the schedule MCP tools and the history view in `SchedulesDialog.tsx`.
3. **Heartbeats: checks and repeats on follow-ups.** Add `every`/`check`/`until` to `FollowUp`, the check-then-wake loop in `FollowUpWatcher`, the "last checked" tooltip, the 7-day default end and the failure stop.
4. **Wake keys: route check wakes to the open ticket.** Add `Ticket.scheduleKey`, routing in `Scheduler.fire`, routed messages counting as replies for follow-ups, and `routed` in history. Then write the WhatsApp check (desktop DB, read-only) as an example after verifying the DB path and schema on the user's Mac.
5. **Plain-words UI for checks, plus follow-up spend.** A "Check first (optional)" field in `SchedulesDialog.tsx` with a "let Claude write it" helper, and per-ticket wake spend in the badge menu (§6.3).

Tickets 1 and 2 are independent and could run in parallel. 3 needs both; 4 needs 2. Each changes server code that users see, so each should get an `auto-review` huddle.
