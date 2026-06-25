## Description

**Size:** S
**Files:** scripts/restore-agents.ts, test/restore-agents.test.ts, CLAUDE.md

### Approach

`restore-agents --apply` reads NO autopilot state today — the unpaused/double-dispatch hazard is only documented in help text (`:126-128`). Make `--apply` fail closed: before launching anything, read the durable `autopilot_state.paused` from a daemon-down read-only open (the `seedLastGenerationHash` read template) and coerce with the existing `paused ?? true` convention (mirror `coercePaused`, cli/autopilot.ts:264) so an unknown/absent state reads as PAUSED (permissive — a recovery tool must work on a fresh/quiet board). If autopilot is unpaused and `--force` was not passed, exit non-zero having launched nothing, with a clear stderr message naming `--force`. Add the `--force` boolean to the arg parser. On `--force` with autopilot unpaused, still launch but emit a stderr warning about the un-`verb::id`-named double-dispatch risk. Place the gate AFTER set derivation, BEFORE the first launch.

### Investigation targets

**Required** (read before coding):
- scripts/restore-agents.ts:126-128 — the help-text-only warning to replace; `:549` `main()`; `:612-639` the `--apply` launch path where the gate lands
- cli/autopilot.ts:264-281 — `coercePaused` / `projectAutopilotPaused` (the `paused ?? true` unknown-is-paused convention)
- src/restore-worker.ts:1161-1186 — daemon-down read-only open template for the paused read
- test/restore-agents.test.ts — `fakeCandidate`, capturing-fake launcher + no-op sleep harness

### Risks

- Reading the LAST-DURABLE paused state (not live) is correct and required under the daemon-down constraint — do not add a socket round-trip.
- Don't regress the dry-run path: the gate applies to `--apply` only, never the default dry-run.

### Test notes

Cases: unpaused + no `--force` → non-zero, zero launches; unpaused + `--force` → launches + warning; paused → launches normally; unknown/absent paused row → treated as paused (launches). Assert via the capturing-fake launcher that zero windows spawn on the fail-closed path.

## Acceptance

- [ ] `--apply` exits non-zero and launches nothing when autopilot is unpaused without `--force`
- [ ] `--force` overrides the gate and still launches, with a stderr double-dispatch warning
- [ ] Unknown/absent `autopilot_state` reads as paused (permissive); paused state launches normally
- [ ] Paused read is a daemon-down read-only open (no socket); dry-run path unaffected
- [ ] CLAUDE.md gains one imperative line: `restore-agents --apply` exits non-zero while autopilot is unpaused (fail closed, never warn-and-continue)

## Done summary
restore-agents --apply now fails closed (non-zero, launches nothing) while autopilot is unpaused, reading last-durable autopilot_state.paused daemon-down; --force overrides with a stderr double-dispatch warning, unknown/absent paused reads as paused.
## Evidence
