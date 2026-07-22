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
| `server-up` | Any "wait until keeper / keeperd / the daemon is up / back / serving / reachable" phrasing. **No id.** Fires `met` on the first snapshot — i.e. the moment the READ socket opens, right after `migrate()` while the reducer may still be CATCHING UP. So `server-up` means "the control plane is reachable", NOT "the board has fully caught up"; an early board read may be provisional (its frames carry a `catching_up` boot-status header until the drain reaches head + the git surface is seeded). Reconnect-forever is the DEFAULT for every condition (see the reconnect note below) — `server-up` is special only in that it is PERMANENTLY exempt from opting out of that default: it **CANNOT be ANDed** with another condition, and **CANNOT be combined with `--connect-timeout`** (both parse-time usage errors), so it's the one condition that always blocks through a daemon bounce with no escape hatch needed. | `server-up` |
| `monitor-running <selector>` | Any "wait until my dev server / script / background task / build watcher finishes" phrasing. Scoped to THIS session's own monitors. **Takes one selector token:** `cmd:<full command>`, `kind:<monitor\|bash-bg\|ambient>`, or a bare token (= `cmd:<token>`). Exact match, never substring. | `monitor-running cmd:bun run dev` |
| `drained [--scope S]` | Any "wait until the board / plan / everything is done, at rest, nothing left to run" phrasing. **No id.** A dual-scope condition — see the *Which condition?* table below for which of the three axes fits. Distinguishes a JAM (a sticky `dispatch_failures` row) from true drain in every scope — add `--fail-on-stuck` to exit 5 on an operator jam instead of waiting. | `drained` (plan scope, the default) |
| `epic-added [id]` | "ping me when a new epic shows up" (bare) or "when fn-X appears on the board" (a specific id). **Edge-triggered:** never satisfied on first paint, so it always waits for a real appearance. | `epic-added` / `epic-added fn-…` |
| `epic-removed <id>` | "when fn-X leaves the board / is done or deleted." **One id, edge-triggered.** | `epic-removed fn-…` |
| `changed [since:R]` | "ping me when anything on the board moves" — an epic appears/leaves, a verdict flips, or autopilot config changes. **Edge-triggered;** optional `since:<hash>` anchors against a prior `changed` baseline so you can detect movement since a known point. | `changed` / `changed since:<hash>` |
| `<needs-human> [since:S]` | "ping me when there's a dead letter / block escalation / parked question / stuck dispatch / finalize non-ff jam / instant-death wall" (one signal), or "ping me on any needs-human signal" (the umbrella). **No id.** Six per-signal tokens — `dead-letter`, `block-escalation`, `parked-question`, `stuck-dispatch`, `finalize-non-ff`, `instant-death-wall` — plus the umbrella `needs-human` (any of them). **Level-triggered presence:** `stuck-dispatch`/`finalize-non-ff`/`instant-death-wall` and the umbrella fire on the operator-jam class only — a self-clearing occupancy sticky never trips them. That jam class includes the shared-checkout dirty/desync hygiene rows (daemon-paged once each; cleared ONLY when their producer sees the checkout reconciled, never over the retry wire). Optional `since:<signature>` anti-spin anchor: a still-present, already-triaged signal whose signature matches the anchor HOLDS, a genuinely new signal (signature moved) FIRES. | `needs-human` / `dead-letter` / `stuck-dispatch since:<sig>` |

| Field | How to derive | Example |
|---|---|---|
| `follow-up` | The clause after "then" / "and" / "and then" — what to run when the condition(s) hold. | "do a full review" |

## Which condition?

The vocabulary overlaps on purpose — pick by what "done" means to the caller:

| You want to know when… | Condition | Why not the others |
|---|---|---|
| …this one task/epic is done AND its work session has settled | `complete <id>` | `landed` fires later (needs the merge); `started` fires earlier (needs only a begin) |
| …an epic's code has actually MERGED to the local default branch | `landed <epic>` | `complete` can fire before the worktree finalize merge lands; `landed` is epic-only |
| …work has begun on a task/epic at all | `started <id>` | Monotonic — never use it to detect a re-run; it doesn't un-fire |
| …no keeper-dispatched plan work is left — the natural "board's clear for planning" check | `drained` (`--scope plan`, the default) | Ignores your own shell and any adopted/external session, so an unrelated live terminal never blocks it |
| …in-flight dispatched work has drained, on a paused board (no new dispatches will start) | `drained --scope inflight` | Ignores ready-but-undispatched rows — pair with a paused autopilot, not a playing one |
| …the WHOLE board — every session, including hand-started/adopted/external ones — is at rest | `drained --scope board` | The strict prior gate; the one `--scope` a strict consumer (e.g. the watch wedge alarm) must ask for explicitly |
| …a condition holds RIGHT NOW, without blocking (a pre-flight sanity check, a CI gate) | any condition + `--probe` | See *One-shot check* below — evaluates once and exits, never wired through Monitor |

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

> **`complete` is done-AND-idle, held until it settles.** The live wait can HOLD
> a beat past plan-done — while a stale subagent settles, AND until the
> done-AND-idle verdict survives a short confirmation window (a couple of
> consecutive board snapshots with the target row's version not regressing) — so
> a completion the close-out reconcile briefly unwinds back to running never
> fires `met`. The pre-check's `runtime_status == "done"` already reads as
> "popped off the board," but the live wait is deliberately the stricter of the
> two; the added steady-state latency for a genuine completion is bounded to
> those confirmation snapshots.

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
  reason=signal signal=SIGTERM` exit 10 through the same flush path — an
  external kill, DISTINCT from your own `--timeout` deadline (reason=timeout
  exit 3), so a mass-reap reads as reaps, not self-deadlines.
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
[keeper-await] failed target=<id> reason=<reason> … [detail=<…>] [retryable=<true|false>]
[keeper-await] failed reason=<reason> conditions=<…> … [detail=<…>] [retryable=<true|false>]   # aggregate
```

For an AND aggregate, a plan sub-condition that fails names which
condition fired via a `from=<condition-label>` field on the `failed`
line. A `timeout`/`signal`/`unreachable` failure additionally carries the LAST
waiting detail it observed (`detail=` — the condition's own last-known
state, e.g. `2 running jobs`). `timeout`/`unreachable` carry `retryable=true`
(re-arming the same `keeper await` invocation is the right next move once the
caller's deadline or the daemon link recovers). A `signal` failure (external
SIGTERM/SIGINT) additionally names the killing signal (`signal=SIGTERM`) and
carries `retryable=false` — an external kill is not the caller's own budget.
A `stuck` failure carries `retryable=false` too — an operator jam needs a
human, not a re-arm.

**Heartbeats (stderr, not the terminal contract).** While the wait is
still open, `keeper await` emits a periodic STDERR-only progress line —
default every 60s, `--heartbeat <dur>` to change the cadence, `--heartbeat
off` to silence it. It never touches stdout and never counts as a
terminal line:

```
[keeper-await] heartbeat state=waiting waiting=<slot: detail>[,…] [holders=<label (kind)>[,…]]
[keeper-await] heartbeat state=reconnecting detail=reconnecting to keeperd — holder list stale, withheld
```

`waiting` names each not-yet-met slot's condition and last-seen detail;
`holders` — present only for a `drained`-family slot with something
still open — names up to 5 concrete holders (job/pending-dispatch/task/
close-row) before truncating to a `+N more` tail. Treat heartbeats as
progress narration for the human, not a signal to act on.

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
| `failed reason=unreachable …` | 1 | **Only with `--connect-timeout`** (or implicitly under `--probe`, which always carries a bounded deadline). keeperd stayed unreachable past that deadline (down / mid-bounce / half-up — never painted a first snapshot). Distinct from `connect`. Carries `advice=` and `retryable=true`. **Reconnect-forever is the default for every condition** — a plain await with no `--connect-timeout` NEVER emits this, it just keeps reconnecting; `server-up` is the one condition permanently barred from opting out (see the `server-up` row above). | Tell the user the daemon is down. To block THROUGH the bounce, drop `--connect-timeout` (a plain await waits forever), or `keeper await server-up` first then re-arm once it's back. Do NOT run the follow-up. |
| `failed reason=deleted …` | 4 | Planctl target was on board, vanished, re-query miss. | Tell the user the target was deleted; do NOT run the follow-up. |
| `failed reason=timeout …` | 3 | Your own `--timeout` deadline hit. Carries `retryable=true` — the caller's budget ran out, not a verdict on the condition. | Tell the user it timed out; ask whether to extend or re-arm. |
| `failed reason=signal signal=<SIGTERM\|SIGINT> …` | 10 | An external signal killed the wait — Monitor's `timeout_ms` kill, or an operator kill. Names the signal and carries `retryable=false` — not the caller's own budget, so a mass-reap is never mistaken for self-deadlines. | Tell the user the wait was killed externally (e.g. Monitor's deadline); ask whether to re-arm or extend the deadline. |
| `failed reason=stuck …` | 5 | Under `--fail-on-stuck` only. Carries `retryable=false` — an operator jam, not self-clearing. | Tell the user the target is stuck; surface the verdict. |
| `probe result=does-not-hold …` | 9 | **`--probe` only.** Evaluated cleanly against the first snapshot; the condition just doesn't hold right now. Never 124 (that's GNU `timeout(1)`'s collision code). | Tell the user it doesn't hold yet; surface the `states=`/`holders=` detail. Do NOT run the follow-up. |

The `armed` line is information only — proceed past it. The first
`met` / `failed` line is terminal; act on it.

**`armed` is lifecycle state, not just a printed line.** Arming latches the
armed state regardless of `--no-armed-line`; that flag governs ONLY whether the
initial `[keeper-await] armed …` line is printed (its shape is unchanged when
it is). Everything else keyed on being armed engages the same either way:
`--require-transition` edge suppression, the `--json` envelope's `armed:true`,
the reconnect-blip swallow, and progress heartbeats. So
`--no-armed-line --require-transition` still suppresses a condition already true
at arm time and fires only on a genuine later edge — the flag never re-opens
the false-immediate-fire path.

**Already-satisfied-at-arm fires immediately.** If every condition
already holds at arm time (a clean repo, no other agents, a complete
target), `keeper await` emits `armed` and then `met` in quick
succession. That's correct behavior — run the follow-up. (Add
`--require-transition` to wait for a real edge instead; it holds under
`--no-armed-line` too.)

## Step 4 — Run the follow-up

On `met`, run the follow-up clause the user gave. If the follow-up is
itself a Claude Code task ("do a full review", "implement the next
task", "commit"), invoke whatever tools are appropriate for it. If it's a
shell command, run it via Bash.

**Pin a documented daemon runtime action at arm time.** When Hack owns a post-land await that fulfills epic `## Operator post-land`:

1. Arm `keeper await landed <epic>`—never `complete`—and pin the exact documented command at arm time.
2. On `met`, re-read the epic's final documented action before acting. If the pinned command is `keeper daemon restart` but the final section requires `bash scripts/install.sh`, run the stronger installer and report that drift. If the installer was pinned, run it even when the final section says restart; never downgrade an installer pinned at arm time. Otherwise run the pinned command.
3. Run from the Keeper repo root and report landing and refresh separately. `met` proves the epic landed on the default branch, not that refresh succeeded; a failed refresh leaves the landed commit landed.

On any `failed`, surface the terminal line to the user verbatim and ask
how they want to proceed — do NOT silently run the follow-up.

## Durable awaits (`--durable`) — a spawned session, not a self-wake

`keeper await <condition…> --durable` persists a server-evaluable wait and
returns immediately; when the condition is met, **keeperd dispatches a fresh
worker session** carrying the recorded follow-up prompt. That spawned session
re-orients and acts independently — it is NOT a notification to the arming
session.

Use `--durable` only when the follow-up is genuine fire-and-forget WORK a
fresh session should own (a review, a next planning round). For a milestone
wake-up of the CURRENT session — a supervisor wanting to be re-entered when a
condition holds — wire the Monitor per Step 2 instead: each fired durable
await costs a full worker spawn, and the spawn acts on its own rather than
waking you.

**Inspect and cancel.** `keeper await list` prints the durable-await rows as
JSON (`await_id`, condition, status). To retire a still-`waiting` await before
it fires:

```
keeper await cancel <await-id>          # the arming session cancels its own
keeper await cancel <await-id> --force  # audited operator override
```

A cancelled await never fires its follow-up — even against a fire already
racing the cancel: whichever event folds first wins, so a cancel that lands
first suppresses the launch and a launch that lands first makes the cancel a
no-op. Only the ARMING session may cancel its own await; `--force` is the
audited override that cancels another session's await (it records the acting
identity). An unknown id, an already-settled await, and another session's
await all return the SAME not-cancellable refusal (exit 1) — the path is not an
existence oracle. Re-cancelling an already-cancelled await is a no-op success.

## One-shot check (`--probe`)

For "would this fire right now, and if not, why?" without blocking — a
pre-flight sanity check, a CI gate, deciding whether a wait is even
needed — run `keeper await <condition…> --probe` directly via Bash, NOT
through Monitor (it's one-shot; there's nothing to stream). It evaluates
every segment once against the first painted snapshot and exits:

```
[keeper-await] probe result=holds states=<slot: detail>[,…] [holders=<label (kind)>[,…]]
```

- **Exit 0** — every segment holds right now (`result=holds`).
- **Exit 9** — evaluated cleanly, at least one segment does not hold
  (`result=does-not-hold`). Never 124 — that's `timeout(1)`'s GNU
  collision code, deliberately avoided since agents commonly wrap awaits
  in `timeout(1)`.
- The ordinary refusal codes still apply first and are more specific
  than a generic does-not-hold: not-found=1, ambiguous=6,
  `monitor-running` no-match=1, and a stuck plan/`drained` verdict under
  `--fail-on-stuck` still surfaces as its own exit 5.
- `--probe` implies its own bounded connect deadline (the same one
  `--connect-timeout` would set, when you didn't set one explicitly) —
  a down daemon still reports `reason=unreachable` exit 1 within that
  deadline rather than hanging forever, since a probe that never returns
  defeats its own "evaluate once and exit" purpose.
- **Edge-triggered conditions are a usage error under `--probe`**
  (`changed` / `epic-added` / `epic-removed` have no instantaneous truth
  value — exit 2).

```
keeper await drained --probe                    # "is the plan clear right now?"
keeper await drained --scope board --probe      # "is the WHOLE board at rest right now?"
keeper await complete fn-12-add-oauth.3 --probe # "is this task done+idle right now?"
```

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
