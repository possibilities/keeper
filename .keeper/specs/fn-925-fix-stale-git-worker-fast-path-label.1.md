## Description

Source finding F2 (evidence: src/git-worker.ts:2673). The git-heartbeat
missed-wake backstop builds its forensic record via
`buildMissedWakeRecord({ ... fastPath: "fsevents" ... })`, but fn-921 made
the git-worker poll-only — the fast path is now the two-tier .git metadata
stat poll, not FSEvents. The hardcoded label misdescribes the producer the
rescue is measured against, so an operator reading a missed-wake record
during a git-surface freeze would attribute the lag to the wrong fast path.

Update the `fastPath` value at the call site to name the current metadata
poll producer (and confirm no other backstop call site carries the same
stale label). Rescue accounting, the missed-wake counters, and the record
shape are unchanged — this is a label-correctness fix only.

## Acceptance

- [ ] `buildMissedWakeRecord` at the git-heartbeat call site records the
  metadata-poll fast path, not "fsevents".
- [ ] No other backstop record still hardcodes the stale "fsevents" label.
- [ ] Rescue accounting / missed-wake counters are byte-for-byte unchanged.

## Done summary
Relabeled the git-heartbeat missed-wake record's fastPath from 'fsevents' to 'metadata-poll' to name the fn-921 poll-only producer, and updated the faithful test mirror. Rescue accounting and counters unchanged.
## Evidence
