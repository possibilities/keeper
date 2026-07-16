## Description

Finding F2 (audit of fn-1281-radical-deterministic-test-gate). The epic's
seam extraction in `src/tmux-control-worker.ts` left the production
`realRereadScheduler.setTimer` as a bare `setTimeout(callback, ms)` (line
~406), dropping the `.unref?.()` the pre-epic code applied right after the
`setTimeout` (present at `7ac85888~8:src/tmux-control-worker.ts:867`). The
sibling timers in the same file (`livenessTimer` and the debounced timer at
~526/~534) still call `.unref?.()`, so the reread seam is the lone divergence
and a pending 50ms debounce can hold the worker's event loop alive.

Files: `src/tmux-control-worker.ts` — `realRereadScheduler.setTimer`.

Fix: build the timer, call `.unref?.()` on it, and return it, e.g.
`const h = setTimeout(callback, ms); (h as any).unref?.(); return h;`.

## Acceptance

- [ ] `realRereadScheduler.setTimer` applies `.unref?.()` to the timer before returning it.
- [ ] Behavior matches the pre-epic reread path; no change to the debounce interval or the `RereadScheduler` interface.

## Done summary
Restored the reread-timer unref in tmux-control-worker; operator-verified 72/0 across both tmux-control suites and landed via plain-git escape (terminal leg 3d9c2f17 claim unadoptable) as cbf6f5da on the epic lane
## Evidence
- Commits: cbf6f5da
- Tests: bun test tmux-control-worker+tmux-control-parser 72/0 (operator re-run in lane)