## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/server-worker.ts, src/derivers.ts, src/collections.ts, src/exec-backend.ts

### Approach

Epic Scrub standard + Verification recipe. autopilot-worker.ts (~250): the incident narratives become one-line present-tense rationales; the UNIT TRAP warning appears ~4 times — keep it ONCE, prominently, where the constants are declared (floor item 7); the cooldown ordering chain (floor item 8) survives verbatim minus ids/dates. server-worker.ts (~250): per-RPC-handler role descriptions and frame-shape walkthroughs. derivers.ts (~80): mostly load-bearing — light touch; DO NOT touch biome-ignores at derivers.ts:179 and :452. collections.ts (~120): collection-shape walkthroughs. exec-backend.ts (~60): command-shape paraphrases.

### Investigation targets

**Required** (read before coding):
- The epic spec (planctl cat) — Scrub standard, sacred floor, Verification recipe

### Risks

Over-deleting in derivers.ts (pure functions with real constraint comments) — when the comment names parser/payload constraints, keep.

### Test notes

Per recipe; test:full mandatory.

## Acceptance

- [ ] Verifier passes post-format on all five files; typecheck + biome + test:full green, zero new failures
- [ ] Floor items 7 (exactly once) and 8 present; both derivers biome-ignores untouched
- [ ] Done summary reports lines and chars deleted

## Done summary

## Evidence
