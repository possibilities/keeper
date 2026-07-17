## Description

**Size:** S
**Files:** cli/restart.ts, test/restart-cli.test.ts

### Approach

Debug-first: reproduce the lying verdict through the injected seams before changing behavior. Live evidence: on a clean tree with no schema step, `keeper daemon restart` returned `kickstart-failed` carrying a `kickstart_warning` detail (exit 143, empty stdout) while the restart ledger gained a fresh launchd boot within seconds and `keeper status` answered ok — so output retention works but the success decision never fires. Hypotheses to test in order: the fresh-boot ledger comparison reads the ledger before the new boot row lands (no wait/retry); the health-probe loop's deadline expires before the daemon accepts connections post-kill; kickstart exit 143 (TERM of the old process) routes to a terminal branch that bypasses the evidence decision. Fix the actual cause, keep the verdict evidence-based (fresh boot + consecutive healthy probes), and state the root cause in the Done summary.

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/restart.ts — the post-kickstart decision path landed by the honest-verdict work: where nonzero kickstart falls through, where ledger fresh-boot evidence is read, and every early return that still yields kickstart-failed
- test/restart-cli.test.ts — the three-outcome coverage that passes while the live behavior lies; find what the fixtures assume that reality violates
- ~/.local/state/keeper/restart-ledger.json — NDJSON boot ledger; note the timing between kickstart return and the new boot row's append

### Risks

- The existing tests pass — the defect lives in a gap between fixture assumptions and live timing/exit-code shapes; a fix that only adds another fixture-shaped test will not close it.

### Test notes

Add a regression that mirrors the live reproduction: kickstart exits 143 with empty output, the ledger's fresh boot row appears only after a short delay, probes succeed thereafter — expect success-with-warning. Keep all seams injected; no real daemon or launchctl.

## Acceptance

- [ ] The live reproduction shape (nonzero kickstart, delayed fresh ledger boot, healthy probes) returns success with the kickstart warning
- [ ] No-fresh-boot-by-deadline still fails with retained output
- [ ] The root cause is named in the Done summary with the exact code path
- [ ] Focused suite green through injected seams only

## Done summary
Root cause: runRestart (cli/restart.ts) evaluated its success verdict (healthyInARow >= REQUIRED_HEALTHY_PROBES && isFreshBoot(...)) ONLY inside the probe loop on a healthy iteration. The fresh-boot ledger row is monotonic, but the in-loop check re-reads it only on a healthy probe; when the new boot landed during the final backoff before the deadline, it was never re-evaluated, and the evidence-blind fall-through 'failure(failedKickstart ? kickstart-failed : health-timeout)' reported the kickstart exit (143 — our own 1s launchctl-kill timeout, a warning) as terminal even though probes were healthy and a fresh boot had landed. Fix: re-check the same evidence once after the loop and emit success-with-warning if it holds; the no-fresh-boot fall-through is unchanged. Added a regression through injected seams mirroring the live shape (exit 143, empty output, delayed fresh boot, healthy probes).
## Evidence
