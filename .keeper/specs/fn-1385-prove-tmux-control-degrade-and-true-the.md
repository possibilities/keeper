## Overview

Close the narrowed #3 tmux remainder: the control worker's degrade-in-place
escalate branch (src/tmux-control-worker.ts ~:667-684) ships with pure-function
`decideReconnect` tests only — the LOOP behavior it protects (attempts pinned at
the cap, liveness pulses continue, the daemon NEVER fatalExits over a focus
feature) has no regression proof. Separately, the file's control-mode invariants
header states "host tmux is 3.6b" while the live host serves 3.7b — the
3.6-era workarounds (no-output set-once because the ≤3.6 toggle hangs,
defensive `copy-mode -q` because 3.6b lacks `%config-error`) need a compat pass
against 3.7b reality and a truthful header. Focus observation currently works
under 3.7b, so this is hardening + doc truth, not an outage. Domain is disjoint
from every open epic (fn-1350 arc: daemon/autopilot/reconcile; fn-5 chain:
agentbrain) — verified at scaffold time.

## Quick commands

- `bun test ./test/tmux-control-worker.test.ts && bun test ./test/tmux-control-parser.test.ts && bun run typecheck` — control-worker gates green

## Acceptance

- [ ] A deterministic loop-level test proves the escalate branch degrades in place: attempts stay pinned at the cap, liveness posts continue, no fatalExit fires, and a later made-progress connect resets the counter and restores observation
- [ ] The control-mode invariants header states the verified 3.7b host truth; every retained 3.6-era workaround is annotated with why it stays (or is removed with proof)
- [ ] The 3.7b compat pass records which invariants were re-verified against the live tmux (no-output at attach, refresh-client re-assert, copy-mode defense, %exit id-discard) with test or transcript evidence

## Done summary

## Evidence
