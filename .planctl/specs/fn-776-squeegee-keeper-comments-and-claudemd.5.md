## Description

**Size:** M
**Files:** src/daemon.ts, src/plan-worker.ts, src/git-worker.ts, src/transcript-worker.ts

### Approach

Epic Scrub standard + Verification recipe. daemon.ts (~600): delete the boot-sequence narrative comment the code restates line-for-line, worker role catalogs, per-message-type paraphrases; KEEP crash-recovery-via-LaunchAgent-only and no-in-process-respawn constraints (floor item 12). plan-worker.ts (~400): delete incident narratives and per-constant essays; the classifyPlanPath design-spec comment shrinks to the non-obvious layout constraint only; DO NOT touch biome-ignore at plan-worker.ts:2157. git-worker.ts (~300): delete watch-gate and attribution-model narration; KEEP the external-trees-only watcher carve-out (floor item 9). transcript-worker.ts (~150): state-machine paraphrases.

### Investigation targets

**Required** (read before coding):
- The epic spec (planctl cat) — Scrub standard, sacred floor, Verification recipe

### Risks

Four slow-tier files in one task — run the recipe per file, commit once.

### Test notes

Per recipe; test:full mandatory.

## Acceptance

- [ ] Verifier passes post-format on all four files; typecheck + biome + test:full green, zero new failures
- [ ] Floor items 9 and 12 present; biome-ignore at plan-worker.ts:2157 untouched; zero incident dates remain
- [ ] Done summary reports lines and chars deleted

## Done summary

## Evidence
