## Description

keeperd main has now died four times with no attribution: no watchdog
reason, no fatalExit stderr line, no matching native crash report
(attribution probe: scanned>0 matched=0), no operator action. Two ends on
07-20 morning (04:50, 08:14 boots) and two in the afternoon (16:15,
16:21) — the afternoon pair died 31 and 6 minutes into otherwise healthy
boots under post-merge load. The restart ledger records the boots; the
deaths themselves are invisible. Leading suspect shapes: bun/OS memory
kill (jetsam leaves no user-visible crash report), an abrupt exit path
that bypasses the fatalExit logger, or an external signal. The serve-path
event_count change (73a71722e) rides both afternoon boots and must be
ruled in or out despite being load-reducing on its face.

## Acceptance

- Every daemon exit path logs one bounded, flushed attribution line
  (signal received, fatalExit reason, or uncaught-error summary) before
  process end, and the restart ledger's enrich pass consumes it.
- The enrich probe additionally checks OS-level kill evidence (jetsam /
  memory-pressure log records for the dead pid within its lifetime
  window) and records a typed verdict instead of an empty reason.
- A forensic pass over the four recorded quiet ends produces a written
  verdict per end (memory kill / signal / bypassed exit / unknown), with
  #88-starvation ruled in or out via the existing thread-sample evidence,
  recorded in the epic's Done summary.
- Main-thread RSS is sampled into the serve-health report so a
  memory-growth death leaves a visible ramp in the ledger's last report.

## Done summary

## Evidence
