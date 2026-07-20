## Overview

The boot-time native-crash probe builds its candidate set from the crash-loop rate window
(~30 min), so any predecessor that lived longer is ineligible for .ips attribution AND never
receives its no-report marker — long-lived boots that die natively stay permanently
unattributed, and a silent probe is indistinguishable from a probe that found nothing. Give
backfill its own horizon independent of the crash-loop window, one bounded per-boot log line
stating scanned/matched/marked counts, and a locked test that a >30-min-runtime predecessor
gets its marker.

## Quick commands

- `bun test ./test/daemon.test.ts` — the probe suite including the long-runtime-predecessor case.

## Acceptance

- [ ] a predecessor whose runtime exceeded the crash-loop window is attributed (or no-report-marked) at successor boot
- [ ] each boot logs one bounded probe summary line (scanned/matched/marked)
- [ ] the crash-loop distress decision keeps its own existing window

## Early proof point

Task that proves the approach: `.1`. If it fails: land the summary log line alone so a silent probe is at least diagnosable.

## References

- ~/docs/keeper-phase2-backlog.md item #46 (evidence: two probe-capable boots wrote zero enrich lines across a ledger of 48-53min deaths, 07-18)
