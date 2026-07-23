## Description

**Size:** M
**Files:** src/account-focus-lifecycle.ts, src/account-routing-config.ts, src/account-observer-worker.ts, src/fable-focus.ts, src/daemon.ts, src/reducer.ts, test/account-focus-lifecycle.test.ts, test/account-observer-worker.test.ts, test/fable-focus.test.ts, test/daemon.test.ts, test/reducer-projections.test.ts, test/refold-equivalence.test.ts

### Approach

Add a bounded PII-free lifecycle checkpoint with one partition per focus scope and exact policy identity. Seed new episodes from daemon-validated arming evidence, retain the last trusted ordered observation across unavailable gaps and restarts, ignore older/equal or incompatible samples, and hold a triggering sample as pending until the corresponding Projection cell and owner-only leaf are both verified off. Exact transition predicates are `previous < 1 && current === 1` and `previous > 0 && current === 0`; endpoint level alone never creates a transition.

Extend the Account observer's typed protocol so quota or deadline evidence requests a conditional clear and main acknowledges an applied, already-cleared, or stale episode independently per scope. Main rechecks the current `policy_id`; the Synthetic event carries an explicit expected policy fence and bounded cause/evidence; the deterministic Fold compare-and-clears only a matching cell. Public `null` remains unconditional, and malformed or mismatched automatic metadata is a no-op. Boot reconciles overdue lifetimes before focus-leaf publication, while the normal observer cadence retries deadlines, transitions, and failed publication repair without making an in-memory timer authoritative.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/account-observer-worker.ts:88-151` — forced Capacity cadence, nonfatal retry behavior, and current cycle seam.
- `src/account-observer-worker.ts:233-285` — inert import guard, worker data, and shutdown-only message contract to extend.
- `src/account-recovery.ts:237-332` — bounded schema-versioned atomic side-state and injectable store pattern.
- `src/daemon.ts:9686-9744` — exact per-scope owner-only leaf publication and verification.
- `src/daemon.ts:11730-11745` — boot focus rehydration ordering that overdue reconciliation must precede.
- `src/reducer.ts:7151-7217` — generic config payload fields and independent focus cells.
- `src/reducer.ts:7314-7368` — current unconditional null semantics and sibling-preserving pure Fold.
- `docs/adr/0070-attempt-and-incident-fenced-dispatch-clears.md:28-49` — capture-before-delay, main revalidation, and compare-and-clear discipline.

**Optional** (reference as needed):
- `src/fable-focus.ts:162-221` — existing cycle-end level completion to narrow for modern transition-driven episodes.
- `src/account-routing-config.ts:43-52` — three-minute cadence and jitter that bound durable-clear latency.
- `test/daemon.test.ts:5554-5713` — focus rehydration, exact policy identity, and sibling publication isolation.
- `test/reducer-projections.test.ts:6480-6540` — independent set/preserve/clear and re-fold fixtures.

### Risks

- Advancing the checkpoint before verified clear acceptance can lose the only transition across a crash.
- Treating stale/unhealthy/missing evidence as zero or as a chain break either invents or suppresses endpoint transitions; ignore it while retaining the trusted predecessor.
- An unfenced or malformed internal clear must never fall through to manual unconditional-null semantics.
- A Projection-off/leaf-stale split can continue routing under obsolete delivery unless retries repair and verify the leaf before acknowledgement.
- Boot order must not republish an overdue policy before its level-triggered lifetime clear settles.

### Test notes

Build a pure state-machine matrix for first sample, duplicates, older timestamps, equal timestamps, unavailable gaps, long restart gaps, policy replacement, target/meter mismatch, exact/interior endpoints, permanent/absolute/current-reset/cycle-end lifetimes, simultaneous causes, same-target sibling scopes, corrupt/missing/oversized checkpoint, lock contention, append failure, crash after append, Fold mismatch, publication failure, acknowledgement loss, and retry. Test Fold and re-fold with modern conditional, malformed conditional, stale fence, duplicate, historical config, and manual-null events.

### Detailed phases

1. Implement the pure lifecycle state machine, strict checkpoint codec, atomic store, bounded pending evidence, and exact scope/meter mapping.
2. Seed runtime and boot episodes from current policy identities plus event-owned arming evidence; legacy episodes safely baseline their first trusted sample.
3. Add typed worker→main clear requests and main→worker episode/ack messages, coalescing causes per policy while keeping scopes independent.
4. Add main and Fold fences to the internal conditional-clear event, then reuse exact Projection/leaf publication for acknowledgement and repair.
5. Reorder boot lifetime reconciliation ahead of leaf publication and narrow modern Fable cycle-end completion to deadline or exact transition.
6. Prove crash-window, restart, gap-retention, stale-message, sibling-isolation, and deterministic replay invariants.

### Alternatives

Direct observer writes violate sole-writer and replay rules. A current-level check cannot prove transition. Discarding predecessors on gaps misses requested endpoints. One combined scope checkpoint or event couples independent failure domains. A dedicated wall-clock timer adds lifecycle state without improving routing, which already evaluates deadlines half-open at read time.

### Non-functional targets

- O(1) bounded state per focus scope; no observation history, unbounded dedupe set, kernel watcher, or host-wide lock.
- No DB connection or write in the Account observer worker.
- At most one conditional clear event per matching policy effect; duplicate requests repair/acknowledge without event growth.
- No fold reads wall-clock, filesystem, environment, or Capacity evidence.
- All worker messages, side-state, logs, causes, and event evidence remain bounded and PII-free.

### Rollout

Existing policies without arming evidence retain routing compatibility and establish a baseline before quota-driven clearing. Overdue lifetime clearing applies immediately at boot. Unsupported or corrupt lifecycle state degrades to safe re-baselining, never endpoint inference. Operator manual clear remains the rollback path for any focus episode.

## Acceptance

- [ ] Both focus scopes use the same exact quota-transition rules with `model:Fable` and weekly `week` evidence from the configured target route.
- [ ] Trusted predecessors survive unavailable observation gaps and daemon restarts, while untrusted, older, equal, missing-route, and missing-meter samples neither clear nor advance state.
- [ ] Permanent policies clear only on quota transitions; bounded lifetimes clear at the half-open deadline; modern Fable cycle-end quota completion requires a proven transition rather than a current 100% level.
- [ ] Boot clears overdue episodes before publishing launch leaves, and cadence reconciliation eventually clears or repairs every still-current pending episode.
- [ ] Main and the Fold independently fence automatic clears to the expected policy identity; malformed, duplicate, delayed, and stale requests cannot clear replacement or sibling intent.
- [ ] A triggering checkpoint is retained until the exact Projection cell and corresponding launch leaf are verified off, covering append, Fold, publication, acknowledgement, and restart crash windows.
- [ ] Simultaneous causes coalesce per policy, simultaneous scopes settle independently, and manual unconditional clears retain their existing behavior.
- [ ] Named lifecycle, observer, Fable, daemon, reducer, and re-fold tests pass deterministically without real workers, providers, sockets, or daemon processes.

## Done summary

## Evidence
