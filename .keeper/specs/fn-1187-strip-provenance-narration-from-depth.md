## Overview

The depth-band wiring fix introduced inline comments and test banners that
narrate past-tense provenance and prior-audit finding ids (F1/F2/F3, "how
the wiring bug shipped"). Repo rule #0 bans fn-ids, dates, and past-tense
provenance in code comments — history belongs in commit messages and
docs/adr. This is a comment-only cleanup: keep the forward-facing
single-source-of-truth invariant, delete the provenance clauses and labels.

## Acceptance

- [ ] No code comment or test banner in the touched files carries an fn-id / prior-finding label (F1/F2/F3) or past-tense "how the bug shipped" narration
- [ ] The forward-facing invariant sentences (single key list, coerced entry supplies exactly the runtime keys) are preserved
- [ ] The full plan test suite stays green

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Provenance/fn-id narration in the depth-band comments and test banners violates repo rule #0. |
| F2 | culled | — | Consider-rated, bounded impact; defensive hardening for a hypothetical yaml reorder, below the keep bar. |
| F3 | culled | — | Depth-key-as-non-threshold is covered transitively; no bug risk. |
| F4 | culled | — | Deep-shaped-but-1-repo boundary is untested but no defect claimed; nice-to-have coverage. |

## Out of scope

- Any behavior change to deriveDepthBand / bandMatches / the drift gate (the wiring fix is correct as shipped).
- An ordering/monotonicity assertion on the depth_bands file order (F2, deferred).
- Additional bandMatches / min_touched_repos boundary tests (F3, F4, deferred).
