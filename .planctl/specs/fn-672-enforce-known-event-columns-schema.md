## Overview

fn-669 introduced `KNOWN_EVENT_COLUMNS` as the hook's static column-intersection set. Three lists must stay in lockstep — `KNOWN_EVENT_COLUMNS`, `insertBindings` (both in `events-writer.ts`), and `CREATE_EVENTS` (in `src/db.ts`) — but no test enforces it. A column added to `CREATE_EVENTS` without updating `KNOWN_EVENT_COLUMNS` would silently drop that column from every hook INSERT permanently, with zero test failure: the exact silent-drop hazard fn-669 was built to kill.

## Acceptance

- [ ] A test asserts set-equality between `KNOWN_EVENT_COLUMNS` and the `events` columns on a migrated DB (via `PRAGMA table_info` or parsing `CREATE_EVENTS`), plus set-equality with `insertBindings` keys.
- [ ] Test is in `test/events-writer.test.ts`, co-located with the other fn-669 tests.
- [ ] Full test suite remains green.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1     | kept   | .1   | HAPPY test SELECT is a literal column list — catches removal but not addition to `CREATE_EVENTS`; a one-test fix closes the gap permanently. |

## Out of scope

- Multi-column skew test (F2, tier_0): auditor assessed single-column case sufficient to prove the mechanism.
- Any runtime enforcement beyond test-time lockstep assertion.
