## Description

Give "no test-gate script configured" its own verdict distinct from
cannot-run, and stop minting needs_human rows for it:

- runPackageSuiteGate (src/autopilot-worker.ts:7600-7671): a repo whose
  gate lookup (readTestGateCommand :668-680) finds no script classifies as
  a distinct pass-with-note outcome — the gate is treated as passed, one
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
- Fold determinism rules apply: classification happens in producers, never
  in folds.

Files: src/autopilot-worker.ts, src/baseline-worker.ts, tests beside each
(test/autopilot-*.test.ts, test/baseline-*.test.ts — locate the suite-gate
classifier tests).

## Acceptance

- [ ] Missing gate script classifies pass-with-note; finalize and recover
      proceed and mint no dispatch-failure row (tests).
- [ ] Deadline-kill and install-failure classifications and rows unchanged
      (tests).
- [ ] Baseline probe on a gate-less repo returns the pass-with-note verdict.
- [ ] Standing missing-script unavailable rows level-clear on re-probe
      under the new classification (test through the producer seam).

## Done summary

## Evidence
