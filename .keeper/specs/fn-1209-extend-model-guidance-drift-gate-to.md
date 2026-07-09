## Overview

The commit-work model-guidance drift gate (arm 13) fires only when
`plugins/plan/model-selector.yaml` or `plugins/plan/subagents.yaml` is staged,
yet the check it fronts also enforces a sha256 hash-parity invariant over the
`references/*.md` research cache files. A hand-edit to a references cache file
staged on its own — the natural way research gets refreshed — drifts the
recorded hash silently past the commit-time gate that exists to catch exactly
that. This closes the trigger-set gap so the early gate covers the invariant's
full input surface.

## Acceptance

- [ ] A staged references cache edit (with no config restage) fires arm 13
- [ ] Zero-cost-when-untriggered behavior is preserved for unrelated commits
- [ ] Trigger-predicate coverage is asserted for the references path

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | Trigger-breadth judgment call: firing arm 14 on the root src closure would trip nearly every root-src commit against the epic's zero-cost design; the boundary invariant is still enforced by the full suite. |
| F2 | kept | .1 | model-guidance-check.ts invariant (b) hashes references/*.md against model-selector.yaml sha256s, but isModelGuidancePath fires only on model-selector.yaml/subagents.yaml, so a references-only staged edit escapes the gate. |
| F3 | culled | — | Doc-wording nitpick: presence-means-on behavior is correct and fails loud/open; only the "any truthy value" comment is misleading. |

## Out of scope

- The arm 14 import-boundary trigger breadth (F1, culled — narrow plan/src trigger is a deliberate zero-cost tradeoff; the invariant stays enforced by the full suite).
- The `KEEPER_COMMIT_WORK_SKIP_DRIFT_GATES` "truthy value" comment wording (F3, culled).
