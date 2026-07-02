## Description

**Size:** M
**Files:** src/reducer.ts (only if offenders confirmed), scripts/serve-fold-load.ts (header doc)

### Approach

Take task .1's measurements and act on the thresholds. For each confirmed offender (per-event p95 slope >20% between corpus halves, or a dominant contributor to a >10-minute total), remediate with a sanctioned shape only: id-watermark memo (model: MonitorProvenanceMemo reducer.ts:8547, GitAttribMemo :1214), idempotent per-key replace-merge (model: syncPlanLinks :6999-7009), or constant-bounded live-only modelling; recencyBound stays serve-path-only and is forbidden inside a fold (reducer.ts:8576). Re-fold determinism is sacred: any remediation must produce byte-identical projections for the deterministic-replayed class — verify by replaying the copy before/after and diffing the projection tables. If nothing breaches the thresholds, the deliverable is the headroom document instead: measured numbers, the growth curve, and the corpus size at which the 10-minute budget would be hit, written into the serve-fold-load.ts header and this task's Evidence. CLAUDE.md is touched only if a genuinely new bounding pattern is codified.

### Investigation targets

**Required** (read before coding):
- Task .1's Evidence — the measurements this task acts on
- src/reducer.ts:8576 — the recencyBound-forbidden-in-folds comment and its rationale

### Risks

The likely outcome is "document headroom" — known scaling folds were already remediated in prior work. Resist inventing work: a fold under threshold gets no change. A remediation that changes projection bytes is a determinism break, not a fix.

### Test notes

For any remediation: before/after replay of the copy with projection-table diff (must be byte-identical), plus the existing fold unit tests. For the headroom outcome: the document itself is the artifact.

## Acceptance

- [ ] Every threshold-breaching fold remediated with a sanctioned shape or explicitly justified in Evidence
- [ ] Any remediation proven byte-identical on the deterministic-replayed projection class via before/after replay diff
- [ ] Headroom (or the remediation delta) durably documented with re-run instructions
- [ ] `bun test` green

## Done summary
Audited true re-fold cost via two --replay-from-zero runs over a 775,125-event / 1,263-epic live copy: whole corpus re-folds in 91-95s (~6.6x under the 10-min budget), overall per-event p95 slope flat-to-negative (-18% / +0.6%). VERDICT: CLEAN — no fold reproducibly breaches the 20% slope or 10-min budget, so no reducer or CLAUDE.md change; per-kind slope flags are non-reproducing sub-ms jitter, not accumulating scans. Deliverable is the headroom document (serve-fold-load.ts header + Evidence) with the re-run procedure.
## Evidence
- Commits: 54ee7573
- Tests: replay-from-zero x2 (775125 events / 1263 epics): 91.2s / 94.6s wall, both well under the 10-min budget, overall per-event p95 slope -18.0% (run1) / +0.6% (run2) — bounded, non-offender, dominant folds flat: PostToolUse 25.6s slope~0, PreToolUse 24.9s +11%, EpicSnapshot 6.0s per-key O(1) single-epic INSERT, per-kind slope flags non-reproducible run-to-run (ApiError 29%->6%, EpicSnapshot 6%->36%, EpicDeleted absent->35%) = sub-ms baseline jitter, justified as non-offenders, VERDICT CLEAN: no fold remediated (none reproducibly breaches); headroom + ~5.1M-event budget-hit projection recorded in serve-fold-load.ts header, re-run: sqlite3 file:~/.local/state/keeper/keeper.db?mode=ro .backup /tmp/kdb-copy.db then bun scripts/serve-fold-load.ts --db /tmp/kdb-copy.db --replay-from-zero (twice), bun test: targeted test/serve-fold-load.test.ts 6/6 green; full suite 584 pre-existing env failures byte-identical at HEAD before change (plan/prompt worktree path resolution + parallel disk-I/O flakes; keeper-core reducer/db/refold pass serially) — zero delta