## Overview

The pair-CLI retirement left provenance comments that still name symbols it
deleted — the `pair send` verb and pair's `assemblePrompt` helper — across the
surviving launch/panel seam. These comments describe a two-caller architecture
and helpers that no longer exist anywhere in the tree, so the next reader greps
for them and finds nothing. Rewording them to state current single-caller
behavior restores accuracy and satisfies the project's forward-facing-comments
rule (#0: no past-tense provenance).

## Acceptance

- [ ] No surviving comment names the deleted `pair send` verb or `assemblePrompt`
      helper; each is reworded to describe current behavior.
- [ ] The launch-handle seam JSDoc describes its actual single-caller shape.
- [ ] typecheck + lint + full suite green (including the retired-name guard).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | launch-handle.ts:2-3,9,77 JSDoc names deleted `pair send` as a second caller; misleads the next reader and violates rule #0. |
| F2 | merged-into-F1 | .1 | F2 (main.ts:923 + pair/panel.ts:257,260 naming deleted `assemblePrompt`/`pair send`) folds into F1: same root cause, one docs-cleanup commit. |
| F3 | culled | — | Bisect hazard is advisory only; final tree correct, no forward code action, zero user impact. |

## Out of scope

- The mid-stack bisect hazard (F3) — history is already landed and squash-on-merge erases it; no forward action.
- Any behavior change to the launch/panel seam — this is comment-only rewording.
