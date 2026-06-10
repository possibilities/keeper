## Description

**Size:** M
**Files:** cli/board.ts, cli/autopilot.ts, cli/usage.ts, plugin/hooks/events-writer.ts

### Approach

Epic Scrub standard + Verification recipe, with one EXTRA control: plugin/ is outside tsconfig, outside biome's configured roots, and invisible to commit-work's lint arms — the verifier is the ONLY automated gate for events-writer.ts, so additionally run `bunx biome check --write plugin/hooks/events-writer.ts` on the explicit path and rely on test:full's hook-spawn tests as the behavior gate. cli/board.ts (~200): rendering pill/state/color docstrings duplicated by README. cli/autopilot.ts (~80): per-command reconcile/dispatch walkthroughs. cli/usage.ts: trim narrations, keep flag-semantics notes. events-writer.ts: delete CLAUDE.md-invariant cross-reference essays and append-path narration BUT KEEP the no-db.ts-import / cold-start-budget tripwire comments (floor items 4-5) and DO NOT touch the biome-ignore at events-writer.ts:654.

### Investigation targets

**Required** (read before coding):
- The epic spec (planctl cat) — Scrub standard, sacred floor, Verification recipe

### Risks

events-writer.ts is the hook hot path with zero commit-time checks — treat the verifier result as the commit gate; any verifier failure is a hard stop.

### Test notes

Per recipe; test:full mandatory (hook subprocess tests live in the slow tier).

## Acceptance

- [ ] Verifier passes post-format on all four files; biome run on the explicit plugin path; typecheck + test:full green, zero new failures
- [ ] Floor items 4-5 present; biome-ignore at events-writer.ts:654 untouched
- [ ] Done summary reports lines and chars deleted

## Done summary

## Evidence
