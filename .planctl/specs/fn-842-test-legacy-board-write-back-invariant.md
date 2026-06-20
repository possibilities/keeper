## Overview

The .keeper/ rename's load-bearing safety property is write-back: a mutating
CLI verb on a board minted under the legacy .planctl/ dir must commit BACK to
.planctl/, never force a .keeper/ shadow dir that hides the live one. The audit
confirmed the implementation is correct and the resolver seam is unit-covered,
but no end-to-end test pins the mutating-write case on a legacy-only board — only
read-side fallback is asserted today. This follow-up locks that invariant against
regression.

## Acceptance

- [ ] A test mutates a legacy-only (.planctl/) board via a CLI verb and asserts the resulting commit touched .planctl/
- [ ] The same test asserts no .keeper/ shadow dir was spawned on that board

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | Naming-altitude only (resolveDataDirOrDefault); auditor self-labels a non-fix, docstring already documents the read-side dual use. |
| F2 | culled | — | Live onChange classifies per-file not per-dir, but the edge is transient/id-idempotent during the git-mv flag-day; reconcile re-asserts .keeper/ precedence. |
| F3 | culled | — | Duplicated DATA_DIR_NAMES literal is a forced cross-package contract (worker can't import the vendored subtree); auditor flags it as justified. |
| F4 | culled | — | Mirrors culled F2; asserting live watcher-callback ordering is flaky by nature, against the repo's poll-don't-sleep discipline. |
| F5 | kept | .1 | No test asserts a mutating write-back lands in a legacy board's .planctl/ without spawning a .keeper/ shadow dir — the epic's load-bearing safety invariant. |

## Out of scope

- The live-watcher dir-precedence edge (F2) and its test (F4) — transient, id-idempotent, reconcile-corrected.
- Resolver naming altitude (F1) and the forced cross-package DATA_DIR_NAMES duplication (F3).
