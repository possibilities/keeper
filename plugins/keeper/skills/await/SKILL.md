---
name: await
description: >-
  Block until a condition holds, then run a follow-up action. Conditions: a
  keeper plan board state (epic/task complete or unblocked), git cleanliness of
  the current repo, other agents finishing, an own-session background task
  (dev server / build / script) completing, daemon readiness, or any
  AND-combination. Use for any wait-then-act intent — e.g. "review when
  fn-N is done", "ping me when the repo's clean", "do X after the other
  agents finish" — even when the user never says "keeper", "await", "epic",
  or "task".
allowed-tools: Monitor Bash
---

# await

Turn a "wait until <thing> happens, then do <follow-up>" request into a
`Monitor(keeper await …)` invocation plus the follow-up action. The
condition can be a keeper plan board state, the cleanliness of the current
git repo, other agents going idle, or an AND-combination of these.

## When this fires

The user's ask glues two shapes together:

1. **A wait condition** — words like *wait*, *block*, *hold off*, *when …
   is done*, *after … finishes*, *once … is ready*, *as soon as …*, over a
   keeper plan id, a git state, other agents, an own-session monitor, or a
   combination (the *Parse* table below enumerates every form).
2. **A follow-up** to run when the condition holds — *then review it*,
   *then run the tests*, *and ping me*, *and commit*, etc.

The user does NOT need to say "keeper" / "epic" / "task" / "await". A
bare *"do a full review once fn-643-…-hook.4 is complete"* or *"commit
once the project's clean and the others are done"* fires this skill.

## Parse the request

Extract the condition(s) and the follow-up. Each condition becomes one
segment in the `keeper await` invocation; multiple segments are joined by
the literal `and` token.

| Condition | How to derive | `keeper await` form |
|---|---|---|
| `complete <id>` | Default for a keeper plan id. "done" / "finished" / "complete" all map here. `<id>` is `fn-N-slug` (epic) or `fn-N-slug.M` (task). Fires on the readiness `completed` verdict — **done AND idle** (every owning subagent has gone idle), the moment autopilot actually unblocks downstream work. See the done-AND-idle note below. | `complete fn-…` |
| `landed <epic>` | A keeper plan EPIC where the user needs its work MERGED to the default branch — "once fn-X's lane lands / is merged", or the planning premise "author B against A's merged files". **Epic only** (a task id is a usage error). Fires when the epic's lane is merged to default; a never-started epic's absent lane never reads as merged (the started gate keeps `landed` waiting until work has actually begun). **Prefer over `complete` for a planning daisy-chain** — for why `landed` and `complete` diverge (worktree finalize timing, multi-repo groups, and the worktree-off degrade to `complete` semantics): <!-- POINTER: keeper prompt render engineering/landed-vs-complete --> | `landed fn-…` |
| `started <id>` | A keeper plan id where the user asks about work BEGINNING ("once it starts", "as soon as someone picks it up", "when work has begun on it"). Monotonic milestone — fires once work has begun at least once and never un-fires. | `started fn-…` |
| `unblocked <id>` | A keeper plan id where the user explicitly asks about readiness ("once it's unblocked", "as soon as it's ready to be worked on", "when the deps clear"). A `runtime-blocked` task the daemon has escalated to the planner reports `waiting` (escalation in flight), not `stuck`, while the autopilot is paused — see the escalated-but-paused note under *Defaults and overrides*. | `unblocked fn-…` |
| `git-clean` | Any "wait for the repo / project to be clean / committed / have no uncommitted changes" phrasing. **No id.** Project-scoped to the cwd's git root. | `git-clean` |
| `agents-idle` | Any "wait for the other agents / everyone else to finish / be done / stop editing" phrasing. **No id.** Project-scoped to the cwd's git root; excludes THIS session. | `agents-idle` |
| `server-up` | Any "wait until keeper / keeperd / the daemon is up / back / serving / reachable" phrasing. **No id.** Fires `met` on the first snapshot — i.e. the moment the READ socket opens, right after `migrate()` while the reducer may still be CATCHING UP. So `server-up` means "the control plane is reachable", NOT "the board has fully caught up"; an early board read may be provisional (its frames carry a `catching_up` boot-status header until the drain reaches head + the git surface is seeded). Reconnects FOREVER (permanently give-up-exempt), so it blocks through a daemon bounce — the escape hatch for a slow cold boot. **CANNOT be ANDed** with another condition, and **CANNOT be combined with `--connect-timeout`** (both parse-time usage errors). | `server-up` |
| `monitor-running <selector>` | Any "wait until my dev server / script / background task / build watcher finishes" phrasing. Scoped to THIS session's own monitors. **Takes one selector token:** `cmd:<full command>`, `kind:<monitor\|bash-bg\|ambient>`, or a bare token (= `cmd:<token>`). Exact match, never substring. | `monitor-running cmd:bun run dev` |
| `drained` | Any "wait until the whole board is done / at rest / there's nothing left to run" phrasing. **No id.** Holds until no in-flight launch, no running job, every row completed, and not catching up. Distinguishes a JAM (a sticky `dispatch_failures` row) from true drain — add `--fail-on-stuck` to exit 5 on an operator jam instead of waiting. | `drained` |
| `epic-added [id]` | "ping me when a new epic shows up" (bare) or "when fn-X appears on the board" (a specific id). **Edge-triggered:** never satisfied on first paint, so it always waits for a real appearance. | `epic-added` / `epic-added fn-…` |
| `epic-removed <id>` | "when fn-X leaves the board / is done or deleted." **One id, edge-triggered.** | `epic-removed fn-…` |
| `changed [since:R]` | "ping me when anything on the board moves" — an epic appears/leaves, a verdict flips, or autopilot config changes. **Edge-triggered;** optional `since:<hash>` anchors against a prior `changed` baseline so you can detect movement since a known point. | `changed` / `changed since:<hash>` |
| `<needs-human> [since:S]` | "ping me when there's a dead letter / block escalation / parked question / stuck dispatch / finalize non-ff jam / instant-death wall" (one signal), or "ping me on any needs-human signal" (the umbrella). **No id.** Six per-signal tokens — `dead-letter`, `block-escalation`, `parked-question`, `stuck-dispatch`, `finalize-non-ff`, `instant-death-wall` — plus the umbrella `needs-human` (any of them). **Level-triggered presence:** `stuck-dispatch`/`finalize-non-ff`/`instant-death-wall` and the umbrella fire on the operator-jam class only — a self-clearing occupancy sticky never trips them. Optional `since:<signature>` anti-spin anchor: a still-present, already-triaged signal whose signature matches the anchor HOLDS, a genuinely new signal (signature moved) FIRES. | `needs-human` / `dead-letter` / `stuck-dispatch since:<sig>` |

| Field | How to derive | Example |
|---|---|---|
| `follow-up` | The clause after "then" / "and" / "and then" — what to run when the condition(s) hold. | "do a full review" |

**The `and` grammar.** When the user names more than one condition,
join them with the literal `and` token:
`keeper await git-clean and agents-idle`,
`keeper await complete fn-643-…-hook.4 and git-clean`. The process
opens only the subscriptions its conditions need and emits the terminal
`met` only when ALL conditions hold simultaneously (level-triggered,
glitch-free).

If the user gives multiple keeper plan ids and it's ambiguous which to wait
on (e.g. "wait for one of these"), ask. An explicit AND of distinct
conditions ("wait for fn-X and the repo to be clean") is a single
invocation, not an ambiguity.

## Orient / discover the board

<!-- POINTER: keeper prompt render engineering/orient -->

When the user's reference is to "the board" rather than a known id — "ping me
when a new epic shows up", "when anything moves", "when it's all done" — orient
first with one read: `keeper status --json` prints autopilot config, per-row
readiness verdicts, counts, `drained`/`jammed`, in-flight, and needs-human in a
single envelope (exit 0 on any board state). Use it to discover which epics
exist, whether the board is already drained, and which condition fits. For the
full orient step run `keeper prompt render engineering/orient`.

## Step 1 — Pre-check plan targets are on-board (plan conditions only)

This pre-check applies **only to `complete` / `started` / `unblocked`** (and
optionally `epic-removed` / `landed`, whose epic id you can verify exists
today). The other conditions — `git-clean`, `agents-idle`, `server-up`,
`monitor-running`, `drained`, `epic-added`, `changed`, and the six per-signal
needs-human tokens plus the umbrella `needs-human` — have **no pre-check**
(they read live projections, or deliberately wait for something not present
yet); skip straight to step 2.

**`monitor-running` self-refuses at arm time.** If the selector matches no
running monitor in this session, `keeper await` emits `failed reason=no-match`
exit 1 instead of an instant `met` (the premature-unblock guard). The
own-session monitor list is snapshotted on each **Stop**, so arm
`monitor-running` in a turn **after** a Stop has captured the monitor — NOT the
same turn you launch it (that race trips the refusal). Confirm it in a bare
`keeper jobs` snapshot first (a one-shot read in an agent — never append
`--watch`, it hangs), then wire the await.

For each plan segment, verify the id exists and is awaitable off the LIVE board —
never a `keeper plan show` file read. A **task** id resolves in `keeper query
tasks --json` (one row per open-epic task, carrying `runtime_status` + the
readiness verdict); an **epic** id resolves in `keeper status --json` under
`data.board.epics[]` (carrying the epic `status`). Both are one-shot envelope
reads that never touch plan file state.

Refuse to wire Monitor in any of these cases — the event will never fire:

- **Off-board** — the id appears in neither read (it never existed, or already
  completed and closed off the board). Tell the user it isn't on the board; if
  they expected it done, offer to run the follow-up now.
- **Already complete** (for `condition=complete`): the task row's `runtime_status
  == "done"`, or the epic's `status == "done"`. The target has already popped off
  the board — nothing to await; offer to run the follow-up now.
- **Already started** (for `condition=started`): the task row's `runtime_status`
  is `in_progress`/`done` (epic: any task satisfies that). There's nothing to
  await — tell the user and offer to run the follow-up now. `keeper await started
  <id>` against an already-started target fires `met` immediately (no
  refuse-upfront), so wiring it is harmless, but the follow-up runs right away
  rather than on a real edge.

If the target is on-board and the condition isn't already met, continue to step
2. (For `condition=unblocked` skip the already-unblocked check — `keeper await
unblocked` with an already-workable target fires `met` immediately, which is
correct.)

> **`complete` is done-AND-idle.** The live wait can HOLD a beat past plan-done
> while a stale subagent settles, even though the pre-check's `runtime_status ==
> "done"` already reads as "popped off the board."

> **`started --require-transition` warns.** `started` is a monotonic latch with
> NO second edge; pairing it with `--require-transition` against an
> already-started target hangs the wait until timeout. Only add it when the
> target is verifiably not-yet-started at arm time.

## Step 2 — Wire the Monitor

```
Monitor({
  command: "keeper await <condition> [<id>] [and <condition> [<id>]]...",
  description: "wait for <conditions> then <follow-up>",
  persistent: true,
})
```

The `command` field is `keeper await` plus the condition form(s) from the
*Parse* table, AND-joined for a combination.

Defaults and overrides:

- **`persistent: true` is the default.** Completion, a clean repo, or
  every other agent going idle can take hours; an open-ended "whenever it
  finishes" wait must outlive individual model turns. Only drop
  `persistent` when the user gave a hard wall-clock bound.
- **For a bounded wait** ("within the hour", "give it 30 minutes"), use
  `timeout_ms` on the Monitor invocation — NOT `keeper await --timeout`. Let
  Monitor own the deadline as the single source of truth. On timeout Monitor
  SIGTERMs the process and `keeper await` emits `[keeper-await] failed
  reason=timeout` exit 3 through the same flush path.
- **Stuck verdicts** (job-rejected, dep-on-epic-dangling) keep waiting
  by default. Add `--fail-on-stuck` only if the user explicitly wants
  the wait to surrender on those.
- **Escalated-but-paused holds, never surrenders.** A `runtime-blocked`
  task the daemon has escalated to its epic's planner (a
  `block_escalations` latch is armed) reports `waiting` — *escalation in
  flight* — rather than `stuck` **while the autopilot is paused**, since
  the cold re-dispatch that resumes it can't fire until play resumes. So
  even a `--fail-on-stuck` wait visibly HOLDS for the planner instead of
  exiting 5 on a stall that will clear. Once the autopilot is un-paused (or
  the latch clears on unblock) the normal verdict resumes.

## Step 3 — Listen for the terminal line

Monitor streams `keeper await`'s stdout to you, line by line. The
`armed` line names the condition(s); its field shape depends on whether
the wait is a single plan id, a single git/jobs condition, or an AND
aggregate:

```
# single plan condition
[keeper-await] armed target=<id> kind=<epic|task> condition=<…> state=<…>
[keeper-await] met target=<id> kind=<…> condition=<…> detail=<…> [followup=<id>[,<id>…]]

# single git / jobs condition
[keeper-await] armed condition=<git-clean|agents-idle|server-up> state=<…>
[keeper-await] met condition=<git-clean|agents-idle|server-up> detail=<…>

# single monitor-running condition (carries the selector)
[keeper-await] armed condition=monitor-running selector=<…> state=<…>
[keeper-await] met condition=monitor-running selector=<…> detail=<…>

# single board condition (drained / changed / epic-added / epic-removed / landed;
# target=<id> rides only the id-bearing forms)
[keeper-await] armed condition=<drained|changed|epic-added|epic-removed|landed> [target=<id>] state=<…>
[keeper-await] met condition=<…> [target=<id>] detail=<…>

# single needs-human condition (the six per-signal tokens — dead-letter,
# block-escalation, parked-question, stuck-dispatch, finalize-non-ff,
# instant-death-wall — plus the umbrella needs-human; carries the current
# signature, the since:<signature> re-arm anchor)
[keeper-await] armed condition=<needs-human|dead-letter|block-escalation|parked-question|stuck-dispatch|finalize-non-ff|instant-death-wall> state=<…> [signature=<…>]
[keeper-await] met condition=<…> detail=<…> [signature=<…>]

# AND aggregate (two or more conditions)
[keeper-await] armed conditions=<c1 and c2 …> count=<N>
[keeper-await] met conditions=<c1 and c2 …> count=<N>
```

…or a terminal `failed` instead of `met`:

```
[keeper-await] failed target=<id> reason=<reason> …
[keeper-await] failed reason=<reason> conditions=<…> …   # aggregate
```

For an AND aggregate, a plan sub-condition that fails names which
condition fired via a `from=<condition-label>` field on the `failed`
line.

**`followup=<id>`** appears ONLY on a single `complete <epic>` met, and only
when the closer that finished this epic minted follow-up epic(s) for it
(comma-joined in board order, no spaces). It is omitted entirely when there
are none — the no-child met line is byte-identical to before — and under
`--json` it is a `"followup": [<id>, …]` array, omitted when empty. It never
rides an `unblocked`/`started`/task/aggregate met or any `failed` line. See
Step 4 for the listener branch.

Reasons + exit codes:

| Line | Exit | Meaning | Your action |
|---|---|---|---|
| `met …` | 0 | All conditions hold. | Run the follow-up. |
| `failed reason=not-found …` | 1 | Planctl id absent at startup (pre-check missed it). | Tell the user, do NOT run the follow-up. |
| `failed reason=no-git-root …` | 1 | A `git-clean` / `agents-idle` condition was requested but the cwd isn't inside a git worktree. | Tell the user; the wait can't be evaluated. Do NOT run the follow-up. |
| `failed reason=no-match …` | 1 | A `monitor-running` selector matched no running monitor in this session at arm time (likely armed the same turn the monitor launched, or the selector is wrong). | Tell the user nothing matched; suggest re-arming after the monitor shows in `keeper jobs`, or fixing the selector. Do NOT run the follow-up. |
| `failed reason=connect …` | 1 | A terminal query-SHAPE error keeperd rejected — a malformed/unrecoverable query (e.g. `bad_frame` / `unknown_collection`). NOT a capacity condition: a `max_connections` cap reject is transient and rides the reconnect loop (it never surfaces here). | Tell the user the query was rejected; the wait can't proceed. |
| `failed reason=unreachable …` | 1 | **Only with `--connect-timeout`.** keeperd stayed unreachable past that opt-in deadline (down / mid-bounce / half-up — never painted a first snapshot). Distinct from `connect`. Carries `advice=`. A plain await (no flag) NEVER emits this — it reconnects forever. | Tell the user the daemon is down. To block THROUGH the bounce, drop `--connect-timeout` (a plain await waits forever), or `keeper await server-up` first then re-arm once it's back. Do NOT run the follow-up. |
| `failed reason=deleted …` | 4 | Planctl target was on board, vanished, re-query miss. | Tell the user the target was deleted; do NOT run the follow-up. |
| `failed reason=timeout …` | 3 | Monitor wall-clock deadline hit. | Tell the user it timed out; ask whether to extend or move on. |
| `failed reason=stuck …` | 5 | Under `--fail-on-stuck` only. | Tell the user the target is stuck; surface the verdict. |

The `armed` line is information only — proceed past it. The first
`met` / `failed` line is terminal; act on it.

**Already-satisfied-at-arm fires immediately.** If every condition
already holds at arm time (a clean repo, no other agents, a complete
target), `keeper await` emits `armed` and then `met` in quick
succession. That's correct behavior — run the follow-up.

## Step 4 — Run the follow-up

On `met`, run the follow-up clause the user gave. If the follow-up is
itself a Claude Code task ("do a full review", "implement the next
task", "commit"), invoke whatever tools are appropriate for it. If it's a
shell command, run it via Bash.

On any `failed`, surface the terminal line to the user verbatim and ask
how they want to proceed — do NOT silently run the follow-up.

## Examples

### Wait then review (plan)

> User: "Do a full review when fn-643-keeper-hook-dead-letters.4 is
> complete."

1. `keeper query tasks --json` → the `fn-643-keeper-hook-dead-letters.4` row
   exists, `runtime_status != "done"`. Proceed.
2. `Monitor({ command: "keeper await complete
   fn-643-keeper-hook-dead-letters.4", description: "wait for fn-643.4
   complete then review", persistent: true })`.
3. On `[keeper-await] met …` → start the review.

### Wait until the repo is clean (git-clean)

> User: "Once everything's committed, push it."

1. No pre-check — `git-clean` has no off-board state. Skip step 1.
2. `Monitor({ command: "keeper await git-clean", description: "wait for
   clean repo then push", persistent: true })`.
3. On `met` → run the push.

### Combination (AND)

> User: "Wait until the project is clean and the other agents are done,
> then commit."

1. No plan segment → no pre-check. Skip step 1.
2. `Monitor({ command: "keeper await git-clean and agents-idle",
   description: "wait for clean repo + idle agents then commit",
   persistent: true })`.
3. On `[keeper-await] met conditions=git-clean and agents-idle count=2`
   → run the commit.

## What NOT to do

- Do not wire a plan Monitor without the Step 1 board pre-check — a doomed
  Monitor that immediately exits `failed reason=not-found` is bad UX.
- Do not pass an id to `git-clean` / `agents-idle` / `server-up` — they're
  nullary (`git-clean` / `agents-idle` are project-scoped to the cwd's git
  root; `server-up` is daemon-scoped).
- Do not invent ids. If the user gives a slug-less reference ("the
  promotion epic") and you can't disambiguate, ask.
