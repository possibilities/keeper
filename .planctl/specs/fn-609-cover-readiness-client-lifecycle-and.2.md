## Description

**F9 — no test for autopilot block-2 verdict filter and
`renderEpicCommandsFiltered` null-return path.** The new
`isReady("task"|"close", id)` predicate (`scripts/autopilot.ts:251`) and
the filtered renderer (`scripts/autopilot.ts:198-228`) are
pure-function-testable but have no test file. A bug in the predicate or
filter could silently drop ready epics from or add non-ready epics to
the autopilot work list.

## Acceptance

- [ ] New `test/autopilot.test.ts` covers `renderEpicCommandsFiltered`: (a) all-pass — every task and the close pair pass — output matches `renderEpicCommands` output for the same epic; (b) some-pass — only a subset of task pairs survive; (c) none-pass — every kind returns false → renderer returns `null` and the epic is dropped from block 2.
- [ ] If `renderEpicCommandsFiltered` (and any helpers needed for the test) are not currently exported from `scripts/autopilot.ts`, export them (or re-export through a thin internal module) so the test can import them directly without spawning a subprocess.

## Done summary

## Evidence
