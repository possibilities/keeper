## Description

Extend the enrich probe to consult OS-level evidence for the dead pid
(unified log jetsam/memory-pressure records inside the boot's lifetime
window) and to record a typed verdict enum instead of an empty reason.
Sample main RSS into the periodic serve-health report so a
memory-growth death leaves a visible ramp in the last reports before
the end, then run the forensic pass over the four recorded quiet ends
and write the per-end verdicts.

## Acceptance

- The enrich row for a daemon end carries a typed verdict (one of
  watchdog / operator / soft-exit-leaf / os-memory-kill / signal /
  no-evidence) with the supporting probe output bounded inline; tests
  cover the classifier over fixture probe outputs.
- serve-health reports carry main RSS; the ledger keeps the last N
  reports' RSS values accessible for the enrich pass.
- The four historical quiet ends each have a written verdict in the
  epic Done summary, including ruling the 73a71722e serve-path change
  and #88 starvation in or out for the afternoon pair.

## Done summary

## Evidence
