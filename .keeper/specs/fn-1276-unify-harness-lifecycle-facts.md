## Overview

Establish one evidence-backed lifecycle contract for Claude and Pi while keeping active work, resumable dispatch ownership, and destructive resource cleanup independent. The end state gives readiness, autopilot, autoclose, restore, and transcript settlement the same Harness-activity fact without forcing those consumers to make the same policy decision.

The design uses attempt-fenced Dispatch claims, exact Resource holds, and positive transcript terminality. `/work` and `/close` keep their existing prompts and child-launch behavior; only generic metadata carriage may cross the top-level dispatch boundary.

## Quick commands

- `bun test test/readiness.test.ts test/silent-stream-cut.test.ts test/reducer-projections.test.ts test/autoclose-worker.test.ts test/restore-set.test.ts`
- `bun scripts/audit-session-activity.ts --db "$KEEPER_DB" --readonly`
- `bun run test:full`

## Acceptance

- [ ] Every Claude/Pi lifecycle consumer derives the same `active | quiescent | unknown` Harness-activity result from active main turns, attributable work-bearing children, explicit ambient roles, and positive terminal evidence.
- [ ] A stopped session whose only children are ambient bus or language-service infrastructure consumes no active capacity, while an attributable live child remains active and incomplete evidence remains safely unknown.
- [ ] Dispatch ownership is bound to an exact durable Dispatch attempt; stale starts, callbacks, bus wakes, and cleanup intents cannot mutate or consume a newer claim.
- [ ] A parked claim supports acknowledged warm resume without consuming active capacity, and fresh redispatch cannot occur until the prior attempt is durably revoked and fenced.
- [ ] An intermediate transcript `cut` cannot stop a still-working parent or unlock downstream actions; only invocation-correlated settled terminal evidence can classify `SILENT_STREAM_CUT`.
- [ ] Logical completion and merge no longer depend on pane death or autoclose, while pane/window/lane/worktree teardown remains guarded by exact recycle-safe Resource holds.
- [ ] Autopilot-origin `work` and `close` sessions share reconciler-managed recovery; generic restore remains available for manual and Adopted sessions.
- [ ] Claude/Pi compatibility, legacy unfenced rows, degraded probes, daemon restart, re-fold, and adversarial ordering are covered by fast isolated tests and a read-only corpus audit.
- [ ] `/work` and `/close` prompt, command intent, and child-launch behavior remain unchanged, and Codex/Hermes retain their current lifecycle behavior.

## Early proof point

Task that proves the approach: task 1, `Derive settled harness activity`. If it fails, retain the current readiness classifier and isolate transcript settlement behind an additive compatibility seam before attempting claim or cleanup migration.

## References

- `docs/adr/0055-harness-activity-dispatch-claims-and-resource-holds.md`
- `docs/adr/0013-canonical-generation-identity.md`
- `docs/adr/0017-turn-active-escalation-lifecycle.md`
- `docs/adr/superseded/0031-finalize-defers-on-occupying-closer.md`
- `fn-1262-fix-composite-key-collections-losing` — required composite-key live updates; prerequisite is already landed and done.
- Read-only lifecycle census: 4,151 strict Claude/Pi keeper sessions, including 1,554 work and 709 close sessions.

## Docs gaps

- **docs/install.md**: consolidate autoclose and restore guidance around Harness activity, Dispatch claims, and reconciler-managed work/close recovery.
- **docs/problem-codes.md**: add recovery guidance for unknown activity, stale attempts, ownership loss, transcript settlement failure, and cleanup-precondition conflicts.
- **README.md**: prune or revise lifecycle/restore claims only where the externally observable guarantee changes.

## Best practices

- **Attempt fencing:** validate the expected Dispatch attempt atomically on every owner mutation; expiry alone cannot stop a resumed stale worker. [Kleppmann, Distributed Locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- **Positive terminality:** distinguish turn end, process exit, stream quiet, and provider settlement; do not derive terminal state from temporary silence. [Claude hooks](https://code.claude.com/docs/en/hooks), [Pi RPC](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md)
- **Exact cleanup preconditions:** bind cleanup to the observed resource incarnation and reject stale deletion rather than deleting by path or title. [Kubernetes API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- **Idempotent replay:** commit projected effects and transcript cursor advancement together; duplicate or reordered evidence must converge. [Confluent Idempotent Reader](https://developer.confluent.io/patterns/event-processing/idempotent-reader/)

## Alternatives

- Reusing one `isOccupyingJob` boolean everywhere was rejected because compute capacity, warm-resume ownership, and destructive cleanup require different release conditions.
- Treating a live pane or arbitrary descendant process as work was rejected because ambient bus watchers and language servers outlive active turns.
- Releasing a parked owner after a timeout without fencing was rejected because the old session could wake after its replacement starts.
- Changing `/work` or `/close` launch choreography was rejected because both already share child-wait discipline and the defect is downstream.

## Architecture

```mermaid
flowchart LR
  HE[Claude/Pi lifecycle evidence] --> HA[Harness activity\nactive | quiescent | unknown]
  DI[Dispatch intent] --> DA[Dispatch attempt]
  DA --> DC[Durable Dispatch claim]
  LP[Pane/process/lane probes] --> RH[Resource hold]
  TS[Invocation transcript evidence] --> ST[Settled terminal fact]
  ST --> HA
  HA --> R[Readiness and capacity]
  HA --> A[Autoclose and finalize]
  DC --> D[Same-target dispatch and resume]
  DC --> CR[Crash recovery]
  RH --> A
  RH --> CR
```

The deterministic reducer owns replayable activity inputs and Dispatch claims. Wall-clock, process, pane, and filesystem evidence remains producer-side; consumers receive bounded facts through the existing readiness-input seam. Tmux Generation and pid start-time continue to identify process/resource incarnations and never substitute for Dispatch attempt identity.

## Rollout

1. Land settled transcript evidence and the canonical Harness-activity derivation without removing existing compatibility reads.
2. Add the deterministic Dispatch-claim projection and metadata-only attempt carrier; interpret existing history as legacy-unfenced.
3. Switch readiness, dispatch, warm resume, autoclose, finalize, and restore consumers in dependency order.
4. Run the isolated adversarial matrix and read-only corpus audit before enabling destructive cleanup decisions from the new contract.
5. Keep the schema additive so reverting consumer policy leaves the new projection harmless; retain legacy handling until all pre-change sessions are terminal.
