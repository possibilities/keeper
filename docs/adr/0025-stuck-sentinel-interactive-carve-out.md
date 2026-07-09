# 25. Stuck-sentinel interactive-session carve-out

## Status

Accepted. Amends [ADR 13](0013-jobs-lifecycle-stamp-and-stuck-sentinel.md)'s layer
3 and [ADR 24](0024-stuck-sentinel-orphan-reconciliation.md): tier-two ack-row
minting now excludes a session with no plan linkage; tier-one self-heal is
unchanged for every session kind.

## Context

ADR 13's tier-two detect-only predicate fires on ANY `working` row with a live
pid whose last event is stale past the 1h floor — deliberately universal, since
free-form (non-plan) jobs get no other stuck-state signal. In practice this
also nets a parked-idle interactive human session: nothing is wrong, the human
simply stepped away, but the row is indistinguishable from a genuinely stuck
job. One observed session re-minted its ack-row every 30 minutes (the bounded
re-emit interval) for a full day, requiring repeated operator acks for a
condition that needed none.

## Decision

Tier-two ROW MINTING is carved out at the producer for a session with no plan
linkage — `jobs.plan_ref IS NULL`, which covers every adopted identity too
(neither the hand-started hermes self-seed nor a claimed codex rollout spawns
under a plan verb, so an adopted row's `plan_ref` is null by construction;
`jobs.adopted` is consulted defensively alongside it). Such a row is soft
telemetry: the working/idle contradiction stays observable on the jobs/board
surfaces, but mints no needs-human ack-row. A plan-linked worker session keeps
full tier-two coverage — the class this signal exists to protect.

The carve-out applies ONLY to the stale-working tier-two branch. It does not
touch:

- **Tier-one self-heal** — a worker-done-while-working contradiction is
  corrected for every session kind, interactive or not, since a stale
  `StopReconciled` heal is a projection-consistency fix, not an operator page.
- **The standalone clock-skew detect** — an implausibly-future event or
  lifecycle stamp flags a different anomaly (clock trust), not a stale-working
  contradiction, so it still fires regardless of plan linkage.

This is producer-side only (`selectStuckSentinelVerdicts` and the `sentinelLoop`
row resolution in `src/exit-watcher.ts`); no reducer or idle-stamping change,
since re-folding that state is re-fold-sensitive territory ADR 13 already
fenced off.

## Alternatives rejected

- **Suppress by dwell-time bucket instead of plan linkage.** A longer floor for
  everyone would still page a genuinely stuck free-form job late, or still page
  a human who steps away for exactly the new, longer floor. Plan linkage is the
  correct discriminator: it identifies WHO can self-notice, not how long they
  took.
- **Idle-stamp interactive sessions in the reducer so they read as a distinct
  state.** Rejected per ADR 13's own fold discipline — a fold must never read
  wall-clock, so an idle/parked determination cannot live there. Carving out at
  the producer (which already computes wall-clock age) keeps the reducer pure.

## Consequences

- A parked-idle interactive session (no `plan_ref`, including adopted
  identities) no longer mints a tier-two ack-row; its working/idle
  contradiction remains visible on jobs/board reads, just not as needs-human
  toil.
- A plan-linked worker session's tier-two coverage is byte-identical to before.
- **Accepted risk**: a genuinely wedged adopted/interactive session now loses
  its ack-row too — it relies on the human noticing on their own rather than an
  operator page. This trade is deliberate: soft telemetry over recurring false
  pages, not a correctness gap in tier-one healing.
- One dirty condition still mints exactly one row where it used to mint one per
  30-minute window for a parked-idle session — zero rows now, since the
  condition itself is excluded from ROW MINTING rather than change-gated
  differently.
