## Overview

The codex TranscriptReader (`src/transcript/codex.ts`, 817 lines, with
`test/transcript-codex.test.ts`, 597 lines) shipped as task .3 of the
source epic but its commit (`4e54993c`) carries no `Task:` trailer, so it
never entered the close audit's commit set and a whole new harness reader
is landing entirely unreviewed by the close gate. This follow-up reviews
that reader against the same defensive-parse and security discipline the
pi/claude readers were held to, fixes any defects found, and repairs the
commit provenance so the epic's commit-trailer facts are complete.

## Acceptance

- [ ] `src/transcript/codex.ts` reviewed for the defensive-parse posture
      the sibling readers hold (read-and-catch over existsSync-then-read,
      per-line byte cap, fold-to-skip on unknown line types never throwing,
      stable total-order sort, path-traversal guards on find/list inputs)
- [ ] Any correctness or security defect found is fixed; if none is found,
      that clean-review conclusion is recorded in the Done summary
- [ ] The codex reader's commit provenance is repaired so its code is
      traceable to task .3 (Task trailer restamped, or the gap recorded
      for the closer if the branch state forbids a safe rewrite)

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | 4e54993c (codex reader, 817 impl + 597 test lines) carries no Task trailer, so it never entered commit_groups and ships unreviewed by the close gate. |
| F2 | culled | — | Minor UX inconsistency in claude --help routing; both HELP and SHOW_HELP are valid, no user blocked. |
| F3 | culled | — | encodePiCwd DRY nitpick; the documenting note is already present at pi.ts:48-50 and cross-layer isolation is a deliberate decision. |
| F4 | culled | — | PiListOptions.onBeforeInspect is a deliberate test-seam tradeoff the auditor calls acceptable; removing it flakes the TOCTOU test. |
| F5 | culled | — | Symlinked-bucket test gap on the user's own ~/.pi tree; low risk, noted for completeness. |

## Out of scope

- The claude --help vs show-help routing quirk (F2) — culled as a minor UX nitpick.
- encodePiCwd de-duplication (F3) and the onBeforeInspect test seam (F4) — culled as accepted tradeoffs.
- Symlinked-bucket listing coverage (F5) — culled as low-risk / theoretical.
