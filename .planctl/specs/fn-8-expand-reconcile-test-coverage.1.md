## Description

Finding F4 (auditor: "_find_source_commits comma-split path not directly asserted").
The function handles `Task: a, b` single-line comma-separated trailers via
`replace(",", "\n")` then split, but no test directly asserts this parsing branch.
If it regresses, a worker commit with comma-separated task ids would not be found
and the verdict would be `not_started` instead of `done`.

Add a test that creates a commit with a `Task: fn-N.1, fn-N.2` single-line
comma-separated trailer and asserts that reconcile returns a `done` verdict for
each task id (source commit found). Fixture lives in `tests/test_reconcile.py`
alongside the existing newline-stacked and single-value trailer tests.

## Acceptance

- [ ] Test commits with a `Task: fn-N.1, fn-N.2` comma-separated trailer
- [ ] `planctl reconcile fn-N.1` returns `done` verdict
- [ ] `planctl reconcile fn-N.2` returns `done` verdict (same commit covers both)
- [ ] All existing reconcile tests continue to pass

## Done summary
Added a test asserting _find_source_commits matches each id from a single-line comma-separated Task trailer and that reconcile reaches the done verdict for both ids the one commit covers.
## Evidence
