## Overview

The `keeper-watch --tick` path documents an always-exit-0 / missing-DB-is-harmless
guarantee in both its JSDoc and the babysit plist comment, but `openDb` in
read-only mode throws when the file does not exist, and neither `tick` nor
`main`'s tick branch wraps it. This follow-up fixes the enforcement gap and adds
a test for the missing-DB path so the contract is verifiable.

## Acceptance

- [ ] `keeper-watch --tick` exits 0 when `keeper.db` does not yet exist
- [ ] A test covers `scan` (or `tick`) against a nonexistent dbPath and asserts no throw + graceful return

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | `openDb` read-only skips the `existsSync` guard; `tick` calls `scan` without try/catch, violating the stated exit-0 contract at `cli/keeper-watch.ts:1417-1419` |

## Out of scope

- Tier-0 commentary items (un-windowed read comment, heuristic readyWorkExists, hard-coded path hints) — no tracked work warranted
- Live-probe / real-spawn test coverage — injectable stubs already cover the decision logic
