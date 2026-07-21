## Description

Give "no test-gate script configured" its own verdict distinct from
cannot-run, and stop minting needs_human rows for it:

- runPackageSuiteGate (src/autopilot-worker.ts:7600-7671): a repo whose
  gate lookup (readTestGateCommand :668-680) finds no script classifies as
  a distinct pass-with-note outcome - the gate is treated as passed, one
  bounded log/annotation records that no suite was configured.
- The recover pass (:8653) and finalize base-merge/push passes
  (:6603-6605, :6740-6747) proceed on pass-with-note and mint NO
  *-suite-gate-unavailable dispatch-failure row for the missing-script
  case. Install-failure and deadline-kill keep their current cannot-run
  classification and rows.
- Apply the same distinction to the baseline analogue
  (noTestGateOutcome, src/baseline-worker.ts:183-189) so baseline probes on
  a gate-less repo do not read as unavailable.
- Standing *-suite-gate-unavailable rows for the missing-script case must
  level-clear once the producer re-probes with the new classification;
  verify the clear path exists (positive-evidence rules for recover rows)
  and extend it if the new pass verdict is not yet accepted as clearing
  evidence.
- CONFIRMED ORPHAN GAP (live evidence, 13 drained specimens): the
  positive-evidence clear (recoverFailuresToClear,
  src/autopilot-worker.ts:576) clears an open row only when the SAME
  cycle emits a resolution for its key, but the recover pass stops
  visiting an epic once it closes and its lanes tear down - so any
  recover-originated row whose episode resolves while the row is open
  orphans PERMANENTLY (no fresh failure, no resolution, retained
  forever; the only exit was operator retry_dispatch after out-of-band
  verification). Fix as part of the standing-row bullet above: each
  recover cycle must emit resolutions (merged / ancestor / absent) for
  EVERY open recover-originated row's (epic,repo) key - including
  closed and lane-less epics - so an open row can level-clear after
  its episode ends. Cover with a producer-seam test: closed epic +
  torn-down lane + open row resolves to a clear on the next cycle.
- Fold determinism rules apply: classification happens in producers, never
  in folds.

Files: src/autopilot-worker.ts, src/baseline-worker.ts, tests beside each
(test/autopilot-*.test.ts, test/baseline-*.test.ts - locate the suite-gate
classifier tests).

## Acceptance

- [ ] Missing gate script classifies pass-with-note; finalize and recover
      proceed and mint no dispatch-failure row (tests).
- [ ] Deadline-kill and install-failure classifications and rows unchanged
      (tests).
- [ ] Baseline probe on a gate-less repo returns the pass-with-note verdict.
- [ ] Standing missing-script unavailable rows level-clear on re-probe
      under the new classification (test through the producer seam).
- [ ] An open recover row on a closed, lane-less epic level-clears on the
      next cycle via an emitted resolution (orphan-gap regression test).

## Done summary
Missing suite-gate script now classifies as pass-with-note distinct from cannot-run; finalize/recover proceed without minting a suite-gate-unavailable row, the baseline analogue matches, and every recover cycle emits a resolution for open recover rows on closed/lane-less epics so they can level-clear.
## Evidence
