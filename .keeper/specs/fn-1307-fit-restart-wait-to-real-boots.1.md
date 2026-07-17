## Description

**Size:** S
**Files:** cli/restart.ts, test/restart-cli.test.ts

### Approach

Two calibration fixes with the decision logic left intact. First, the kickstart invocation's 1s subprocess timeout TERM-kills `launchctl kickstart -k` mid-restart on every run (observed: `kickstart_warning {exit_code:143, timed_out:true}` on all of tonight's restarts) — give it a budget that fits a real kill-and-respawn (order of 10-15s) and treat only a genuine nonzero/timeout beyond that as the warning case. Second, the 30s default overall deadline is shorter than real post-boot catch-up on a loaded event store (a timed live restart probed the full 30s without three `catching_up:false` replies; the daemon was healthy shortly after) — raise the default deadline to fit observed catch-up with margin (order of 2-3 minutes), keeping `--timeout` as the override and the evidence semantics (fresh ledger boot + consecutive caught-up probes, post-loop re-check) exactly as they are. State the chosen budgets and their rationale in code where the constants live.

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/restart.ts:17 — REQUIRED_HEALTHY_PROBES and the DEFAULT_RESTART_TIMEOUT_MS constant near line 110
- cli/restart.ts:263-270 — the kickstart invocation carrying the 1s subprocess budget
- cli/restart.ts:155, 293-295 — the caught-up probe predicate (`boot.catching_up === false`)

### Risks

- A longer default deadline must not mask a genuinely dead daemon: the no-fresh-boot fall-through and `--timeout` override keep the failure path honest.

### Test notes

Update fixtures for the new defaults; add a case proving a slow-catch-up boot (healthy only after, say, 45s of catching-up probes) succeeds under the new default and still fails under `--timeout 10s`.

## Acceptance

- [ ] A healthy restart shape with a multi-second kickstart and sub-2-minute catch-up returns success without a kickstart warning
- [ ] A dead-daemon shape still fails by deadline with retained output
- [ ] `--timeout` overrides the default in both directions
- [ ] Focused suite green through injected seams

## Done summary

## Evidence
