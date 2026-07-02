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

## Evidence
