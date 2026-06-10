## Overview

A one-line docstring in `tests/conftest.py` mislabels `real_roots` as a slow-bucket
marker. `real_roots` is a fast-path marker — absent from `_SLOW_BUCKET_MARKERS` and
documented everywhere else as a fast-path opt-out. The fix prevents developers
reading the fixture to understand marker semantics from drawing the wrong conclusion.

## Acceptance

- [ ] `_isolated_roots_default` docstring at conftest.py:749 describes `real_roots` as a fast-path marker, not slow bucket
- [ ] No other marker/bucket terminology is mismatched in conftest

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1     | kept   | .1   | Concrete mislabel at conftest.py:749 — `real_roots` is absent from `_SLOW_BUCKET_MARKERS` but docstring calls it slow bucket; a developer consulting it learns wrong marker category |
| F2     | culled | —    | Behavior-neutral by auditor's own statement; no user impact |
| F3     | culled | —    | Inert — git --porcelain never emits a 3-char line; no production path triggers it |
| F4     | culled | —    | Already documented in commit message and pyproject comment; no user impact |
| F5     | culled | —    | Property implicitly proven by 576 passing tests; auditor rated low priority |
| F6     | culled | —    | Forward-looking theoretical concern; no present defect |

## Out of scope

- Other marker documentation across test files (this fix is scoped to the one mislabeled docstring in conftest)
- Adding an explicit fast-gate smoke test for real_roots marker behavior
