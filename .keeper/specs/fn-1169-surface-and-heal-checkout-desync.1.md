## Description

**Size:** M
**Files:** src/dispatch-failure-key.ts, src/autopilot-worker.ts, src/reconcile-core.ts, src/dispatch-failure-pill.ts, src/daemon.ts, test/dispatch-failure-key.test.ts, test/dispatch-failure-pill.test.ts, test/board.test.ts, test/autopilot-worker.test.ts, CLAUDE.md

### Approach

Add a fifth sibling to the daemon-verb distress-row family: reason class `shared-checkout-desync`, minted when a plumbing base→default merge's post-merge resync is skipped or aborted, per-repo keyed (`repoDirHash` of the checkout toplevel), level-cleared only on positive evidence that the on-default checkout content-carries the default tip. The mint moment is event-seeded (the skip/abort happens inside the merge call and is otherwise invisible — the merge still returns `merged`); the clear is a per-cycle snapshot-time probe over the OPEN desync rows' dirs, so the row survives epic teardown and daemon restarts (the open-row set re-seeds any in-memory latch). Both observed index states must satisfy the contract: a fresh desync leaves the index behind HEAD, while subsequent git activity can sync the index leaving only worktree-side staleness — so clear evidence is content-level ("index and worktree match HEAD on the default branch"), never a single index-vs-HEAD orientation, and a human's ordinary unstaged edit alone (no skip event) never mints. A short grace via the sibling tracker pattern keeps an index.lock blip from minting while a genuine stuck desync survives it. The row is not retry-clearable, orphan-GC-exempt, prefix-disjoint from all existing families, and stays OUT of the jam allowlist (it self-heals once task 2 lands). The drained shared-checkout-dirty observation seam stays byte-untouched — this is a new reason class, not an un-neutering. Re-emits are change-gated per the existing DispatchFailed producer discipline (first appearance, reason-change, bounded still-stuck watermark). No schema change: the row rides the existing dispatch_failures columns exactly as shared-checkout-wedge does.

Grep caution: src/autopilot-worker.ts and src/reconcile-core.ts contain a NUL byte — plain grep reports "binary file matches"; use `rg -a` / `grep -a`.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autopilot-worker.ts:4441 — decision-B resync block inside mergeLaneBaseIntoDefault (idle-clean gate ~4447, reset --hard ~4478); the skip/abort here is the mint event source
- src/autopilot-worker.ts:1146 — shared-checkout-wedge grace tracker, the canonical clone source; sharedWedgeDistressId at ~1066 for the id shape
- src/autopilot-worker.ts:6835 — stale-base-lane per-cycle probe + tracker step wiring (the snapshot-probe idiom to mirror, with one deliberate divergence: probe over open-row dirs / known roots, NOT per-epic, so the row outlives its epic)
- src/autopilot-worker.ts:6391 and src/daemon.ts:6973 — SharedWedgeDistressMessage emit → daemon handler → mintSharedWedgeDistress (~7344): verb-neutral channel to reuse verbatim, no new message type or handler
- src/dispatch-failure-key.ts:127 — daemon-verb distress convention (never in failedKeys, never retry-clearable, orphan-GC-exempt); vocabulary/predicate/display-rule blocks for the new family
- src/autopilot-worker.ts:5784 — sharedWedgeDistressDirs open-set threading in loadReconcileSnapshot; add the desync sibling so pre-restart rows still level-clear
- src/reconcile-core.ts:1085 — WorktreeRecoveryOutcome extension precedent (laneWedged?) if any outcome field is needed

**Optional** (reference as needed):
- src/needs-human.ts:155, src/await-conditions.ts:1044 — verify the row lands in needs_human totals and stays OUT of the jam allowlist with zero edits
- src/worktree-plan.ts — repoDirHash
- test/autopilot-worker.test.ts:13156 — tracker cadence test clone source

### Risks

- The mint-event → per-cycle-clear hybrid is new to the family (siblings are pure level-probes); the Early proof point fallback is a pure latch persisted via the open row itself
- False-positive minting on transient index.lock contention — the grace window is the mitigation; tune small (minutes, not tens of minutes)
- Prefix collision or display-rule ordering mistakes are caught by the consistency suites — run them early

### Test notes

Fast tier only (pure seam, no real git): tracker cadence clone (mint after grace, clear on carries-HEAD evidence, restart re-seed from open-row set); consistency suites for prefix disjointness, display-kind total-function, pill format; a routeDispatchFailure unknown-arm assertion for the new key. The probe/latch git decisions go through the scripted GitRunner fake.

## Acceptance

- [ ] A ref-only base-to-default merge whose resync is skipped or aborted yields a per-repo needs-human row with reason `shared-checkout-desync` within one reconcile cycle after its grace, visible on the board's needs-human surfaces
- [ ] A human's ordinary uncommitted edit alone, with no skipped-resync event, never mints the row
- [ ] The row is not clearable via retry_dispatch, is orphan-GC-exempt, does not join the jam allowlist, and re-emits are change-gated (O(1) events per stuck condition)
- [ ] The row level-clears once a cycle observes the on-default checkout content-carrying the default tip (index and worktree both match HEAD), including after the causing epic closes and after a daemon restart
- [ ] An off-default or mid-merge checkout retains an open row (with the blocker named in the reason detail) rather than clearing or spamming
- [ ] CLAUDE.md's autopilot block carries the new row's one-line contract (key shape, clear trigger, GC exemption, producer verb), woven into the existing distress enumeration
- [ ] No SCHEMA_VERSION change; `bun test` green including the extended consistency suites

## Done summary

## Evidence
