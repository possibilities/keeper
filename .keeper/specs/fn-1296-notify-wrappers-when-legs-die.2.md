## Description

**Size:** M
**Files:** src/daemon.ts, src/autoclose-worker.ts, src/provider-leg-death-notice.ts, cli/bus.ts, test/provider-leg-death-notice.test.ts, test/autoclose-worker.test.ts, test/bus-worker.test.ts, test/bus-identity.test.ts

### Approach

Add a producer-side, post-fold notice sweep for wrapped Provider-leg jobs that authoritatively transition to `ended` or `killed`. Reuse the existing wrapped task parser and Agent Bus chat artifact/send acknowledgement path, but send through a transient `send_only` registration so keeperd never establishes Presence or takes over a wrapper's watch channel.

Interim recipient resolution is deliberately fail-safe until the durable ownership-edge epic: only one live `work::<task>` wrapper whose Dispatch-attempt window—from claim bind through attempt terminal or superseded—encloses the Provider leg's birth may receive the notice; process lifetime never qualifies a stale resident wrapper. The body is one bounded versioned JSON object keyed by terminal event id. A boot event-id fence excludes historical terminal rows while allowing post-fence seed-killed or late-ingested discoveries; bounded live memo/retry state permits at-least-once delivery without an unbounded Fold or durable queue.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/autoclose-worker.ts:89-95` — canonical and legacy wrapped Provider-leg task-title recognition.
- `src/autoclose-worker.ts:340-362` — wrapped bucket combines birth session with task linkage; extract/reuse rather than drift-copy.
- `src/exit-watcher.ts:83-98` — live process exit posts the synthetic-kill input consumed by main.
- `src/seed-sweep.ts:120-142` — boot discovery mints new killed evidence for dead jobs.
- `src/daemon.ts:1525-1625` — injectable producer sweep shape and fail-open per-item handling.
- `src/daemon.ts:12381-12430` — daemon tick integration for an existing notification sweep.
- `cli/bus.ts:858-960` — connect/register(send_only)/publish/ack/close transport and ambiguity classification.
- `src/bus-worker.ts:1171-1249` — `send_only` admission must not join the registry or persist Presence.

**Optional** (reference as needed):
- `src/bus-identity.ts:290-390` — exact target resolution and offline/ambiguous outcomes.
- `src/bus-artifact.ts:58-131` — typed, versioned, confined Bus artifact references and size bounds.
- `docs/adr/0069-provider-leg-death-notices-and-honest-waits.md` — accepted delivery and ownership limits.

### Risks

- Title/task linkage is not durable ownership; Dispatch-attempt enclosure and uniqueness must fail closed rather than use a stale process lifetime.
- A daemon restart must not replay every historical terminal Provider leg.
- Ambiguous publish acknowledgement can duplicate delivery; terminal event id must make duplicates harmless.
- Mass termination must not block the daemon loop or emit an unbounded burst in one tick.
- Bus failure is non-fatal and must not block Fold progress, readiness, or Autopilot.

### Test notes

Keep producer selection, boot fencing, ownership resolution, payload bounding, retry disposition, and dedup pure/injected. Prove no real daemon, Worker, UDS, Tmux, or subprocess is required. Reuse existing Bus truth tables to pin that a daemon-origin send-only registration emits no join, no persisted channel, and no takeover.

### Detailed phases

1. Share the wrapped Provider-leg task parser and define the versioned bounded notice payload.
2. Implement pure candidate selection, unique Dispatch-attempt wrapper resolution, boot fence, per-tick cap, and bounded idempotency/retry decisions.
3. Bind a bounded daemon sender to the existing chat artifact and `send_only` publish/ack contract.
4. Integrate the producer after Fold progress and independently of Autopilot pause.

### Alternatives

- Do not queue for wake or persist a durable retry: the interim task link cannot safely target replacement attempts.
- Do not send from reducer code or let delivery failure affect cursor advancement.
- Do not resolve the recipient from the Provider leg's bare title; target only the unique wrapper work identity.

### Non-functional targets

- Under a healthy bus, an eligible transition is attempted on the next daemon producer tick.
- Candidate processing and live memo state remain constant-bounded per tick and per recent event horizon.
- Payload detail and total bytes are capped, with explicit truncation and no shell/NDJSON interpolation.

### Rollout

The new producer starts with a boot fence and no historical replay. After finalize, one keeperd restart loads it; a disposable wrapped-leg death smoke confirms the push while the pull rail remains the fallback. No schema migration or RPC is introduced.

## Acceptance

- [ ] Each post-fence authoritative `ended` or `killed` transition for a wrapped Provider leg yields an immediate versioned, bounded notice attempt addressed only to one uniquely eligible live wrapper; ordinary transcript Stop and pre-job launch failure do not.
- [ ] The daemon send uses the Agent Bus `send_only` path and cannot create Presence, persist a live channel, emit join, or evict/take over a wrapper watcher.
- [ ] Historical rows, offline or ambiguous wrappers, replacement attempts outside the leg's lifetime, and stale/rejected terminal events never receive a notice; seed-killed post-fence deaths remain eligible.
- [ ] Delivery failure is fail-open for the daemon, bounded ambiguous retry is deduplicable by terminal event id, and all named producer/Bus/autoclose tests pass.

## Done summary

## Evidence
