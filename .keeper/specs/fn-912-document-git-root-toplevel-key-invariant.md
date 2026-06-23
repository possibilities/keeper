## Overview

The fn-905 per-root self-clear lifecycle silently depends on every gated
git root already being its own git toplevel: `unseededGatedRoots` /
`allGatedRootsSeeded` look `git_status` rows up by the RAW `effectiveRoot`
key, while the boot-seed and live git-worker WRITE those rows under the
RESOLVED `resolveGitToplevel(...)` key. The two agree only when
`effectiveRoot === resolveGitToplevel(effectiveRoot)`. This invariant held
board-wide before fn-905 (the per-root mutex assumes the same identity), but
fn-905 newly turns a key mismatch from a transient stall into a PERMANENT
wedge — a mismatched root never self-clears and stays forced-`unknown`
forever. The assumption is load-bearing and unstated; capture it where the
raw-key lookup lives.

## Acceptance

- [ ] The toplevel-identity invariant ("gated roots MUST already be git
      toplevels — keyed identically to `git_status.project_dir`") is stated
      at the raw-key lookup site in `src/gated-roots.ts`.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | gated-roots.ts:94-126 raw-key lookup vs git-boot-seed.ts:172 resolved-toplevel keying — self-clear newly depends on a hidden toplevel-identity invariant; one-line comment is a genuine fix (normalization refactor culled as speculative). |
| F2 | culled | — | readiness.ts:507-533 effectiveRoot re-walk is a DRY nitpick, boot-window-guarded, harmless at this scale. |
| F3 | culled | — | gated-roots.ts helper-collapse is a refactor preference; current form is clear, boot-window cost only. |
| F3 from above merged | | | |
| F4 | merged-into-F1 | .1 | F4's synthetic drift test is the same root concern as F1's unstated toplevel-identity invariant; folds into F1 as an optional belt-and-suspenders case. |
| F5 | culled | — | no reachable malformed-JSON path at the readiness-gate iteration site; projection feeds typed objects, upstream catch covered. |

## Out of scope

- Normalizing both sides through one resolver (F1's heavier remedy) — culled
  as speculative; the toplevel-identity invariant already holds by
  construction and the mutex depends on it too. Documenting it is sufficient.
- The readiness.ts effectiveRoot re-walk DRY-up (F2) and the
  allGatedRootsSeeded/unseededGatedRoots helper collapse (F3) — culled as
  code-cleanliness nitpicks with no user impact.
