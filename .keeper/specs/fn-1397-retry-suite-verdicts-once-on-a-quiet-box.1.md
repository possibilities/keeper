## Description

In the finalize/recover suite verification path (runPackageSuiteGate
src/autopilot-worker.ts:7600-7671 and its mint sites — recover :8653,
finalize :6603-6605/:6740-6747 — plus the baseline analogue classifyRun
src/baseline-worker.ts:246-252):

- Classify a "load-suspect" verdict: deadline-kill (raw.timedOut) OR
  non-zero-exit-with-no-failing-test-output (crashed, empty digest). A
  named failing test is NEVER load-suspect.
- On the FIRST load-suspect verdict for a given (row key, merged commit),
  schedule exactly one bounded retry of the suite instead of minting the
  dispatch-failure row; the retry runs on the next producer cycle
  (optionally gated on a cheap load probe such as 1-minute loadavg vs
  core count — producer-only, never in a fold).
- The SECOND consecutive load-suspect verdict for the same key mints the
  existing row exactly as today (no infinite retry; the retry state is a
  per-key memo, bounded, and resets on a green or named-red verdict).
- A named-red verdict keeps today's immediate visible park; green stays
  green. Fold determinism rules: all probing and retry state live in
  producers/workers, never folds.

Files: src/autopilot-worker.ts, src/baseline-worker.ts, tests beside the
existing suite-gate classifier tests.

## Acceptance

- [ ] A deadline-kill or empty-digest crash triggers one retry, minting
      no row on the first occurrence (tests through the producer seam).
- [ ] A second consecutive load-suspect verdict mints today's row.
- [ ] A named failing test never retries and parks immediately.
- [ ] Retry state is bounded per key and resets on green/named-red.

## Done summary

## Evidence
