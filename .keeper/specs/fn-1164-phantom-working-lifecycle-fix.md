## Overview

Make the jobs lifecycle fold correct under out-of-order event ingestion so a stale
straggler event can never permanently resurrect a stopped job to working
(phantom-working), give idleness a positive fold signal, and add a producer-side
sentinel so any future divergence between board state and session reality is loud
instead of silent. The contract is recorded in docs/adr/0013 — the lifecycle stamp
gate with a remove-biased equal-ts tiebreak, idle_prompt as positive idle evidence,
and a two-tier stuck-state sentinel with sticky-until-ack anomaly rows.

## Quick commands

- `bun test test/reducer-lifecycle.test.ts` — the fold state-machine suite, including the new permutation cases
- `bun test test/refold-equivalence.test.ts` — byte-identical re-fold gate over the corpus
- `bun test test/schema-version.test.ts` — SCHEMA_VERSION whitelisted in keeper/api.py
- `bun test` — full fast suite green

## Acceptance

- [ ] Final jobs.state is identical across all ingest orderings of a turn-final event set (stale stragglers annotate, never resurrect)
- [ ] An idle_prompt Notification folds a working row to stopped behind the same guards as Stop
- [ ] The sentinel self-heals the worker-done-but-working contradiction and mints sticky anomaly rows cleared only by operator ack
- [ ] The rewinding migration re-derives the stamp by replay; migrated-in-place and from-scratch folds agree

## Early proof point

Task that proves the approach: ordinal 1 (the stamp gate + permutation tests). If the
shared-helper routing proves too invasive across the state-writing arms, fall back to
gating only the three un-stop arms plus Stop in one release and follow with the rest.

## References

- docs/adr/0013-jobs-lifecycle-stamp-and-stuck-sentinel.md — the settled contract; the tiebreak MUST stay semantic (never event.id)
- CONTEXT.md glossary: "Lifecycle stamp", "Phantom-working", "Distress row" — use these terms exactly
- Community grounding: remove-biased LWW-Element-Set tiebreak; equal-ts ties are a hot path for racing same-host writers; DDL-only migration + replay-derived state (never SQL back-fill)

## Docs gaps

- **README.md**: add the stuck-state sentinel to the System map producers line in place (owned by ordinal 3)

## Best practices

- **Name the tiebreak in comments as remove-biased LWW** citing ADR 0013, so a future reader does not symmetrize it into an ingest-id tiebreak [practice-scout]
- **Test the equal-ts tie directly** — ms-granularity collisions between racing writers are routine, not rare [practice-scout]
- **Change-gate sentinel emissions** (first-detect + reason-change + bounded still-stuck re-emit), never per poll tick [DispatchFailed producer precedent]
- **Page on anomaly rather than silently correct** — the sticky row is the point; a self-tidying corrector masks the fold bug [practice-scout]
