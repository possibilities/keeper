## Description

**Size:** M
**Files:** src/types.ts, src/readiness.ts, src/readiness-client.ts

### Approach

Epic Scrub standard + Verification recipe. types.ts (~600 deletable; 83% comment density): trim the giant per-interface JSDoc (e.g. the 88-line JobLinkEntry block) to the paired-NULL invariants (floor item 11) and the enrichment-boundary constraint; delete schema-version provenance and future-extensible boilerplate. readiness.ts (~300): delete the predicate-pipeline narrative that mirrors the code; compress the predicate RANK ORDER constraint (floor item 6) into a short table that survives; per-BlockReason docs become one-liners without fn refs. readiness-client.ts (~250): delete helper role walkthroughs. DO NOT touch the biome-ignore at readiness-client.ts:690 or its code line. fn-775 recently landed changes in readiness-client.ts and cli/await.ts — scrub what exists at HEAD when the task runs, not what the inventory described.

### Investigation targets

**Required** (read before coding):
- The epic spec (planctl cat) — Scrub standard, sacred floor, Verification recipe

### Risks

readiness rank-order comment is the difference between a working and silently-broken autopilot — keep it crisp and intact.

### Test notes

Per recipe; test:full mandatory.

## Acceptance

- [ ] Verifier passes post-format on all three files; typecheck + biome + test:full green, zero new failures
- [ ] Floor items 6 and 11 present; biome-ignore at readiness-client.ts:690 untouched
- [ ] Done summary reports lines and chars deleted

## Done summary
Comment-only scrub of src/types.ts, src/readiness.ts, src/readiness-client.ts: deleted 1625 bloat comment lines (-103889 chars) — fn-NNN/schema-vNN provenance, incident narration, per-field essays. Kept floor item 11 (paired-NULL invariant, types.ts) and floor item 6 (readiness predicate rank-order, readiness.ts); all 5 biome-ignore directives untouched. Verifier token+transpile equality proven post-format; typecheck + targeted tests + test:full green (one SIGTRAP native-worker flake in untouched daemon.test.ts, passed clean on isolated re-run).
## Evidence
