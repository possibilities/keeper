## Description

**Size:** S
**Files:** src/restore-worker.ts, src/reducer.ts, test/restore-set.test.ts (or a reducer test)

### Approach

Add an optional `job_id` field to each `TmuxTopologyPane` so the dying-generation snapshot carries the resolved keeper job per pane, letting the restore deriver read job identity from the EVENT PAYLOAD instead of the live-only (fold-lagged, compactable) projection columns. The producer `topologySnapshotPulse` already reads the `jobs` list at the post site — join each probed `pane_id` to `jobs.backend_exec_pane_id` (the `fillablePairs` pattern at `restore-worker.ts:776`) and stamp `job_id` (or leave it absent when no keeper job owns the pane). Extend `extractTmuxTopologySnapshot` to decode and type-narrow the new field. EXCLUDE `job_id` from `hashTopology` dedup (it is stable per pane; including it would not change post granularity meaningfully and risks churn). The fold `foldTmuxTopologySnapshot` stays UNCHANGED — it keeps keying on `pane_id` and must not read `job_id`, so re-fold determinism is untouched and the addition is purely additive.

### Investigation targets

**Required** (read before coding):
- src/restore-worker.ts:205-209 — `TmuxTopologyPane` type to extend
- src/restore-worker.ts:1028-1064 — `topologySnapshotPulse` producer + the post site where the join lands
- src/restore-worker.ts:776 — `fillablePairs`, the existing pane_id→job match pattern to mirror
- src/restore-worker.ts:920-927 — `hashTopology` (confirm job_id is excluded)
- src/reducer.ts:3199-3248 — `extractTmuxTopologySnapshot` per-pane decoder to extend
- src/reducer.ts:3285-3315 — `foldTmuxTopologySnapshot` (confirm it stays unchanged, ignores job_id)

### Risks

- A pane whose job row is not yet written at post time resolves to no `job_id`; the deriver (T2) must tolerate an absent `job_id` and fall back to the `(generation_id, pane_id)` projection join for that pane — keep `job_id` OPTIONAL, never required.
- Re-fold determinism: the fold must not start reading `job_id`. Verify the live-only skip-floor behavior at reducer.ts:3276-3290 is untouched.

### Test notes

Add a `seedTmuxTopologySnapshot(db, id, generationId, panes)` helper (mirrors `seedBackendExecStart` at test/restore-set.test.ts:113, explicit rowid). Assert the decoder round-trips `job_id`, that a pane without `job_id` decodes cleanly, and that the fold output is byte-identical with and without the new field present.

## Acceptance

- [ ] `TmuxTopologyPane` carries an optional `job_id`; the producer stamps it via the `jobs` join at the post site
- [ ] `extractTmuxTopologySnapshot` decodes `job_id` and tolerates its absence
- [ ] `foldTmuxTopologySnapshot` is unchanged and ignores `job_id` (re-fold determinism preserved)
- [ ] `job_id` is excluded from the topology dedup hash
- [ ] `seedTmuxTopologySnapshot` test helper added; decoder + fold-invariance tests green

## Done summary

## Evidence
