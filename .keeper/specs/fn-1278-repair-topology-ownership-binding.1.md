## Description

**Size:** M
**Files:** src/tmux-control-worker.ts, src/tmux-focus-derive.ts, test/tmux-control-worker.test.ts, test/tmux-focus-derive.test.ts, test/reducer-projections.test.ts, test/restore-set.test.ts

### Approach

Extend the connected tmux-control lifecycle so a jobs-projection change can request one serialized topology reread while the physical tmux layout remains steady. Use the sanctioned read-only SQLite change-detection seam with coalescing and post-refresh recheck semantics: a commit during watcher initialization or an in-flight reread must leave another refresh pending, while unrelated write bursts collapse to bounded work and true duplicate topology remains silent.

Make pane ownership part of the topology dedup identity. Unowned-to-owned, owned-to-unowned, and job-A-to-job-B transitions for one exact pane are semantic changes; stable row ordering keeps true duplicates deterministic. A pane claimed by more than one live job is ambiguous and remains unattributed rather than choosing by iteration order. Preserve the current null-Generation, empty-pane, read-fault, no-live-job, terminal-state, and cross-Generation recycle guards. The repair ends once the attributed topology event reaches the existing Fold and stamps the live matching job's Generation; downstream autoclose classification is unchanged.

Open question: instrumentation for a successful DB-only ownership repair is optional; prefer existing bounded worker diagnostics unless a new signal materially aids operator recovery.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/tmux-control-worker.ts:324-356` — existing live-job to pane ownership join and the correct ambiguity-policy seam.
- `src/tmux-control-worker.ts:731-750` — connection-scoped dedup and serialized reread state.
- `src/tmux-control-worker.ts:808-851` — dirty/redirty coalescing that must absorb DB-only refresh requests without overlap.
- `src/tmux-control-worker.ts:904-929` — current topology emission gates and physical-topology-only dedup.
- `src/tmux-focus-derive.ts:178-224` — shared topology shape and hash contract that currently hides ownership transitions.
- `src/reducer.ts:3187-3265` — existing live-only Fold that adopts Generation from a later matching snapshot.
- `src/wake-worker.ts:94-163` — sanctioned `PRAGMA data_version` polling and shared NOTADB tolerance pattern.

**Optional** (reference as needed):
- `test/tmux-control-worker.test.ts:691-852` — ownership mapping and dual-source hash fixtures.
- `test/tmux-control-worker.test.ts:884-1049` — synthetic connected-control reread and dedup harness.
- `test/tmux-focus-derive.test.ts:324-364` — hash behavior assertions that currently encode ownership irrelevance.
- `test/reducer-projections.test.ts:5993-6218` — Generation adoption, terminal, absent-pane, and recycle guards.
- `src/restore-set.ts:936-946` and `test/restore-set.test.ts:2037-2066` — established unattributed/attributed topology-pair contract.

### Risks

A hash change without a connected DB wake leaves the original race intact. A wake path without post-refresh version rechecking can move the lost-wakeup window instead of closing it. Polling every database commit without coalescing can overload the tmux control stream, while choosing one of several jobs claiming a pane can attach the wrong Generation. Reconciliation must remain producer-side and live-only; no Fold may read wall-clock, environment, filesystem, process liveness, or tmux.

### Test notes

Drive one deterministic schedule where the first control reread sees a pane and no job, then a DB-only job appearance occurs with byte-identical physical topology. Assert a second ownership-attributed topology post, ordered Fold adoption of the canonical Generation, and no third post on a true duplicate. Cover commits during watcher setup and an in-flight reread, burst coalescing, restart/bootstrap recovery, ownership removal and transfer, ambiguous duplicate pane claims, read failure, pane disappearance, terminal jobs, and cross-Generation reuse. Use in-memory databases, scripted control children, injected barriers, and `retryUntil`; never real tmux, subprocesses, Workers, sockets, or fixed sleeps.

## Acceptance

- [ ] A connected worker emits an attributed topology observation after a live job claims an already-observed pane, without requiring a tmux structural notification.
- [ ] The attributed observation folds after SessionStart and stamps the live job with the exact current canonical Generation.
- [ ] Ownership transitions change the topology dedup identity, while row reordering and true duplicate ownership/topology observations remain no-ops.
- [ ] A DB change during watcher setup or an in-flight refresh is followed by a final-state refresh; sustained unrelated writes are coalesced into bounded serialized rereads.
- [ ] More than one live job claiming a pane produces no ownership attribution, and terminal, missing-pane, malformed, degraded, and recycled-Generation cases remain non-destructive.
- [ ] Existing restore handling still accepts unattributed then attributed snapshot pairs, and focused plus root fast suites pass in process isolation.

## Done summary
Added ownership as part of the topology dedup identity and a connected DB-only reconciliation reread path (PRAGMA data_version watch with coalesced, post-refresh-recheck serialized rereads), so a pane observed before its job exists is re-attributed once the job commits without needing a tmux structural change. The attributed topology event now stamps the live matching job's canonical Generation via the existing Fold. Ambiguous multi-job pane claims, malformed/degraded observations, absent panes, terminal jobs, and cross-Generation reuse remain fail-closed.
## Evidence
