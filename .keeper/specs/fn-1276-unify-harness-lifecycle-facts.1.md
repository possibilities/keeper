## Description

**Size:** M
**Files:** src/session-activity.ts, src/readiness.ts, src/readiness-inputs.ts, src/subagent-invocations.ts, src/derivers.ts, src/transcript-worker.ts, src/reducer.ts, test/readiness.test.ts, test/derivers.test.ts, test/silent-stream-cut.test.ts, test/transcript-worker.test.ts, test/reducer-projections.test.ts

### Approach

Introduce one pure, reason-carrying `active | quiescent | unknown` Harness-activity derivation over existing parent, subagent, and background-task evidence. Attribute work through canonical invocation/provenance helpers, exclude ambient infrastructure semantically, preserve launch/bind reservations as a separate fact, and treat stale or incomplete evidence as unknown rather than idle.

Make transcript cut/clean evidence invocation-correlated and provisional until its provider-specific terminal boundary settles. An intermediate `tool_use`/null cut must not flip the parent to stopped; true settled cuts still flow through the lifecycle-stamp gate, and terminal parents override orphan open-child artifacts.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/readiness.ts:1360-1406` — current canonical occupancy predicate and reason ranking.
- `src/readiness.ts:2165-2208` — `bound-pending` bridge and stopped-after-working distinction.
- `src/readiness-inputs.ts:77-160` — shared anti-drift input loader for readiness, autopilot, and autoclose.
- `src/transcript-worker.ts:318-371,840-848` — per-turn disposition emission and the intermediate-cut race.
- `src/reducer.ts:5950-6039` — SubagentStop consumption of the latest cut/clean disposition.
- `src/subagent-invocations.ts` and `src/readiness.ts:577-590` — canonical open-turn semantics.

**Optional** (reference as needed):
- `plugins/keeper/pi-extension/keeper-events.ts:209-300` — Pi lifecycle translation and settlement limitations.
- `src/reducer.ts:123-151` — polarity-aware lifecycle-stamp gate.
- `test/silent-stream-cut.test.ts:134-259` — current cut-before-stop, clean, late-cut, and replay fixtures.

### Risks

A single activity API must not erase consumer-specific policy or reinterpret pending launch as an active model turn. Transcript evidence may arrive out of order, and a correction after a false stop is insufficient because downstream consumers could already act; provisional evidence must prevent the false transition.

### Test notes

Add a table matrix covering main-turn activity, multiple open/terminal children, explicit ambient bus children, worker monitors, long-running/stale evidence, malformed evidence, launch reservations, and terminal parent override. Add the missing intermediate-cut → SubagentStop → later-clean schedule and its reverse ordering, plus a positive true-cut control and deterministic re-fold.

### Detailed phases

1. Define the pure Harness-activity result and reason vocabulary without changing consumers.
2. Normalize subagent/background provenance and explicit ambient classification through existing helpers.
3. Make transcript disposition settlement invocation-scoped and gate parent lifecycle transitions on settled evidence.
4. Route readiness through the canonical derivation while preserving pending/bound launch reservations.
5. Lock the transition table with isolated reducer and parser tests.

### Alternatives

Hard release ceilings were rejected as terminal evidence: they can label a genuinely long-running child idle. Raw process-tree scanning was rejected because language servers and bus infrastructure are not work.

### Non-functional targets

The derivation is deterministic, side-effect-free, and bounded by the already-bounded child collections. Reducers read no clock, filesystem, environment, or process state, and transcript diagnostics never include transcript content.

### Rollout

Land the new derivation behind existing input shapes and retain reason-compatible readiness behavior where the new contract does not intentionally differ. A revert can restore the former classifier without a schema downgrade.

## Acceptance

- [ ] One pure API returns reason-carrying `active`, `quiescent`, or `unknown` Harness activity for Claude and Pi evidence.
- [ ] Active main turns and attributable open children are active; explicit ambient infrastructure is quiescent; stale/incomplete evidence is unknown; terminal parents are terminal regardless of orphan child rows.
- [ ] Pending and bound dispatch windows remain capacity reservations without being mislabeled as active model turns.
- [ ] Intermediate cut evidence followed by clean settlement never stops the still-working parent or unlocks downstream readiness.
- [ ] Settled true cuts still stop the parent exactly once, and reordered/duplicate transcript events converge under re-fold.
- [ ] Focused readiness, deriver, transcript, and reducer suites pass without daemon, subprocess, tmux, socket, or live-transcript access.

## Done summary
Added a canonical reason-carrying Harness-activity derivation (active|quiescent|unknown) over parent, subagent, and background-task evidence, split from Dispatch reservations. Transcript cut/clean settlement is now invocation-correlated and provisional, so an intermediate cut can no longer stop a still-working parent while a settled cut still recovers it exactly once; terminal parents override orphan open-child rows.
## Evidence
