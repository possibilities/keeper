## Description

**Size:** M
**Files:** test/reducer.test.ts (deleted), test/reducer-*.test.ts (4 new shards)

### Approach

Mechanically split the 17k-line reducer.test.ts (470 tests, 54 `// ---` section pairs) into ~4 shard files of roughly equal TEST RUNTIME (not line count) along existing section boundaries, named by theme (e.g. reducer-lifecycle, reducer-derivers, reducer-projections, reducer-monitors — pick names from the actual section comments). DUPLICATE the module-level helpers (`insertEvent`, `tsCounter`, the beforeEach/afterEach pair, any section-local helpers) into each shard verbatim — do NOT extract to a shared module: under a single-process run files share module state, so a shared `tsCounter` would shift absolute ts values some tests assume (each shard's private counter starting at 1000 is byte-identical to today). Keep test atomicity: the re-fold-determinism tests (~:337 and ~:2229 in the original — they rewind the cursor + DELETE projections + re-drain on the SAME connection) must keep their seed+rewind+assert together in one shard. Preserve every test title verbatim so failure history greps still hit.

### Investigation targets

**Required** (read before coding):
- test/reducer.test.ts:1-130 — header doc, imports, beforeEach (post-task-.1, already on freshMemDb), insertEvent + tsCounter to duplicate
- test/reducer.test.ts — the `// ---` section comment map (grep `^// ---` for the 108 boundary lines; pair them into ~54 sections and bin into 4 runtime-balanced groups)

**Optional** (reference as needed):
- package.json — confirm shard filenames still match the default `bun test` discovery glob (they will: test/*.test.ts)

### Risks

- A section helper defined mid-file and used by later sections — verify each shard compiles standalone (tsc) before assuming sections are independent.
- Runtime balance is the point: a 4-way split that leaves one 4s shard wastes the parallelism. Time each shard solo and rebalance if max > ~2.5s.

### Test notes

Assert conservation: total test count across the 4 shards equals the original 470 (`bun test test/reducer-*.test.ts` summary line), zero fails, and `git rm` of the original lands in the same commit as the shards.

## Acceptance

- [ ] Original reducer.test.ts removed; 4 shards sum to the original test count, all green
- [ ] Slowest shard <2.5s solo on the dev machine
- [ ] `bun run typecheck` passes (each shard standalone-compiles)
- [ ] Full suite green

## Done summary

## Evidence
