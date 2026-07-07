# 13. Canonical generation identity

## Status

Accepted.

## Context

A **generation** is one tmux server boot — the cohort crash-restore scopes to —
keyed by the `#{pid}:#{start_time}` probe (pid alone would alias a new server
that reused an OS pid; start_time is the recycle guard). Two independent
producers minted generation-id strings:

- the restore-worker boundary pulse (`probeServerGeneration`), which validated
  the probe to `pid:start_time` with both fields positive integers, and
- the tmux-control-worker topology stream, which ran its OWN inline
  `display-message` and accepted any non-empty `.trim()`ed line verbatim.

Because the topology stream did not validate, a probe that returned anything but
a clean `pid:start_time` (a bare pid, a start_time-less line) would be stored as
a `tmux_generation_id` the boundary pulse would have rejected — so the SAME boot
could be recorded under two different ids. The v107 generated column groups the
summary walk on the stored id, so a split boot surfaces as TWO competing
generations in `keeper tabs list` and the restore selection. The 2026-07-07
incident is the shape of the hazard: generation identity must not be forkable by
one emitter's format drift.

## Decision

Generation identity is keeper-owned through two seams.

- **One builder is the sole producer.** `buildGenerationId` (`src/exec-backend.ts`)
  mints the generation-id string from a raw probe; every emitter — the
  restore-worker boundary pulse (`probeServerGeneration`), the boot seed (which
  goes through the same pulse probe), and the tmux-control-worker topology
  stream — mints through it. The format can therefore change in exactly one
  place, so it can never fork one boot into two. The builder emits ONLY the
  current `pid:start_time` form; a bare-pid parse is a read-time legacy artifact,
  never freshly written.
- **A read-time canonicalizer folds a split boot back together.**
  `canonicalizeGenerationSummaries` (`src/restore-set.ts`) folds summary rows that
  name one boot under more than one stored id into a single canonical generation
  AFTER the index-served GROUP BY — grouping stays on the stored column
  (`GENERATION_SUMMARY_SQL`, index-served), and the fold is on its RESULT, so the
  v107 index path is untouched. A legacy bare-pid id aliases onto the full-form
  `pid:start_time` sibling sharing its pid; a full-form id with a DIFFERENT
  start_time stays a distinct boot (the recycle guard holds). `parseGenerationId`
  is the one parse rule both seams share, so the producer and the canonicalizer
  cannot disagree on what a generation id is.

## Consequences

- A legacy bare-pid row already in a DB aliases onto its full-form sibling WHERE
  DERIVABLE (a full form with the same pid is in the decode window); a bare id
  with no derivable sibling stays its own generation and AGES OUT of the newest-K
  decode bound as fresh boots arrive — never data loss, just eventual exclusion
  from the auto-restore offer.
- The decode unions every stored id folded into a canonical generation, so a
  boot's peak pane count, restorable set, and newest-attributed snapshot reflect
  all of them; the restore set is the newest snapshot across the whole boot,
  regardless of which stored id recorded it.
- Going forward no new split can be created (the builder mints one format), so
  the canonicalizer is a compatibility seam for pre-existing rows and a standing
  defense against any future probe-format change — not a routine hot path.
