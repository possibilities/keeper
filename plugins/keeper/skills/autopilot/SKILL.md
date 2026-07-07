---
name: autopilot
description: >-
  Drive the server-side autopilot reconciler by hand — pause / play, switch
  mode (yolo vs armed), arm / disarm an epic, retry a stuck dispatch, or read
  what it is doing. Also the temporary take-over window: capture the current
  {paused, mode, armed, worktree_mode, caps} state, change it for a bit, then restore it when the
  human says done. Use when the user asks to pause or steer the autopilot —
  pause/play, mode, arm, retry, or inspect it ("pause it", "let it rip",
  "only work fn-X", "approve fn-Y", "what's autopilot doing") — even when they
  never say "keeper" or "autopilot". NOT for launching one worker by hand
  (that is `keeper:dispatch`); "prioritize this" / "do this next" alone never
  triggers this skill (plan state carries no board-priority knob — only an
  explicit autopilot/armed reference does); NOT for ongoing board supervision or
  babysitting a run (that is `keeper:watch`); NOT for planning (`/plan:plan`).
allowed-tools: Bash
argument-hint: pause | play | mode <yolo|armed> | arm <id> | disarm <id> | worktree <on|off> | config <key> <val> | retry <verb::id> | show
---

# autopilot

Turn a "control or inspect the autopilot" request into a `keeper autopilot`
Bash call. The autopilot reconciler lives server-side in keeperd; it dispatches
ready plan work on its own and **boots PAUSED for safety**. This skill is the
operator surface over it — pausing, playing, mode-switching, arming, retrying a
stuck dispatch, and reading its live state. It is a precisely-triggered
operator surface, conservative by default: it mutates global autopilot state
only on a clear request to steer it. The autopilot quietly working ready epics
on its own remains the everyday path.

## When this fires

The user asks to control or inspect the autopilot. Two layers:

1. **Single control ops + reads** — pause / play, mode yolo|armed, arm /
   disarm an epic, retry a stuck dispatch, or "what's it doing." A bare control
   op JUST RUNS — one `keeper autopilot <sub>` Bash call, no capture/restore.
2. **The temporary take-over window** — ONLY when the human asks to "take over
   for a bit, then put it back." Capture state → drive → restore. See its own
   section below.

**Near-miss exclusions — these are NOT this skill:**

- *"fire a worker on fn-N.M"*, *"manually dispatch / spawn a worker"* → that is
  `keeper:dispatch`, which fires ONE worker by hand. `keeper dispatch` BYPASSES
  the autopilot entirely (you drive); this skill GATES it.
- *"prioritize this"* / *"do this next"* / *"jump the queue"* → there is no
  board-priority surface in plan state; this becomes this skill ONLY when the
  human EXPLICITLY names autopilot / armed mode ("arm fn-X", "only run fn-X under
  armed mode"). **Anti-trigger:** plain "prioritize" never means "arm."
- *"plan a feature"* / *"make a plan"* → `/plan:plan`.

## Parse the request

Map intent to the exact `keeper autopilot` subcommand — never "pass any valid
flags." Every control op below is a bare one-shot Bash call:

| Intent | How to derive | `keeper autopilot` form |
|---|---|---|
| Pause it | "pause", "stop dispatching", "hold the autopilot" | `keeper autopilot pause` |
| Play / let it run | "play", "unpause", "let it run", "resume" | `keeper autopilot play` |
| Yolo / let it rip | "yolo", "let it rip", "work everything ready" | `keeper autopilot mode yolo` |
| Armed mode | "armed mode", "only work armed epics", "narrow it to what I arm" | `keeper autopilot mode armed` |
| Arm an epic | "arm fn-X", "only work fn-X and its deps" — an epic id `fn-N-slug` | `keeper autopilot arm fn-N-slug` |
| Disarm an epic | "disarm fn-X", "stop arming fn-X" | `keeper autopilot disarm fn-N-slug` |
| Worktree mode on/off | "worktree mode on/off", "run lanes in worktrees" — durable toggle, rejected mid-epic (`--force` to override) | `keeper autopilot worktree on` / `keeper autopilot worktree off` |
| Set a concurrency cap | "limit to N workers", "cap concurrency at N", "at most N per repo" — runtime config; per-root is legal to set any time (stores intent, effective floors to 1 while worktree mode is off) | `keeper autopilot config max_concurrent_jobs <N>` (or `unlimited`) / `keeper autopilot config max_concurrent_per_root <N>` |
| Multi-repo worktree grouping | "cluster a multi-repo epic into per-repo lanes", "multi-repo worktree mode" — durable rollout flag, default OFF, only meaningful with worktree mode on | `keeper autopilot config worktree_multi_repo <on\|off>` |
| Retry a stuck dispatch | A sticky failure key `<verb>::<id>`, verb one of `work\|close\|approve` | `keeper autopilot retry work::fn-N-slug.3` |
| Clear / approve a phantom | "approve fn-X" — clears a resurrected/phantom approve pending (the reconciler never dispatches `approve` itself) | `keeper autopilot retry approve::fn-N-slug` |
| Show me what it's doing | "what's autopilot doing", "show me the autopilot", "is it paused" | `keeper status --json \| jq .data.autopilot` (read) |

`yolo` works EVERY ready epic; `armed` works ONLY explicitly-armed epics plus
their transitive upstream dep-closure. `arm` / `disarm` only matter in `armed`
mode (they populate the armed set), but setting them in `yolo` is harmless.

If the human gives a slug-less reference ("arm the OAuth epic") and you can't
resolve it to an exact id, ask. Do not invent ids. Gate any ambiguous
control-plane intent ("change the mode" without naming which) with ONE
clarifying question — fail loud on ambiguity, never guess a global-state mutation.

## Orient — reading autopilot state

<!-- POINTER: keeper prompt render engineering/orient -->

Read state with `keeper status --json`:

```bash
keeper status --json | jq .data.autopilot
```

It prints ONE `{schema_version, ok, error, data}` envelope and exits — no TUI
snapshot dance, no reconnect loop. `data.autopilot` IS the global singleton
(the same durable config `keeper autopilot show` returns as its own envelope):

```json
{ "paused": false, "mode": "yolo", "armed": [], "worktree_mode": false, "worktree_multi_repo": false, "max_concurrent_jobs": null, "max_concurrent_per_root": 1, "max_concurrent_per_root_stored": null }
```

`max_concurrent_per_root` is the EFFECTIVE cap dispatch honors (floors to 1
while worktree mode is off); `max_concurrent_per_root_stored` is the durable
intent you set, which survives a worktree-mode toggle untouched. Read those
eight fields to answer "what's it doing" and to capture before a
take-over. The same envelope's `data.drained` / `data.jammed`, `data.in_flight`
(pending + running launches), and `data.needs_human` (the six families — dead
letters, block escalations, parked questions, stuck dispatches, finalize-non-ff,
instant-death-wall) cover what it's CURRENTLY doing — so one read covers both
the config and the activity. Exit 0 on any board state; exit 1 only on
transport/usage. For the full orient step run `keeper prompt render
engineering/orient`. (The dispatch-log TUI `keeper autopilot --snapshot` still
exists for a human-readable frame; for a machine read prefer the status envelope,
and NEVER `--watch` — it hangs.)

## Single control op — just run it

A bare control op is one Bash call. No capture, no restore — the human asked for
a deliberate change, so do NOT auto-undo it.

```bash
keeper autopilot pause
```

On success the RPC writes one JSON line to stdout and exits 0; surface it to the
human ("autopilot paused"). On failure it exits 1 with an `autopilot: <reason>`
line — surface that verbatim; the state is unchanged.

## The temporary take-over window (capture → drive → restore)

ONLY when the human says some version of "take over for a bit, then put it
back." This is the one place capture/restore applies — a bare "pause it" must
NEVER capture/restore (that would auto-undo a deliberate pause).

**1 — Capture BEFORE mutating.** Read the full singleton and pin every field
you might change in your working context for the whole window:

```bash
keeper status --json | jq .data.autopilot   # → {paused, mode, armed, worktree_mode, worktree_multi_repo, max_concurrent_jobs, max_concurrent_per_root, max_concurrent_per_root_stored}
```

Capture `{paused, mode, armed, worktree_mode, worktree_multi_repo,
max_concurrent_jobs, max_concurrent_per_root_stored}` — capturing fewer than
the fields your take-over touches produces a wrong GLOBAL state on restore.
Pin them; do not re-derive from memory later. (`keeper autopilot show` returns
the same eight fields as its own envelope; restore `worktree_multi_repo` via
`keeper autopilot config worktree_multi_repo on|off`.)

**Per-root cap: capture and restore the STORED field, never the effective
one.** `max_concurrent_per_root` in the envelope is the derived EFFECTIVE cap
(floors to 1 while worktree mode is off); `max_concurrent_per_root_stored` is
the durable intent. Capture MUST pin `max_concurrent_per_root_stored`, and
restore MUST write it back via `keeper autopilot config
max_concurrent_per_root <stored>` — never the effective field. Capturing the
effective value while worktree mode is off and restoring THAT would write 1
into stored, silently clobbering the durable intent the human had set; this is
the exact bug class this skill's per-root cap contract exists to prevent.

**2 — Drive.** Run the control ops the take-over needs (pause, mode, arm, …).
Wire the restore plan PER MUTATING PHASE as you go — track exactly which fields
you changed so restore touches ONLY those.

**3 — The window closes on an EXPLICIT signal**, NOT a turn boundary. It closes
when the human says "restore it / put it back / done", or when an armed
`keeper:await` you set fires `met`. A turn ending does NOT close the window — a
take-over spans turns.

**4 — On close, RE-READ then restore.** The reconciler is LEVEL-TRIGGERED and
may have drifted during the window, so re-read current state before restoring:

```bash
keeper status --json | jq .data.autopilot   # re-read CURRENT state
```

Restore ONLY the fields your take-over changed, back to the captured values
(e.g. if you only paused, just `keeper autopilot play` to restore `paused:false`
— don't touch mode or arm). Issue one control op per field that needs reverting.

**5 — Surface a restore failure DISTINCTLY.** If any restore op exits non-zero,
do NOT swallow it. Surface a distinct error: **"autopilot state unknown — verify
with `keeper status --json`."** Name the **partial-mutation** case
explicitly when it happens (e.g. mode restored but a disarm failed) so the human
knows exactly which field is still off and can finish the restore by hand.

## The risk gradient

Teach the human (and yourself) which ops are walk-away-adjacent vs which hand
you the wheel:

- **`arm` / `mode armed` NARROW a still-running autopilot** — low risk. The
  reconciler keeps dispatching, just over a smaller set. Walk-away-adjacent.
- **`keeper dispatch` BYPASSES the autopilot** — YOU drive that worker. Higher
  risk, fully manual. That is `keeper:dispatch`, not this skill.
- **`pause`** stops all dispatching — deliberate and total; remember to `play`
  (or restore) when done.

## Narrow to armed to solve a problem, then restore yolo

A named composition for "something's wrong on the board, work just this
problem in isolation, then hand control back to yolo" — it reuses mechanics
this skill already documents rather than restating them:

1. **Capture** the current `{paused, mode, armed}` (plus any other field
   you're about to touch) using the take-over window's capture step above.
2. **Narrow.** `keeper autopilot mode armed`, then `arm` the problem epic(s).
   The armed set works with its transitive upstream dep-closure (see the mode
   table above), so arming the problem epic pulls in exactly what it depends
   on and nothing else.
3. **Drive the fix**, or simply let the narrowed reconciler drain it —
   `armed` mode still dispatches, just over the smaller set (risk gradient
   above: narrowing is walk-away-adjacent).
4. **Gate the restore on completion.** Arm a `keeper:await` for the problem
   epic reaching complete/landed rather than polling by hand; let it fire the
   restore.
5. **Restore yolo and disarm** on the await's `met`, following the take-over
   window's re-read-then-restore step — re-read current state, then restore
   only the fields you changed (`mode yolo`; `disarm` the problem epic(s) if
   you want a clean armed set for next time).

### Narrow, fix, and hand back (worked example)

> User: "fn-871-…-skills is stuck on a bad task — only work that while I sort
> it out, then put it back to normal."

1. **Capture:** `keeper status --json | jq .data.autopilot` → pin
   `{paused:false, mode:"yolo", armed:[]}`.
2. **Narrow:** `keeper autopilot mode armed`; `keeper autopilot arm
   fn-871-…-skills` → arms it plus its transitive dep closure.
3. Fix the bad task by hand, or leave the narrowed reconciler to drain it.
4. Arm `keeper:await` for `fn-871-…-skills` landed; the window stays open
   across turns until it fires.
5. **On `met` — re-read, then restore:** `keeper status --json | jq
   .data.autopilot`; `keeper autopilot mode yolo`; `keeper autopilot disarm
   fn-871-…-skills`. Surface "back to yolo, fn-871-…-skills disarmed."

## await integration

For "pause and do something manually at a point WHILE work runs," combine a
take-over with an armed `keeper:await`: capture state, make your change, arm
`keeper:await` for the board/condition that should end the window, and restore
on its `met`. See `keeper:await` for wiring the Monitor.

## Monitor liveness

Long-running supervision liveness-checks its monitors every heartbeat and
re-arms on loss. A daemon restart or session churn kills a `keeper bus watch`
inbox consumer and armed `keeper:await` Monitors SILENTLY — the watch just stops
delivering, no error surfaced, so a parked worker's question or an escalation
notify can land in a dead channel and be missed. Re-attach is the consumer's
job: on each supervision heartbeat confirm your inbox watch is still on the bus
(`keeper bus list` shows your channel) and any armed await is still live, and
re-arm whichever dropped. A supervisor that trusts a once-armed monitor to stay
live past a daemon bounce is running blind.

## Examples

### Pause it (bare control op)

> User: "Pause the autopilot."

1. `keeper autopilot pause` → exits 0, prints the RPC result.
2. Surface "autopilot paused." No capture, no restore — it's a deliberate change.

### Arm one epic under armed mode

> User: "Only work fn-871-…-skills and its deps."

1. `keeper autopilot mode armed` → narrows to the armed set.
2. `keeper autopilot arm fn-871-…-skills` → arms it (plus its transitive dep
   closure). Surface both results.

### Retry a stuck dispatch

> User: "Retry the work dispatch for fn-619-foo.3."

1. `keeper autopilot retry work::fn-619-foo.3` → clears the sticky
   `dispatch_failures` row so the reconciler can re-dispatch.
2. Surface the result. (For a phantom approve: `keeper autopilot retry
   approve::fn-619-foo`.)

### Show what it's doing (read)

> User: "What's the autopilot up to?"

1. `keeper status --json | jq .data.autopilot` → read `{paused, mode, armed,
   worktree_mode, …}`; the same envelope's `data.in_flight` / `data.needs_human`
   cover in-flight launches and anything needing an operator. For a faster
   per-row jam read, `.data.board.epics[].tasks[].dispatch_failure` and
   `.data.board.epics[].close.dispatch_failure` name the block KIND on the exact
   wedged row: the operator-action jams (multi-repo / merge-conflict / dirty-tree /
   non-ff, cleared by `retry`), the self-clearing occupancy signals
   `slot-occupied` (a stopped session holds the slot — visibility only) and
   `slot-reclaimed` (a provably-dead session's pane was auto-killed to free it),
   and `instant-death` (a key whose workers bound then died within a minute K
   times running — the circuit breaker paused its re-dispatch; `retry` re-arms it).
2. Report paused/playing, mode, armed epics, and any in-flight or stuck
   dispatches.

**Resolver attempt (read).** A sticky `worktree-merge-conflict` `close` may show an
autonomous `resolve::<epic>` worker in-flight — the daemon's one-shot merge-resolver
(dispatched only while playing; see Guardrails). It is a first-class dispatch key, so
reaps and the instant-death breaker apply to it. It fires ONCE per stuck close: to make
it re-attempt, clear the close sticky with `keeper autopilot retry close::<epic>` (that
re-arms the dispatch-once marker) — there is no `retry resolve::`. The `planner@<epic>`
merge-conflict escalation follows this resolver's verdict (see Guardrails): a brief
arriving means the resolver already declined or died, so before you act on it confirm no
`resolve::<epic>` is live.

**Quota-wall signal.** `.data.needs_human.instant_death_wall` counts the distinct
keys currently tripped by the instant-death breaker. `>= 2` (multiple keys dying
instantly in a window) is the likely **account session/quota wall** — repeated
instant worker deaths, not a flaky task; the per-key breakers already stopped each
key's burn (no silent churn loop), so the board never auto-pauses on it. Resume
each key with `keeper autopilot retry <verb>::<id>` AFTER the session limit resets
(check `keeper usage` for the reset time); retrying before the reset just re-arms
the breaker.

### Take over for a bit, then put it back

> User: "Pause it and switch to armed while I poke at fn-871, then restore it."

1. **Capture:** `keeper status --json | jq .data.autopilot` → pin `{paused:false,
   mode:"yolo", armed:[], worktree_mode:false}`.
2. **Drive:** `keeper autopilot pause`; `keeper autopilot mode armed`. Track:
   changed `paused` and `mode` (not `armed`).
3. Window stays open across turns until the human says "restore it / done."
4. **On close — re-read:** `keeper status --json | jq .data.autopilot` (the
   reconciler may have drifted).
5. **Restore only what changed:** `keeper autopilot play` (→ `paused:false`);
   `keeper autopilot mode yolo`. If `mode yolo` succeeds but `play` fails →
   surface "autopilot state unknown — verify with `keeper status --json`;
   mode restored to yolo but unpause FAILED (still paused)."

## Guardrails

- **Conservative by default.** Mutate global autopilot state only on a clear
  request to steer it; ask ONE clarifying question on ambiguous control-plane
  intent, never guess a global-state mutation.
- **A take-over always owes its restore.** Bare ops just run (no capture);
  capture → drive → restore is take-over-window-only, and the window is not
  discharged until the restore lands on its explicit close signal.
- **Escalations surface as decision-ready briefs.** When you relay a `needs_human`
  row (a sticky non-ff, a merge-conflict close, a blocked task) to the human, give
  a decision-ready brief — what happened, what the autopilot already tried or
  prepared, and the one decision you need — never a raw failure dump. The daemon's
  own bus notifications (block + merge escalations) already follow this shape;
  match it when you speak for them.
- **A merge-conflict close is the resolver's first, the human's second.** On a sticky
  `worktree-merge-conflict` close the daemon dispatches ONE `resolve::<epic>`
  merge-resolver worker (only while playing) — a first-class dispatch key, so reaps and
  the instant-death breaker apply. Its authority is deliberately narrower than a human's:
  it resolves ONLY mechanically-clear conflicts (both intents preserved, epic tests
  green) then commits and fires `retry close::<epic>`; anything state-machine / schema /
  security / transaction-boundary shaped it stamps BLOCKED with the unstick sentence and
  leaves for the human. The `planner@<epic>` escalation fires ONLY after that resolver
  reaches a terminal verdict — it DECLINED (stamped BLOCKED) or its job died — never
  concurrently, so the two never race the same base worktree. The close audit — sized
  lean/standard/deep from the epic's signals (task count, tier mix, diff size, touched
  repos) — still gates the merged result whichever path resolves; relay the escalation as usual.
- **Per-task audit blocks self-handle or page by category.** A task the selection policy
  flagged high-risk parks blocked `AUDIT_READY` while its owning orchestrator runs the
  audit and resumes it — the daemon pages no one while that orchestrator lives, escalating
  it like any block only if the orchestrator dies with the task still parked past a short
  grace. A verified-severe finding rewrites the reason to `AUDIT_SEVERE`, which pages
  immediately like any block; relay either page as a decision-ready brief.
- **Pausing does NOT stop an in-flight resolver.** `pause` stops the recover sweep and
  new dispatches, not a resolver already running. On a merge-conflict escalation — or
  before you manually resolve ANY stuck merge-conflict close — check `keeper query jobs`
  for a live `resolve::<epic>` and DEFER to its verdict; a manual merge racing a live
  resolver is the exact collision this flow prevents. (A retry re-dispatches a fresh
  resolver, so the same check applies right after `retry close::<epic>`.)

## Mid-epic deploy (manual lane-merge to main)

When an epic's fix must run in the LIVE daemon before the epic closes — a task's real
verification needs the code deployed, but base→main deploy only happens at close-finalize —
deploy the base lane by hand. Task specs push live-verification onto this operator step
rather than task acceptance, so this is the runbook that discharges it.

1. **Pause first** — `keeper autopilot pause`, so no dispatch or recover sweep races your
   merge on the shared checkout.
2. **Switch to main** — `git checkout main` (or your default branch). `git merge` merges into
   the current HEAD, so you MUST be on main before step 3 or you deploy the lane to the wrong
   branch and step 5 pushes it — silently failing the to-main deploy this runbook promises.
3. **True-merge the base lane to main** — `git merge --no-edit keeper/epic/<id>`. Merge the
   epic BASE lane (`keeper/epic/<id>`); task lanes only fan in at finalize, so a specific
   task lane needs its own `keeper/epic/<id>--<task>` merge. **Never `--squash`** — a squash
   is not an ancestor of the lane and breaks the cross-epic merge-gate and clean finalize.
4. **Run the affected-suite gate** — the tests covering what you just merged, green before
   you ship.
5. **Push** — `git push` main.
6. **Play** — `keeper autopilot play`.

Finalize later re-merges the lane cleanly: because your merge made the lane an ancestor of
main, close-finalize's true merge is a no-op fast-forward, not a conflict.
