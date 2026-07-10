## Description

**Size:** M
**Files:** src/exit-watcher.ts, src/daemon.ts, src/dispatch-failure-key.ts, CLAUDE.md, test/exit-watcher.test.ts, test/dispatch-failure-key.test.ts

### Approach

Extend the stuck-sentinel sweep with a cwd-missing clause: a job in
state `working` whose recorded `cwd` no longer exists on disk while its
pid is alive (recycle-checked via pid + start-time) mints a visible
sticky needs-human distress row with a NEW class-stable sentinelReason
(e.g. `cwd-missing`), DETECT-ONLY — the daemon never kills on this
signal (ADR 0031). Scope to plan-dispatched sessions (mirror the
existing tier-2 planRef carve-out) so a human deleting their own
session's directory never pages keeper. The existing Tier-1 gate keys
`workerDone` off task rows and therefore structurally skips `close::`
jobs — the new clause must be independent of `workerDone` so closers
are covered; the sweep's candidate query already selects working rows
verb-agnostically. Fail closed on probe error: a throwing fs stat
suppresses the clause for that row (no page), never mints. Debounce
with a short grace (two consecutive pulses observing cwd missing)
so a job about to fold Killed during legitimate teardown never flaps a
row. The row level-clears on positive evidence only: the job leaves
`working` or the cwd reappears. The fs-existence probe is
producer-side in the sweep (never a fold).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at
authoring time, but the repo moves.*

**Required** (read before coding):
- src/exit-watcher.ts:614 — selectStuckSentinelVerdicts, the tier
  predicate to extend; :531 SentinelRow (add a cwd-existence fact),
  :561 StuckSentinelVerdict, :576 sentinelReason class-stability rule
- src/exit-watcher.ts:794 — the sweep candidate query (state='working'
  AND pid IS NOT NULL, verb-agnostic) — where the cwd column and the
  producer-side existence probe join the row
- src/daemon.ts:8760 — the stuck-sentinel DispatchFailed mint site
- src/dispatch-failure-key.ts:426-457 — the sentinel key predicates
  the new reason must compose with
- src/proc-starttime.ts — (pid, start_time) recycle identity
- src/server-worker.ts:985 — isPidAlive, injected as isAlive

**Optional** (reference as needed):
- src/autopilot-worker.ts:7765 — dirExists producer probe precedent
- test/exit-watcher.test.ts — clause-by-clause pure predicate tests
  driving selectStuckSentinelVerdicts with plain SentinelRows

### Risks

- False page during normal reap: the window between a session's cwd
  being legitimately removed (post-teardown) and its Killed fold —
  the two-pulse grace plus the leaves-working clear bound it
- CLAUDE.md edit must survive bun scripts/lint-claude-md.ts (fold into
  the existing distress-row family sentence, no re-narration)

### Test notes

Pure fast-tier: drive selectStuckSentinelVerdicts with SentinelRows
carrying an injected cwd-exists fact and injected isAlive — no real
fs/pid probes in assertions of the predicate itself. Cover: missing
cwd + live pid + working + planRef → verdict with the new reason
(after the grace); dead pid → no verdict (death fold owns it);
non-plan session → excluded; probe-error → excluded; cwd back →
clears; stopped state → excluded.

## Acceptance

- [ ] A plan-dispatched working job with a live (recycle-checked) pid
  and a missing recorded cwd mints a visible needs-human distress row
  with its own class-stable reason after a two-pulse grace, and the
  daemon takes no kill action on it
- [ ] The clause covers close:: jobs (independent of the task-keyed
  workerDone gate), excludes non-plan sessions, and a dead pid or a
  throwing probe mints nothing
- [ ] The row level-clears when the job leaves working or the cwd
  reappears
- [ ] CLAUDE.md's distress-row family line covers the new row and the
  lint gate stays green
- [ ] Full fast suite green

## Done summary

## Evidence
