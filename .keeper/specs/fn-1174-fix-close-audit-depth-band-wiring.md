## Overview

The variable-depth close audit never varies: the depth-band consumer in
close-preflight reads a policy shape that the shipped `audit-policy.yaml`
does not provide, so every epic close derives a spurious `lean` band and the
standard/deep passes (plus the `[REFUTE]`/deep-lens machinery downstream)
are dead in production. This follow-up reconciles the consumer with the
committed config, adds the end-to-end regression test that would have caught
it, and hardens the drift gate so the two halves cannot silently diverge
again.

## Acceptance

- [ ] `deriveDepthBand` reads the committed `depth_bands` list shape and a
      deep-sized signal set over the real on-disk policy yields
      `band === "deep"` with `degraded === false`.
- [ ] A regression test threads the REAL committed `audit-policy.yaml`
      through `deriveDepthBand`/close-preflight and asserts a rising,
      non-degraded band.
- [ ] The audit-policy drift gate cross-checks the keys the runtime consumer
      actually reads against the file, failing on divergence.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | close_preflight.ts:183 (+ :148-150) reads `close_depth` mapping with `min_tasks`/`min_diff_lines`; committed audit-policy.yaml ships a `depth_bands` list with `min_task_count`/`min_diff_loc`, so `deriveDepthBand` returns lean+`policy_no_depth_bands` for every close and the feature is inert. |
| F2 | merged-into-F1 | .1 | F2 (no test threads the real committed audit-policy.yaml through deriveDepthBand/close-preflight for a non-lean band) is the coverage hole that let F1 ship; its regression test lands in F1's fix commit. |
| F3 | merged-into-F1 | .1 | F3 (drift-gate assertion cross-checking the keys the consumer actually reads) is the recurrence guard for F1's consumer/config divergence; it lands in the same F1 fix commit. |

## Out of scope

- Any change to the audit report/verdict contracts, the AUDIT_SCHEMA_VERSION,
  or the depth-directed auditor branching (lean/standard/deep) itself — the
  machinery is correct; only its input wiring is broken.
- Retuning the `depth_bands` thresholds — the shipped values stand; this fixes
  wiring, not policy.
