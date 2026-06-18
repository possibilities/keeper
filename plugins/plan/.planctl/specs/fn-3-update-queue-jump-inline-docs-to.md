## Overview

Three in-code comments still reference the removed `/plan:queue` skill after fn-1.
The `invocation.py` case also actively misstates the `queue_jump=False` invariant for
non-scaffold mutating verbs — `epic queue-jump` now contradicts that claim. This epic
fixes all three sites to reflect the current defer+next model.

## Acceptance

- [ ] `planctl/invocation.py:75-80` updated: names `epic queue-jump` as a source of `queue_jump=True`; removes the false "Mutating verbs that aren't scaffold always pass False" claim
- [ ] `planctl/models.py:131` updated: references scaffold YAML opt-in and `epic queue-jump` verb instead of the removed skill name
- [ ] `planctl/cli.py:419` updated: first line replaces the removed skill reference with a present-tense description of the scaffold opt-in path
- [ ] `grep -r '/plan:queue' planctl/` returns no results in non-historical comment sites

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1     | kept   | .1   | `invocation.py:80` misstates the `queue_jump=False` invariant for non-scaffold mutating verbs; all three sites reference the removed skill in violation of the repo's backward-reference ban |

## Out of scope

- Test coverage gaps for `updated_at` bump and commit-lands on the queue-jump mutating path (tier_0 — no user-visible impact; emit() seam coverage is broad)
