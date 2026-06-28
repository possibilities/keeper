## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

B1 (recover pass-2 swallows push-unconfirmed). Recover pass-2's
`switch (merge.kind)` (src/autopilot-worker.ts ~:3190-3269) has cases for
not-ahead/merged/off-branch/dirty/would-clobber/non-ff/not-turn-key/conflict/
push-timeout/push-failed/lock-timeout/local-timeout — but NO
`case "push-unconfirmed"` and NO `default`, so a `push-unconfirmed` (which the
merged + not-ahead arms can now return) falls through silently, recording no
failure. It is masked by pass-3 (which re-checks origin-containment, re-pushes,
and defers teardown), so this is a feed-visibility gap, not a teardown-safety
bug — but a real latent fall-through. Add `case "push-unconfirmed":` →
a `worktree-recover-<kind>-push-unconfirmed` retry-skip (INSIDE the auto-clear
prefix, matching pass-3's reason family at ~:3363-3377), AND add a
`default: { const _exhaustive: never = merge.kind; … }` exhaustiveness guard so a
future `MergeLaneResult` kind can never fall through unhandled.

B3 (stale non-ff comments). Inline comments at src/autopilot-worker.ts
~:2394-2395, :2405, :2608, and :1021-1025 still group non-ff with the transient
retry-skips ("returns `retry`") — but finalize non-ff now ships as a VISIBLE
sticky DispatchFailed (the README/CLAUDE.md were already corrected; these inline
comments were missed). Prune/correct them to present-tense reality (rule #0:
forward-facing, no provenance).

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts recover pass-2 switch (~:3190-3269) + pass-3's push-unconfirmed mapping (~:3363-3377, the reason family to match) + the MergeLaneResult union (~:2758-2769)
- src/autopilot-worker.ts:2394-2395, :2405, :2608, :1021-1025 (the stale non-ff "returns retry" comments)
- src/autopilot-worker.ts:411-416 (reason prefix — the new pass-2 reason stays worktree-recover-*, inside the auto-clear scope)

### Risks

- The new pass-2 push-unconfirmed reason MUST stay worktree-recover-* (recover-side, auto-clearable) — never worktree-finalize-*.
- The `default: never` is compile-time only; ensure the switch still returns a value/falls through correctly for the genuinely-handled kinds.

### Test notes

Pure fake-runner: recover pass-2 returns push-unconfirmed → a worktree-recover-* retry-skip (no silent swallow), assert via the recovery failure list. The default:never guard is exercised by typecheck.

## Acceptance

- [ ] recover pass-2 handles push-unconfirmed as a correctly-scoped worktree-recover-* retry-skip (no silent swallow)
- [ ] pass-2's switch has a default exhaustiveness guard (a future MergeLaneResult kind cannot fall through unhandled)
- [ ] no inline comment still describes the finalize non-ff degrade as a retry-skip (corrected to the visible-sticky reality)

## Done summary

## Evidence
