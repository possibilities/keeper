# 0071 — Durable wrapper→Provider-leg ownership and terminal cascade

Status: Accepted (provisional number; renumber at fan-in)

## Context

A wrapped cell's Provider leg is a paid process whose only lifecycle ties have been
display metadata and interim inference: ADR 0069's death notices are informational,
ADR 0056's autoclose converges stopped windows from birth-session + title shape, and
nothing durably records which wrapper attempt owns which leg. Orphaned legs hold live
Dispatch and file claims, block commits, and burn provider quota; releasing them has
required operator forensics or process kills. ADRs 0068/0069/0070 landed vacated
claims, honest waits, and attempt/incident-fenced clears — the durable ownership edge
and its teardown authority are the missing piece.

## Decision

- **Owner tuple.** Every wrapped Provider-leg birth carries `(wrapper_job_id,
  wrapper_dispatch_attempt_id)` plus an immutable `leg_launch_id` and the launcher's
  pid + start-time, in a versioned birth record. An ownerless or malformed wrapped
  launch aborts before spawn. Legacy records are classified by protocol version,
  never by null-field inference. Provider process identity (pid + start-time) stays a
  distinct concept from the owner tuple and is never called Generation.
- **Identity precedes the paid process.** The launcher spawns a keeper shim (no paid
  work), promotes the shim's pid + start-time as the leg identity, and the shim
  `exec`s the provider — exec preserves both — only on a one-use grant issued after a
  pre-exec recheck that the exact claim is still bound and the wrapper is neither
  terminal nor superseded. Promotion failure exits the shim before exec: no paid
  process exists. The daemon ingests birth records from `pending/` as well as `new/`,
  idempotent on `leg_launch_id`. Keeper never adopts or signals a process it did not
  launch; the shim-phase pane carries a recognized command signature so pane
  classifiers do not misread it.
- **Cascade authority.** A folded wrapper-terminal OR durably-superseded transition,
  proven against the exact owner tuple, authorizes teardown of that attempt's legs.
  The cascade is producer-side and level-triggered from two projections:
  `provider_leg_ownership` (the registry — owner tuple, ownership-epoch event id,
  identity, pane/generation coords captured at birth) and `provider_leg_cascades`
  (per-incident progress: TERM/KILL armed + sent timestamps, an explicitly stored
  kill-not-before deadline, attempt counts, blocked reason, page-once
  `human_notified_at`). Signal events are written ahead of delivery and identity is
  re-probed before each signal; the idempotency key is the owner tuple +
  `leg_launch_id` + ownership-epoch event id, with phase + attempt ordinal per
  signal effect.
- **Exit proof.** Only the leg's own folded terminal event, or a recycled exact
  pid + start-time observation, confirms exit — never a syscall return. A recycle
  observed within ~1s of the recorded start-time additionally requires a
  corroborating signal (pane generation change or command mismatch) because macOS
  start-times are second-granular. Unknown identity or an unconfirmed KILL blocks
  visibly and never releases claims.
- **Release and transfer.** Claims release only via exact-tuple
  `DispatchClaimReleased`, after every owned leg is exit-confirmed, transferred, or
  aborted; the release fold re-verifies those conditions itself. A closing wrapper
  goes terminal, cascades, then releases — never release-first. Transfer is one
  fenced old→new transition, refused once terminal proof exists or TERM is armed;
  stale transfers no-op. Exclusive file claims never transfer with leg ownership.
- **Single teardown actuator.** Owned-leg window teardown belongs to the cascade
  reconciler (terminal job rows null their pane ids, hence birth-captured coords).
  The ADR 0056 wrapped autoclose bucket serves only the legacy ownerless cohort and
  is deleted once that cohort drains to zero, verified by query, never by calendar.
- **Operator recovery.** Identity-unknown and kill-unconfirmed mint page-once
  stickies; the legacy cohort is a display-only drain gauge. The only manual effect
  is exact identity-rechecked termination — no force-release verb exists. If the
  permanently-blocked tail proves intolerable, a future disown verb may transfer
  (never release) one leg to operator ownership, refused while its identity probes
  live.

## Consequences

Supersedes ADR 0056's teardown authority for owned legs and fills ADR 0069's durable
ownership placeholder; both gain pointers here. The death-notice producer and the
cascade react to the same terminal fold, so their operator paging coordinates per
incident. New problem codes cover the cascade stickies. One schema step adds the
birth-record fields and projections; version assigned at merge per ADR 0020.
