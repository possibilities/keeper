## Description

**Size:** M
**Files:** src/pair/panel.ts, test/pair-panel.test.ts, test/agent-panel-cli.test.ts

### Approach

Replace slug-as-ownership with an atomically reserved Panel request carrying an opaque identity, immutable argument digest, display slug, monotonic state, one normal fan-out budget, and a durable registry of every member attempt. Add idempotent reserve/start/wait/status/cancel plus an explicit capped resume path: repeated start joins or reconciles but never relaunches, cancellation tombstones before signalling, and resume is the only operation allowed to create a bounded replacement attempt after positively established process loss. Reject panel admission from a marked panel-member execution at the CLI boundary.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/pair/panel.ts:1058 — current reconciliation reuses terminal legs, leaves live legs, and implicitly relaunches dead/no-result legs without an attempt ceiling.
- src/pair/panel.ts:1093 — `panelStart` already owns durable directories, locking, skeleton-before-spawn, and atomic manifests.
- src/pair/panel.ts:1415 — wait is bounded and read-only but has no cancellation input.
- src/pair/panel.ts:1513 — status already supplies a nonmutating per-leg snapshot.
- src/pair/panel.ts:1619 — prune demonstrates lock-aware, identity-safe retention cleanup.

**Optional** (reference as needed):
- src/pair/panel.ts:716 — PID plus process-start-time validation is the minimum safe signalling discipline.
- test/pair-panel.test.ts:605 — current reconciliation tests provide the failure-before-fix baseline.

### Risks

Admission must be atomic before the first child exists. Explicit cancellation must remain distinct from supervisor crash, and stale IDs or mismatched digests must never attach to or kill unrelated work. A missing pidfile after grace must terminalize rather than keeping wait alive forever.

### Test notes

Pin one request directory, one normal fan-out, same-handle join, digest mismatch refusal, nested-member refusal, partial launch cancellation, no implicit relaunch, capped explicit resume, cancellation races, duplicate cancellation, recycled PID refusal, exact control-artifact teardown, and terminal states for every result outcome including `no_message`.

### Detailed phases

1. Introduce the request/state/attempt schema and atomic reservation path.
2. Separate idempotent start reconciliation from explicit capped resume.
3. Add cancellation tombstones, exact child teardown, and cleanup-failed reporting.
4. Extend status/wait with monotonic request and leg states.
5. Add nested-member admission denial and launch/fan-out budgets.

### Alternatives

A deterministic human slug remains useful for display but is rejected as the ownership key. Unlimited generation relaunch is rejected in favor of explicit bounded recovery.

### Non-functional targets

All state writes are atomic under the existing nonblocking run lock; destructive actions require positive identity; retained histories stay bounded by the established prune policy.

### Rollout

Read existing manifests compatibly for inspection and pruning, but require a reserved request identity for new launches.

## Acceptance

- [ ] One reservation produces one opaque request identity, one durable run directory, and one immutable argument digest before any child launches.
- [ ] Normal start can launch the configured member set once and cannot implicitly create another fan-out or slug.
- [ ] Explicit resume is bounded, uses the same run identity, and only replaces positively dead nonterminal attempts.
- [ ] Cancellation is idempotent, tombstones before signalling, reaches every registered attempt, and prevents later start or resume.
- [ ] Status and wait expose terminal outcomes for missing results, launch failure, `no_message`, timeout, cancellation, and cleanup failure.
- [ ] A panel-member execution cannot admit another panel request.

## Done summary

## Evidence
