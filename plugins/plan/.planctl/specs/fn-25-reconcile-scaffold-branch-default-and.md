## Overview

The snippet-strip epic left planctl's epic-mint path internally inconsistent:
its commit flipped `normalize_epic`'s `branch_name` default from `None` to
`"main"` while `scaffold` still mints `epic_branch or epic_id` and the scaffold
CLI docstrings advertise "defaults to main" — a three-way divergence a user
hits the moment they scaffold without `--branch`. The same epic also left two
dormant-seam comments in `models.py` pointing at the `render-spec` verb it just
deleted. This follow-up picks the single intended branch default, aligns all
paths plus the docstring, pins it with a test, and trims the dead-verb clause.

## Acceptance

- [ ] One intended `branch_name` default is chosen and `normalize_epic`, `run_scaffold.py`, `run_epic_create.py`, and the scaffold CLI docstrings all agree on it.
- [ ] A scaffold test pins the no-`--branch` minted `branch_name` to the intended default.
- [ ] The two `models.py` dormant-seam comments document only the live verbatim-persist fact, with no reference to the deleted `render-spec` verb.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1  | kept           | .1 | git show 80c8411 confirms normalize_epic flipped branch_name None->main while run_scaffold.py:901 mints epic_branch or epic_id and cli.py:229/398 docstrings say "defaults to main" — three-way divergence. |
| TG1 | merged-into-F1 | .1 | TG1 (pin the scaffold-minted branch default with a test) folds into F1 — the assertion only lands once F1 chooses the single intended default. |
| F2  | kept           | .1 | models.py:89 and models.py:148 trail "promptctl render-spec handles dedup at union time"; render-spec was deleted by this epic (commit cc7ee6b) — backward-facing dead-consumer reference. |
| TG2 | culled         | —  | Auditor self-labels not-blocking; unvalidated snippets/bundles pass-through is the intended dormant contract with no live consumer — theoretical, no user impact. |

## Out of scope

- Resurrecting any snippet/bundle validation or the deleted `render-spec` consumer — the dormant unvalidated pass-through (TG2) is intended contract.
- The promptctl-side stale `render-spec` doc references (refs.py:19, storage.py:116) — out of this planctl-primary epic's scope.
