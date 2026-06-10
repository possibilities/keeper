## Description

**Size:** M
**Files:** src/reducer.ts

### Approach

Apply the epic Scrub standard (planctl cat the epic first; follow the Verification recipe exactly). Targets in this file (~1,400 of 4,368 comment lines): the state-machine table JSDoc near the top that mirrors the code structure; per-column origin stories ("schema v29 added..."); inline paraphrases of query shapes; all fn-NNN refs (~167) and tombstone narration. KEEP (floor items 1-3): the re-fold determinism block, exactly-once transaction comments, the syncEpicDepsForward order-dependency block (~lines 912-930), ON CONFLICT carve-out rationale — compressed, future-facing.

### Investigation targets

**Required** (read before coding):
- The epic spec (planctl cat) — Scrub standard, sacred floor, Verification recipe

### Risks

reducer.ts is the fold heart — token-sequence equality is non-negotiable; revert-and-retry once on verifier failure, then escalate.

### Test notes

Pre-scrub `bun run test:full` baseline; post-scrub zero new failures; verifier + typecheck + biome per recipe.

## Acceptance

- [ ] Verifier passes post-format on src/reducer.ts; typecheck + biome + test:full green, zero new failures
- [ ] Sacred floor items 1-3 present and future-facing; zero fn-NNN refs remain in the file
- [ ] Done summary reports lines and chars deleted

## Done summary

## Evidence
