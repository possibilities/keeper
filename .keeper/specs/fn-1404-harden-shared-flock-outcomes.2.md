## Description

**Size:** M
**Files:** cli/commit-work.ts, src/commit-work/flock.ts, src/worktree-git.ts, src/autopilot-worker.ts, src/daemon.ts, src/agent/cwd-ordinal.ts, test/commit-work-foundation.test.ts, test/commit-work.test.ts, test/single-instance-lock.test.ts, test/worktree-git.test.ts, test/autopilot-worker.test.ts

### Approach

Propagate the tagged outcome through integrity-critical root callers. Deadline acquisition may return timeout only when every failed observation positively proves contention; any inconclusive observation contaminates the non-acquired terminal result unless a later attempt actually acquires. Commit publication, worktree merge/recovery, raw ordinal mutation, and daemon admission never enter protected work after Contended or Inconclusive; the daemon keeps its existing incumbent versus degraded exit distinction, while CLI/worktree paths expose a distinct retry-safe inconclusive result instead of collapsing it into timeout or an uncaught exception.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `cli/commit-work.ts:630` — injected acquisition/probe contracts and preview lock states.
- `cli/commit-work.ts:1487` — preview and publication failure-envelope mapping.
- `src/worktree-git.ts:68` — handle-or-null bounded lock seam and lock-timeout result.
- `src/autopilot-worker.ts:9992` — worktree recovery/finalize retry-skip mappings.
- `src/daemon.ts:9312` — typed Single-instance gate classification and bounded diagnostics.
- `src/agent/cwd-ordinal.ts:109` — raw descriptor consumer that must require positive acquisition.

**Optional** (reference as needed):
- `docs/adr/0030-single-instance-gate-and-restart-provenance.md:15` — daemon admission policy.
- `docs/adr/0063-commit-work-explicit-adoption-and-atomic-publication.md:44` — protected publication window.

### Risks

Existing callers use null and throws as overloaded signals, and changing the lock seam can accidentally relabel infrastructure failure as a live holder. Worktree merge and recover paths must prove that neither Git mutation nor cleanup ran after an inconclusive acquisition. Preserve concurrent edits already moving through `src/daemon.ts` by working from the task lane's current base rather than replaying a stale local diff.

### Test notes

Drive caller seams with Acquired, Contended, Inconclusive, mixed deadline histories, zero deadlines, interruption, and release faults. Assert exact result/problem categories, no Git/DB/ordinal mutation on non-acquisition, daemon exit 1 for positive incumbent contention, exit 2 for inconclusive acquisition, and successful work after an acquired handle.

### Detailed phases

1. Upgrade commit-work deadline and probe interfaces to typed outcomes with honest mixed-observation classification.
2. Thread the outcomes through CLI publication and worktree merge/recovery retry policy.
3. Migrate daemon admission and raw descriptor consumers, then update focused policy tests.

### Alternatives

Mapping Inconclusive to the existing timeout/null path is rejected because it lies about positive contention. Immediate fatal process termination is also rejected where a typed retry-safe refusal or level-triggered defer already exists.

### Non-functional targets

No non-acquired path performs Git, DB, or ordinal mutation. Backoff remains bounded and jittered, diagnostics remain byte/line bounded, and daemon admission still occurs before DB open, migration, worker spawn, or boot-ledger append.

### Rollout

Preserve existing successful and positive-contention external behavior where truthful, add the inconclusive variant additively, and keep all callers exhaustive so TypeScript prevents a new outcome from falling through.

## Acceptance

- [ ] Commit-work preview and publication distinguish positive lock contention from inconclusive lock infrastructure and perform no publication work in either case.
- [ ] A bounded deadline reports timeout only after exclusively contended observations; mixed or wholly uncertain observations report Inconclusive unless acquisition later succeeds.
- [ ] Worktree merge, recovery, and finalize defer safely with a distinct inconclusive reason and execute no Git mutation before positive acquisition.
- [ ] Daemon admission preserves acquired, incumbent-refused, and inconclusive-degraded outcomes with distinct fail-closed exits before any DB or ledger effect.
- [ ] Raw descriptor mutation paths require Acquired and release their exact handle on every completed protected operation.

## Done summary

## Evidence
