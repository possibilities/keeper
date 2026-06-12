## Description

Backfills the two untested correctness contracts in the history verbs,
bundled because both are test-only changes to `test/history-read-verbs.test.ts`
covering the same three CLI verbs (one commit).

- F3 (kept): `escapeLike` at search-history.ts:130 and find-file-history.ts:132
  escapes `%`/`_`/`\` so a LIKE fragment matches literally via `ESCAPE '\'`.
  The existing tests only exercise plain substrings (`refactor`, `widget`),
  so a regression that drops the escape would silently widen matches and go
  unnoticed. Add a seed whose prompt/path contains a literal `%` (or `_`) and
  assert a search for that fragment matches the literal row and NOT a row
  that would only match under wildcard expansion.
- F4 (merged into F3): the documented `{ success: false, error }` read-failure
  envelope (header contract in every verb, e.g. show-session-events.ts:139,
  find-file-history.ts:149) is untested for find-file-history and
  show-session-events. Add an assertion that a forced read failure yields the
  error envelope rather than an empty result.

## Acceptance

- [ ] A literal-wildcard fragment (`%` or `_`) matches only the literal row for both search-history and find-file-history.
- [ ] find-file-history and show-session-events emit `{ success: false, error }` (not an empty success envelope) on a read failure.
- [ ] Tests route through `sandboxEnv` per the test-isolation rule and pass under the slow tier.

## Done summary
Added test pins for escapeLike literal-match (search-history, find-file-history) and the read-failure error envelope (find-file-history, show-session-events) in test/history-read-verbs.test.ts.
## Evidence
