## Description

**Size:** M
**Files:** src/reducer.ts, src/daemon.ts, src/db.ts, src/server-worker.ts, src/protocol.ts, test/status.test.ts, test/db.test.ts

### Approach

Make `projected_full_replay_duration_ms` derive from the unpaced fold-work
rate per ADR 0075, leaving the catch-up projection on wall-clock. The
reducer already stamps each fold's pace-free work time after the write
lock is held; add a module-global MONOTONIC accumulator summing it across
every applyEvent (companion to the existing per-fold stamp — never reset
by callers), and have the daemon delta-sample that accumulator at exactly
the same two points where it samples the boot-catchup start/end event ids,
so the work numerator and the folded-event denominator cover the identical
event window by construction (including post-drain pump folds). Persist
the delta as a NULLABLE work-ms column on the `boot_catchup_stats`
singleton: one additive SCHEMA_STEPS entry (version is PROVISIONAL —
assigned at merge, never hardcode "the next" number in prose) using the
addColumnIfMissing idiom, the same column appended LAST to the inline
CREATE literal so fresh-bootstrap and upgrade converge, an extended
recordBootCatchupStats writer, and a SCHEMA_FINGERPRINT re-pin. In
computeEventStoreStatus, the full-replay branch uses work_ms/events_folded
only when work_ms > 0 and returns null otherwise (a pre-migration or torn
row must read as "not measured", never as an instant-rebuild 0); the
catch-up branch is untouched. Update the protocol docstrings to state
which rate feeds which projection and that full-replay is an estimator
(last boot's unpaced rate × current event count), not a rebuild promise.
New comments forward-facing; no fn-id provenance.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/reducer.ts:11727-11728 — the per-fold work_ms stamp (post-lock, pace-free); the accumulator sums this
- src/reducer.ts:11838-11920 — drain(); pacing sleeps happen AFTER applyEvent returns, so the stamp already excludes them
- src/daemon.ts:9662-9664, :9755-9763 — boot-catchup start/end sampling + recordBootCatchupStats call site; delta-sample the accumulator at these exact points
- src/server-worker.ts:2421-2462 — computeEventStoreStatus, the pure seam to fix; :2385 readBootCatchupStats
- src/db.ts:6556 — CREATE_BOOT_CATCHUP_STATS (extend inline, column LAST); :7473 recordBootCatchupStats; SCHEMA_STEPS tail + SCHEMA_VERSION/SCHEMA_FINGERPRINT + computeSchemaFingerprint around :4426-4462
- test/status.test.ts:192-254 — the pure computeEventStoreStatus suite; add work-rate, null-honest, and catch-up-unchanged expectations
- test/db.test.ts:445-464 — the fingerprint recompute/uniqueness/monotonic gates that redden until the re-pin
- docs/adr/0075-honest-replay-projections-and-rebuild-recipe.md — the contract this task implements

**Optional** (reference as needed):
- src/protocol.ts:136-169, :265-275 — EventStoreStatus wire contract + docstrings to update
- src/daemon.ts:359-442 — drainToCompletion (do NOT thread signatures through it; the global accumulator exists to avoid that ripple)

### Risks

- Numerator/denominator window mismatch understates the rate and biases the projection low (the reassuring-lie direction) — sampling both at the same two code points is the guard
- A NOT NULL DEFAULT 0 column would make pre-migration rows read as "instant rebuild" — the column must be nullable and the guard null-honest
- boot_catchup_stats is a non-fold operational singleton: folds never touch it, rewinds never wipe it; keep it that way

### Test notes

Hand-computed expectations in the pure status suite (work-rate projection,
null/0/negative work_ms guards, catch-up leg unchanged). Schema gates:
fingerprint re-pin + fresh-vs-upgrade convergence on the singleton's shape.
The daemon-side sampling is producer code exercised by the real-daemon
smoke at close-finalize (ADR 0073) — do not add an in-process daemon boot
to the correctness tier for it.

## Acceptance

- [ ] The event-store status block's full-replay projection equals accumulated fold work time over folded events scaled to the current event count when measured, and is null when the stats row carries no positive work measurement — never 0, never a paced-rate extrapolation
- [ ] The catch-up projection still derives from the wall-clock rate and existing status expectations for it are unchanged
- [ ] The schema ladder gains one additive step for the nullable work-ms column; a fresh bootstrap and a stepped upgrade converge on the same singleton shape; the fingerprint gates are green
- [ ] Protocol docstrings state the two-rate contract and the estimator framing
- [ ] The full fast correctness gates stay green

## Done summary

## Evidence
