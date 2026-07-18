## Description

**Size:** M
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts, docs/problem-codes.md

### Approach

Investigation-first: build a deterministic in-process red repro for how an absent
lane's `worktree-lane-backup-failed` row escaped the dir-keyed clear arm, then fix
the falsified seam. Two verified candidate causes: (1) `normalizeLanePath`
(realpathSync.native) resolves symlinked prefixes while the lane exists but falls
back to the raw path once absent, so the mint-time hash and the clear-time key
diverge across the present-to-absent transition (the /tmp -> /private/tmp class);
(2) the clear is gated on `laneEnumerationComplete` and an enumeration failure
window suppresses every clear cycle-after-cycle. Inject a normalize seam into the
producer (the fs call is not currently injectable) so the repro stays pure and
in-process; falsify one hypothesis before fixing. The fix must define "confirmed
absent" vs "unknown" explicitly and never over-clear a present-but-unenumerable
lane — the enumeration gate is today's only false-clear protection. Normalization
stays strictly producer-side (never fold-reachable). Add the missing
`lane-backup-failed` row to docs/problem-codes.md matching its table shape; amend
ADR 0053 only if clear-arm semantics change.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autopilot-worker.ts:576 — normalizeLanePath realpath fallback asymmetry
- src/autopilot-worker.ts:2077,2114 — mint (hash of normalized path, `dir: key`); :2132,2147 — finishCycle clear + early return; :8045 — allowClear gate; :9026-9032 — id-prefix routing; :10383 — openBackupPaths snapshot
- src/dispatch-failure-key.ts:326-338 — LANE_BACKUP_DISTRESS_ID_PREFIX + key family predicates

**Optional** (reference as needed):
- src/worktree-git.ts:1990-2210, plugins/plan/src/epic_lane_teardown.ts:273-339 — backup-failed producers
- test/worktree-git.test.ts:1437,1636,1661; test/autopilot-worker.test.ts:18001 — existing producer coverage; test/dispatch-failure-key.test.ts:677 — key classification

### Risks

- A more aggressive clear could mass-clear legitimate open distress rows on a live cycle — these rows are not human-recoverable via retry_dispatch
- Fixing the wrong seam (normalization vs enumeration-gate) leaves the escape latent

### Test notes

Pure, in-process, clock- and normalize-injected: mint under a "present" normalize
mapping, flip to "absent" behavior, assert today's escape (red), then green under
the fix. Cover the mint-while-already-absent edge (raw-path dir stored). Assert a
present-but-unenumerable lane retains its row.

## Acceptance

- [ ] A deterministic test reproduces the clear-arm escape under the injected normalize seam and pins which candidate cause is real
- [ ] The fixed producer clears an absent lane's backup-failed row and retains the row for a present-but-unenumerable lane
- [ ] Mint-while-absent stores a key the later clear actually matches
- [ ] docs/problem-codes.md carries the lane-backup-failed row; ADR 0053 amended only if semantics changed
- [ ] Named test gates for the touched suites pass

## Done summary
Injected a producer-side presence seam distinguishing confirmed-absent (ENOENT/ENOTDIR) from unknown lane probes, so a worktree-lane-backup-failed distress row now clears on positive absence evidence even when repo enumeration is incomplete, while still retaining rows for present or unenumerable lanes; added deterministic in-process coverage and the docs/problem-codes.md + ADR 0053 amendment.
## Evidence
