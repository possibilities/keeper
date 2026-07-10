## Description

**Size:** M
**Files:** src/reconcile-core.ts, src/autopilot-worker.ts, test/autopilot-worker.test.ts, test/daemon.test.ts

### Approach

Make closer occupancy a hard gate on every path that can merge or tear
down an epic's lane. The finalize collection currently fires on
`completedRowIds ∪ closerJobFinished`; the `completedRowIds` arm must
route through the same occupancy check `closerJobFinished` already
encodes (`isOccupyingJob`: `working` always occupies, `stopped` occupies
while its pane is live, `livePaneIds === null` occupies everything), so
an epic whose close job still occupies defers finalize to a later cycle
— a self-resolving deferral minting no row, in the existing non-sticky
retry-skip idiom. Apply the same occupancy pre-condition to the
recover-pass teardown sweeps (including the merged-orphan base sweep)
before any `gitRemoveWorktree`, expressed in recover's own idiom (a
plain `continue`, not a failure row — a live occupant is
self-resolving). Do not introduce a new liveness predicate or any
cwd-path matching: the shared occupancy seam is the single authority so
reconciler and board never drift. The deferral intentionally ends at
"no longer occupying," not "process dead" (ADR 0031) — an idle closer
occupies until its pane dies, normally via autoclose's reap. Preserve
crash robustness: a crashed closer (stopped, pane gone) does not
occupy, so finalize proceeds, and the projection-done confirmation
(`isEpicDone`) stays the merge authority. The conflict-escalation path
(resolver → deconflict → page) must be reachable exactly as today once
the closer has exited.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at
authoring time, but the repo moves. NOTE: src/autopilot-worker.ts
contains a NUL byte so plain grep reads it as binary — use `rg -a`,
sed, or python.*

**Required** (read before coding):
- src/reconcile-core.ts:1581 — closerJobFinished + its doc (:1563)
  naming the BROADER-than-completedRowIds union; :1976 the consumption
  site
- src/reconcile-core.ts:1208 — isOccupyingJob semantics (working /
  stopped-live / degraded-probe arms); :1225 isStoppedJobLive
- src/reconcile-core.ts:1712-1739 — completedRowIds harvest +
  root-occupant counting over perTask AND perCloseRow
- src/autopilot-worker.ts:4215 — finalizeEpic inside
  createWorktreeDriver; :4249 retrySkip; :4497-4515 the finalize
  teardown loop
- src/autopilot-worker.ts:5687 recoverWorktrees; :6185-6213 the
  recover teardown site; the pass-3 merged-orphan sweep (commit
  122baab3)
- src/autopilot-worker.ts:4564-4573 — hasActiveResolver callback
  injection, the template for threading an occupancy predicate into
  the driver

**Optional** (reference as needed):
- git log -S closerJobFinished: 998aee10 (original design), fcd0e630
  (projection-done re-route rationale: crashed-closer robustness)
- test/helpers/fake-git.ts:81 — fakeAsyncGit, the fast-tier git seam

### Risks

- Over-deferral: if the occupancy read wedges live (pane probe
  permanently degraded), finalize defers indefinitely and silently —
  acceptable per the fail-closed rule, but keep the existing
  console.error diagnostic on the defer path so it is observable
- Armed-mode/paused interplay and the cross-epic merge-gate must be
  byte-unchanged for epics with no occupying closer

### Test notes

Fast-tier only, through the pure seams: reproduce the incident ordering
with an injected jobs map — epic folds done, close job state `working`
→ finalize not collected; closer flips stopped with dead pane →
collected next cycle. Cover: stopped-with-live-pane defers,
livePaneIds null defers, crashed closer (stopped, no pane) proceeds,
recover sweep skips an occupied lane and still sweeps a genuinely
orphaned one. No real git, no subprocess.

## Acceptance

- [ ] An epic whose projection folds done while its close job occupies
  (working; stopped with live pane; or degraded pane probe) is not
  collected for finalize that cycle, verified by a fast-tier test
  reproducing the incident ordering end-to-end through the reconcile
  seam
- [ ] A crashed closer (stopped, pane dead) still finalizes — no
  regression of projection-done crash robustness
- [ ] The recover pass never removes a lane worktree whose epic has an
  occupying close or work job, and still sweeps genuinely orphaned
  merged bases
- [ ] The occupancy decision reuses the shared predicate — no new
  liveness semantics, no cwd matching anywhere in the diff
- [ ] Full fast suite green

## Done summary
Gated the projection-done finalize arm and recover pass-3 teardown on the shared isOccupyingJob seam so a done epic whose closer still occupies its lane defers merge/teardown until the closer exits (ADR 0031); reuses the occupancy seam only, no cwd matching. Added epicHasOccupyingJob + incident-repro fast-tier tests.
## Evidence
