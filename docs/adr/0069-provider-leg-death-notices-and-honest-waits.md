# 0069 — Provider-leg death notices and honest waits

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022. Builds on
[ADR 0048](0048-file-backed-agent-bus-messages.md),
[ADR 0051](0051-panel-run-ownership-and-task-cancellation.md), and
[ADR 0056](0056-wrapped-provider-leg-window-lifecycle.md).

## Context

A wrapped cell blocks while its Provider leg works. Today the capture path can
serve a prior turn's cached stop, or wait until timeout after the exact leg has
already died. The wrapper also receives no immediate signal when the folded job
transition proves that leg ended or was killed.

The Agent Bus is a low-latency same-host rail, not durable lifecycle truth. A
Provider-leg title identifies its Plan Task scope but is not ownership identity,
and the durable wrapper-attempt-to-leg edge belongs to separate lifecycle work.
Side effects and process evidence cannot enter a deterministic Fold.

## Decision

1. **Durable pull is authoritative.** Run-id capture handles retain the exact
   Keeper job identity and a resume-safe transcript boundary. `agent run`,
   `agent wait`, and `wait-for-stop` re-derive that job's folded lifecycle while
   waiting for transcript creation and for the current turn's settled stop. A
   terminal job without a fresh stop returns immediately instead of consuming
   the timeout. A direct transcript-path handle has no lifecycle identity and
   therefore never claims death from missing evidence.
2. **Fresh completion wins.** A settled stop proven to belong to the current
   invocation yields the normal completed or no-message result even when clean
   SessionEnd evidence follows it. Prior-turn stops and messages never satisfy a
   resumed invocation. Unknown liveness remains unknown; it never becomes death.
3. **Death is a typed capture outcome.** `partner_died` joins the existing
   nine-key run-capture envelope and carries exact identity plus bounded fresh
   text. Its `message` may state terminal kind and reason as prose; callers bind
   the outcome, never parse that prose. Retryable exit 4 means resume or relaunch
   the partner, never re-wait on the dead handle. The unchanged key set keeps the
   schema version unchanged. This is an outcome, not a problem code.
4. **Push is a producer fast path.** After an authoritative transition moves a
   wrapped Provider leg to `ended` or `killed`, a daemon producer emits one
   size-bounded, versioned JSON Bus artifact keyed by the terminal event id. It
   includes the Provider-leg job id, task reference, terminal kind, event id,
   transcript path when known, and bounded failure detail. Ordinary transcript
   Stop is not death, and launch failure before a job exists remains the
   synchronous `launch_failed` capture outcome.
5. **Delivery is owner-only and fail-safe.** The interim resolver uses the
   existing wrapped task linkage only to find one live `work::<task>` wrapper
   whose Dispatch-attempt window — claim bind through attempt terminal or
   superseded — encloses the leg's birth; process lifetime never counts. Zero or
   multiple candidates means no delivery. `send_only` never creates Presence,
   takes over a watch channel, or queues for an offline or replacement wrapper.
6. **Best-effort means at-least-once while live.** A bounded producer retry may
   duplicate an ambiguously acknowledged send, so the terminal event id is the
   idempotency key. A boot event-id fence prevents historical replay. Boot-seeded
   or late-ingested deaths mint post-fence events and may notify late by design.
   Projection-backed pull remains correct when every push is lost.
7. **Immediacy is independent of scheduling.** The producer runs on the next
   healthy post-fold daemon tick, including while Autopilot is paused. Bus
   startup or degradation may delay or lose only the push; neither Fold progress
   nor capture correctness depends on delivery. Owner-only routing plus the live
   wrapper cap bounds fan-out, so no coalescing delay is introduced.

## Consequences

- Wrappers stop waiting against proven corpses and cannot mistake an earlier
  turn's answer for the current one.
- A live wrapper normally learns of Provider-leg termination within one daemon
  reconciliation tick, while bus outages degrade to the durable pull contract.
- Clean completion and abrupt death stay distinguishable without coupling the
  wrapper's lifetime to the Provider leg.
- The notice rail does not authorize teardown, transfer ownership, release a
  Dispatch claim, or replace the later durable ownership-and-cascade design.
