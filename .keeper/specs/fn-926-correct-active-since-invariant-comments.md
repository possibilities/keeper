## Overview

The fn-924 audit surfaced two documentation-accuracy defects in the
load-bearing `active_since` doc comments: they assert the field is "stamped
once... then frozen" (it is actually re-stamped on every un-stop rising edge),
and they cite a non-existent schema version "pre-v90" (the embedded field
first appears in v84). The shipped `bound-pending` predicate is correct — it
reads only null-vs-non-null — so this is comment accuracy only, not a behavior
change. It matters because the false "frozen" invariant would mislead a future
reader who relies on `active_since` as a stable first-activity timestamp.

## Acceptance

- [ ] The `active_since` comments describe the actual runtime behavior (null until the first un-stop edge, then non-null and re-stamped on each subsequent edge — NOT frozen).
- [ ] The schema-boundary note reads "pre-v84" (or drops the version), with no reference to the non-existent v90.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | reducer.ts:6939-6942 and 7307/7327 re-stamp active_since on every un-stop edge, so the "frozen" comments at types.ts:586-588 / reducer.ts:4849-4850 are false. |
| F2 | merged-into-F1 | .1 | F2 (the "pre-v90" typo at types.ts:590 / reducer.ts:4854) edits the SAME doc blocks as F1; one commit covers both, so F2 folds into F1's task. |

## Out of scope

- Any change to the `bound-pending` predicate or `active_since` runtime semantics — the audit confirmed the predicate is sound.
- The transitively-covered self-resolution test scenario the auditor flagged as low-value and non-blocking.
