## Overview

The ApiError/RateLimited and InputRequest fold arms flip a job to `stopped` and stamp an
annotation pair, but when the session resumes tool activity (the CLI internally retried a
transient API error, or the human answered an in-tool question) the board keeps showing
`[::stopped]` / `[failed:*]`. End state: the PreToolUse/PostToolUse fold clears the
api-error pair (new third hot-path clear) and un-stops the row back to `working` (both the
new api-error clear and the existing input-request clear), so the board never shows a
dead/failed worker that is actually running.

## Quick commands

- `bun test test/reducer-links.test.ts` — fast-tier proof of the new clear/un-stop arms
- `bun run test:full` — mandatory full tier (reducer touched)

## Acceptance

- [ ] A job stopped by a transient ApiError flips back to `working` with a NULL api-error pair on its next tool event
- [ ] A job stopped by InputRequest flips back to `working` on its next tool event (pair already cleared today; state now follows)
- [ ] Terminal (`ended`/`killed`) rows and the subagent-suppressed pair-set-but-working case are never state-flipped, and `active_since` only stamps on the genuine stopped→working edge
- [ ] Re-fold determinism holds for the new sequences; `bun run test:full` passes; no SCHEMA_VERSION bump

## Early proof point

Task that proves the approach: ordinal 1 (the only task). If it fails: the fold predicates
are wrong, not the direction — re-derive the CASE gates against the incident event sequence
(events 4240822-4240824) before reconsidering scope.

## References

- Incident: event 4240823 (2026-06-12), transient socket ApiError kind "unknown" on close::fn-33-bun-close-saga-full-parity; CLI retried in 3s, board lied for ~6 minutes
- src/reducer.ts:6380-6415 — Pre/PostToolUse hot-path-clear case (the two existing clears the new one mirrors)
- src/reducer.ts:6257-6292 — ApiError/RateLimited stamp arm (subagent-suppression guard; source of the pair-set-but-working sub-flow)
- src/reducer.ts:6351-6377 — InputRequest stamp arm (unconditional stop, no subagent guard)
- src/reducer.ts:6021-6041 — UserPromptSubmit revival (the only other state='working' writer; its active_since rising-edge CASE is the stamping reference, but its `!= 'working'` predicate is NOT the un-stop's — see task spec)
- src/dash/view-model.ts:429-435 (pill keys on the pair) and :399-404 (timeline sorts on active_since) — the two display surfaces; autopilot (isOccupyingJob, findJob) and readiness are confirmed state-flip-neutral

## Docs gaps

- **README.md:20-29**: update intro clearing-contract — PreToolUse/PostToolUse now clear the api-error pair too and un-stop state to `working`
- **README.md:2012-2016**: same contract revision in the epics fan-out prose; gate now guards either annotation pair — consolidate with the intro so one passage is canonical
- **README.md:2460**: inline SQL comment carries the old clears-on-UPS-only rule — revise
- **README.md:706-722**: board pill docs — trim any language implying `[failed:*]` / `[::stopped]` are sticky until human revival; tool-activity resumption clears them

## Best practices

- **Trust event order over debounce:** no flap-damping or N-events-before-unstop — a PreToolUse after an ApiError in the stream proves the CLI resumed; counting windows would break re-fold determinism [microservices.io / repo invariant]
- **Projection-only concern:** no synthetic "stale-stop cleared" event — the activity event is the evidence; minting one would widen the write path against the sole-writer rules [Azure ES pattern docs]
- **Gated clears over unconditional overwrite:** generic ES guidance favors unconditional arms, but the repo's IS-NOT-NULL hot-path gate keeps the UPDATE cold on the 50+/turn tool-event path and the no-op-gate test pins it — repo convention wins
