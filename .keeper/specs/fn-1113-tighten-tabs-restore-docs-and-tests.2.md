## Description

Finding F3 (kept). `renderOutcomes` wraps `o.error` in `commentSafe` on the
FAILED branch — one of the epic's five agent-influenced `#`-comment
interpolation sites — but no test feeds a newline-bearing error through it.
The dedicated sanitization test covers only the `would-restore` kind (label +
session); the existing FAILED-path test uses `error: "x"`. A regression
dropping `commentSafe(o.error)` would reopen the comment-injection vector on
the error path and pass CI.

Add a FAILED outcome with a newline-bearing error (e.g.
`error: "boom\nrm -rf ~/x"`) and assert the payload stays inside its `#`
comment on every line, mirroring the existing sanitization test.

## Acceptance

- [ ] A test feeds a newline-bearing `o.error` through the renderOutcomes
  FAILED branch and asserts it stays inside its `#` comment
- [ ] The test fails if `commentSafe(o.error)` is removed
- [ ] `bun test` green

## Done summary

## Evidence
