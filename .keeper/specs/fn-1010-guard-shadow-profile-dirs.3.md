## Description

**Size:** S
**Files:** cli/usage.ts, test/usage.test.ts

### Approach

Surface a narrow, non-fatal advisory in `keeper usage` for the AUTH-BEARING `default/`
shadow only (predicate: `isReservedShadow && hasAuth`), linking the `no active
subscription` line the operator already sees (fn-1007) to the stranded login behind it.
Compute findings in-process via `findShadowProfileDirs` (task .2) — a live fs read, NEVER
a daemon round-trip or a fold/projection — ONCE per frame setup (cached for the frame's
lifetime, not re-run per redraw tick, to avoid IO churn/flicker). Render it in the
non-tabular banner region near the live-frame body composition / `formatNoFrameOutput`
(~:1278-1284) — NOT a fake account row, and NOT at the teardown comment (:1158). Add a
one-line detection hint to the HELP constant (:54-107) pointing at `keeper agent profiles
check` (the procedure lives in the README runbook). Confirm cli/usage.ts has `homeDir` +
a `listProfilesFn` available at the render site, and that importing `findShadowProfileDirs`
keeps the usage render path db-free.

### Investigation targets

**Required** (read before coding):
- cli/usage.ts:54-107 (HELP constant), the live-frame body composition + formatNoFrameOutput (~:1278-1284) — the banner surface
- cli/usage.ts:1158 — confirm this is the teardown comment (NOT the advisory site)
- the renderRowLines / account_state surfacing from fn-1007 (sibling) — the no-bar-reason line the advisory complements
- test/usage.test.ts — the renderRowLines direct-drive pattern (plain rows + fixed NOW_MS)

### Risks

- db pull-in via the findShadowProfileDirs import on the usage render path — keep it db-free.
- Cadence: a per-redraw readdir would flicker / churn IO — compute once per frame.
- Predicate creep: keep it to the auth-bearing default/ shadow; tracked-profile health is fn-1007's job, not this banner's.

### Test notes

Drive the advisory render with a findings input containing an auth-bearing `default/`
shadow → assert the banner line is present and does not perturb the account-row column
math; with no shadow → assert no banner. Keep it a pure-function test where possible.

## Acceptance

- [ ] `keeper usage` shows a one-line advisory iff an auth-bearing `default/` shadow exists (`isReservedShadow && hasAuth`).
- [ ] Detection is in-process (live fs, no daemon round-trip), computed once per frame, db-free.
- [ ] The advisory is a banner (not a fake account row) and doesn't shift the account-row alignment.
- [ ] HELP constant gains a one-line detection hint pointing at `keeper agent profiles check`.
- [ ] `bun test test/usage.test.ts` green.

## Done summary
keeper usage now surfaces a one-line, db-free advisory banner for an auth-bearing reserved profile shadow (isReservedShadow && hasAuth), computed once per frame, with a HELP hint pointing at keeper agent profiles check.
## Evidence
