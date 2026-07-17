## Description

**Size:** M
**Files:** src/daemon.ts, src/autopilot-worker.ts, src/rpc-handlers.ts, test/daemon.test.ts, test/autopilot-worker.test.ts, test/rpc-handlers.test.ts

### Approach

Audit every `DispatchCleared` producer and capture the exact attempt and incident owners at its decision point. Carry those immutable fences through worker→main messages and the common event-mint path; claimless synthetic incident clears explicitly carry no attempt and can never release a claim.

Keep `retry_dispatch`'s public `{id}` wire unchanged. Main snapshots the current failure episode and attempt-owned rows immediately before append, revalidates producer-carried fences, and logs one bounded mismatch line instead of appending stale authority. Move durable mint-gate deletion after successful append with an exact-attempt predicate. The autopilot worker resets its in-memory failure gate only after matching projection evidence, never before posting.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/daemon.ts:7627-7659` — common mint currently deletes the mint gate before appending a tokenless event.
- `src/daemon.ts:7505-7538` — bus-degraded recovery bypasses the common helper.
- `src/daemon.ts:8397-8524` — RPC, boot-GC, and crash-loop clear paths.
- `src/daemon.ts:9740-9782` and `10514-10533` — worker messages and shared tracker clears.
- `src/daemon.ts:11400-11422` and `12845-12891` — paging, repair, and shared-checkout positive-evidence clears.
- `src/autopilot-worker.ts:1127-1136` and `8376-8385` — typed clear message currently omits fences.
- `src/autopilot-worker.ts:4640-4673` — slot-occupancy producer that caused the verified live race.
- `src/autopilot-worker.ts:9663-9670` — in-memory gate currently resets before main acceptance.

**Optional** (reference as needed):
- `src/autopilot-worker.ts:5184-5234` — finalize positive-evidence clear.
- `src/autopilot-worker.ts:10188-10496` — recover, lane-premerge, and stuck-sentinel clear producers.
- `src/rpc-handlers.ts:931-1017` — key-only public retry RPC to preserve.
- `test/autopilot-worker.test.ts:753-788` — fake clear-message seam.
- `test/daemon.test.ts:488-639` — injected producer tests.

### Risks

- One bypassing direct mint or one message shape that drops a fence reopens the invariant globally.
- Snapshotting the current owner after an asynchronous delay is not fencing; each automatic producer must carry the original observation.
- A stale pre-append diagnostic is optimization/observability only; the Fold must still reject a race after the check.
- Claimless incident rows and exact attempts share a key but not authority; do not synthesize an attempt for distress clears.

### Test notes

Enumerate every production producer in a coverage table. For each class prove matching fences emit, stale fences log/no-op, claimless incidents cannot release a claim, and public retry binds at append. Inject event insertion failure to prove the durable gate remains, and delayed projection evidence to prove the in-memory gate does not reset early.

### Detailed phases

1. Extend worker/main clear messages and centralize owner snapshots in one typed helper.
2. Convert common and direct daemon producers, including RPC, boot, distress, paging, repair, and shared-checkout paths.
3. Convert autopilot slot/finalize/recover/premerge/sentinel producers at their observation point.
4. Reorder durable and in-memory gate release behind exact accepted evidence.
5. Add static/behavioral producer coverage so a future tokenless mint fails the gate.

### Alternatives

- Do not version the public retry RPC; main can bind its key-only request safely at append.
- Do not acknowledge stale worker messages by rebinding them to current state.
- Do not create a second generic clear helper beside the audited common path.

### Non-functional targets

- Producer snapshots and revalidation remain bounded O(1) reads per target.
- Clear failure is fail-open for daemon liveness but fail-closed for ownership mutation.
- Logs name key and mismatched fence without leaking unrelated owner/session detail.

### Rollout

This task activates modern fenced events only after task 1's parser/schema lands. After the epic and fn-1296 land, restart keeperd once so every producer and worker thread runs the same message contract.

## Acceptance

- [ ] Every automatic and human clear producer emits explicit attempt/incident fences captured at the correct pre-delay or append linearization point; no production path emits a tokenless modern clear.
- [ ] `retry_dispatch` retains its public request shape and cannot clear owners that change after its append-point snapshot.
- [ ] Mint-gate deletion occurs only after successful event append and only for the matching attempt; stale or failed append preserves the newer gate.
- [ ] The in-memory worker gate resets only after matching projection evidence, so message loss, stale mismatch, or daemon restart cannot re-arm a newer attempt.
- [ ] Claimless incident clears remain functional but cannot release exact claims/pending rows, and the producer-coverage, daemon, autopilot, RPC, and typecheck suites pass.

## Done summary
Activated attempt- and incident-fenced DispatchCleared carriage at every daemon and autopilot producer, revalidating fences at append and gating in-memory/durable gate resets on matching accepted evidence.
## Evidence
