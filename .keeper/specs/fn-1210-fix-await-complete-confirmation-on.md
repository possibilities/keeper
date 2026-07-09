## Overview

The `complete`-await stability confirmation added in fn-1207 counts consecutive
`completed` subscribe FRAMES, but the daemon's subscribe stream is change-driven
(`diffTick` emits once per advance and freezes on a DB-quiet board). Counting frames
is therefore the wrong basis for confirmation: on a quiet board the second frame
never arrives, so `keeper await complete` hangs forever (reconnect-forever, no
timeout) on exactly the completion it exists to detect; and a fast flap whose
intervening `running` is coalesced away is confirmed as stable. Rework the
confirmation so it debounces the done-unwind flap without depending on a second
frame delivery.

## Acceptance

- [ ] `keeper await complete <id>` fires `met` on a genuinely quiet board where the target reads `completed` as the final board activity (no second frame delivered).
- [ ] The done-unwind flap (`completed -> running -> completed`) is still debounced, including a flap whose intervening `running` is coalesced away by `diffTick`.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Frame-count gate hangs `keeper await complete` on a quiet board: streak stalls at 1 because the confirming second frame never arrives (server-worker.ts:507/2565), reconnect-forever never times out; regression from the prior first-frame `met`. |
| F2 | merged-into-F1 | .1 | F2 (aliased sub-poll flap confirms across a coalesced `running`) shares F1's root cause and constrains the F1 fix (must not simply raise N, which worsens F1's hang). |
| F3 | merged-into-F1 | .1 | F3 (no live-delivery quiet-board test) is the direct proof-of-F1 and folds into F1's fix acceptance. |

## Out of scope

- Fixing the producer-side terminal-completed readiness gate so the verdict itself stops flapping for every other consumer (autopilot gates, `keeper status`, TUI) — the auditor scoped that as separate producer hardening, deferred beyond this consumer-side confirmation fix.
