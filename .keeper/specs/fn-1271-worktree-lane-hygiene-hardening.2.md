## Description

**Size:** M
**Files:** src/worktree-git.ts, src/autopilot-worker.ts, test/worktree-git.test.ts, test/autopilot-worker.test.ts, test/helpers/sandbox-env.ts, CLAUDE.md

### Approach

Replace the recover pass's silent per-cycle teardown-dirty re-mint with ADR 0053's bounded
destruction. New pure-seam helpers in the git layer (behind GitRunner, never widening
removeWorktree): an ownership classifier — owned (lane's git-common-dir resolves into this
repo + keeper/epic/* branch parses) / foreign (common-dir elsewhere or standalone .git
dir) / ambiguous (probe error, unparseable branch) / locked (porcelain lock annotation) —
and a backup-then-force-remove that snapshots staged+unstaged diffs and untracked files
(--exclude-standard) to the lane dirt spool (new env-overridable state dir mirroring the
dead-letter resolver; one size-bounded JSON index line per snapshot) and only then
worktree-remove --force + prune. The recover sweep gains a per-lane-path grace tracker
(SharedCheckoutWedgeTracker idiom, injectable grace, longer than the page graces): a
closed/tombstoned epic's un-tearable lane that is merged-to-default OR tombstoned, with no
occupying job and no MERGE_HEAD, destroys past the grace with TOCTOU re-probes in the same
cycle; closed-but-UNMERGED, foreign, ambiguous, and locked lanes mint ONE page-once
distress row (new reason class outside worktree-recover*, level-clear when the lane is
gone) — never destroyed, never silently re-minted. A persistently failing backup mints its
own page-once row and never destroys. The finalize-path teardown failure degrades to a
non-sticky deferral so the recover pass is the sole destroyer. Revise the CLAUDE.md
recover-pass invariant clause in place and add the spool env to the test-isolation
enumeration + sandboxEnv.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autopilot-worker.ts:6829 — the recover re-mint loop (teardown-dirty push at :6910); :6836-6852 the gate chain (epicPresentAndNotDone/epicHasOccupyingJob/gitIsAncestorOf) that stays ABOVE any force branch
- src/autopilot-worker.ts:5149 — the finalize-path sibling sweep (hard failure at :5173) to degrade into a deferral
- src/autopilot-worker.ts:1253 — SharedCheckoutWedgeTracker (the grace/page-once/level-clear template); :1354 the dirty sibling
- src/worktree-git.ts:1760 — removeWorktree (never widen); :504 classifyLinkedWorktree; :1342 isKeeperLaneEntry/epicIdFromKeeperLaneEntry; :733 mergeReadiness owner probe precedent
- src/db.ts:4853 — resolveDeadLetterDir (the env-overridable state-dir pattern for the spool); src/dead-letter.ts:100 (size-bounded JSON line discipline)

**Optional** (reference as needed):
- test/worktree-git.test.ts:1241 — FakeGitRule pattern; must model git-common-dir + porcelain lock output for the classifier
- test/helpers/sandbox-env.ts — where the spool env joins the sandboxed state classes

### Risks

- Destroying a live worker's cwd creates Phantom-working — the occupancy + TOCTOU gates are load-bearing; never destroy on an inconclusive probe.
- Mid-merge lanes belong to the existing mid-merge classification — the destroy gate requires no MERGE_HEAD.
- The distress row must be producer-side live-only, page-once via human_notified_at, cleared only by the level-trigger (never retry) — mirror the shared-checkout siblings exactly.

### Test notes

Fast tier via FakeGitRunner + injected now: classifier truth table (owned/foreign/
ambiguous/locked); destroy fires only with every leg (closed+merged / tombstoned, grace
crossed, no occupant, backup succeeded); unmerged-closed pages; backup failure blocks +
eventually pages; finalize defers instead of hard-failing; re-mint gone (one row, stable
across cycles). Slow tier: one real-git backup+force-remove cycle if worktree-lifecycle
patterns allow.

## Acceptance

- [ ] A closed epic's merged (or tombstoned) un-tearable lane is snapshotted to the spool then force-removed past the grace; the snapshot contains the staged, unstaged, and untracked dirt
- [ ] Foreign, ambiguous, locked, and closed-but-unmerged lanes are never destroyed and page exactly once, clearing when the lane is gone
- [ ] A failed backup never destroys; a persistently failing backup pages
- [ ] The finalize path defers instead of minting the hard teardown-dirty failure; no silent per-cycle re-mint remains
- [ ] The spool env is sandboxed in tests and the CLAUDE.md recover-pass + test-isolation lines match shipped behavior

## Done summary

## Evidence
