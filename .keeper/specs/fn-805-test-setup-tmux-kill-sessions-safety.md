## Overview

The `keeper setup-tmux --kill-sessions` path tears down the human's live
tmux sessions, guarded by a busy-pane safety gate in `main()`. The decision
primitives are unit-tested, but the gate's call-ordering invariant — busy
panes refuse-and-exit-1 having killed nothing, both on non-TTY stdin and on
an aborted y/N prompt — has no test. This follow-up closes that one
safety-critical coverage gap so a future reorder cannot silently nuke
working sessions undetected.

## Acceptance

- [ ] A test proves the non-TTY-with-busy-panes branch exits 1 having called no kill.
- [ ] A test proves an aborted (N) confirmation exits 1 having killed nothing.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | Comment at cli/setup-tmux.ts:533-534 states the non-obvious invariant of why the import.meta.main guard is absent; deleting it is a net loss. |
| F2 | culled | — | Sizing-stub coarseness in test/setup-tmux.test.ts is a test-quality nitpick with no shipped defect or user impact. |
| F3 | culled | — | KEEPER_DIR hard-code (cli/setup-tmux.ts:72) is a documented single-host assumption; auditor requests no change. |
| F4 | kept | .1 | cli/setup-tmux.ts:494-520 busy->gate->killAllSessions ordering is untested and a regression silently destroys live tmux sessions. |
| F5 | culled | — | select-layout-per-split ordering gap (cli/setup-tmux.ts:208-211) is a low-risk cosmetic concern, auditor-rated low risk. |

## Out of scope

- The `KEEPER_DIR` single-host cwd assumption (F3) — explicitly declined as a documented control-plane assumption.
- The select-layout-after-every-split call-ordering coverage (F5) — deferred as low-risk cosmetic.
