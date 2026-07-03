## Description

Finding F7. Evidence path: `src/restore-set.ts` `loadEnrichedGenerations`
runs the cheap index-only summary walk (`summarizeGenerationsIndexOnly`)
then `raws.map((raw) => enrichGeneration(...))` — decoding the snapshots of
EVERY historical generation — before `deriveLastGenerationSetFromTopology`
slices to the newest `RECENT_GENERATION_BOUND` (5). Retention keeps all
snapshot rows unconditionally, so `keeper tabs restore` / `list` decode the
entire retained snapshot history each run, where the replaced path bounded
the scan at `DYING_GENERATION_SCAN_LIMIT = 256`. It is a one-shot CLI read
(not a fold, no re-fold time-bomb) and the restore-worker pulse builds from
live `jobs`, not this path — severity is low — but the read grows unbounded
on a long-lived host. Enrich lazily: run the index-only summary walk, rank
newest-first, slice to the newest K non-current generations, and decode
snapshots only for those. Preserve the existing selection semantics
(idle-cutoff filter, degenerate exclusion, ambiguity flag) exactly.

## Acceptance

- [ ] The auto-pick / list path decodes snapshots only for a bounded set of generations, never the full retained history.
- [ ] Selection output (auto-pick, ambiguity flag, degenerate-skeleton exclusion, list ordering) is unchanged versus the current behavior on existing fixtures.

## Done summary

## Evidence
