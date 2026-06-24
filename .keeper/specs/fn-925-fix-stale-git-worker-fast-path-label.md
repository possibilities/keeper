## Overview

The fn-921 daemon-stability epic made the git-worker poll-only — it no longer
holds an @parcel/watcher subscription; a two-tier .git metadata stat poll is
the fast path. But the heartbeat missed-wake backstop record still hardcodes
`fastPath: "fsevents"`, so the forensic telemetry now misnames the live
producer. This is a small correctness fix to a surface whose only purpose is
incident attribution: an operator debugging a git-surface freeze would read
the stale label and chase the wrong producer.

## Acceptance

- [ ] The git-worker missed-wake backstop record names the actual current fast
  path (the metadata poll), not "fsevents".
- [ ] No change to rescue accounting or the missed-wake counters.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | daemon.ts:4166 lifetime reseed cap is a documented crash-loop guard; restart re-seeds HEAD correctly, no user-visible impact. |
| F2 | kept | .1 | git-worker.ts:2673 hardcodes fastPath:'fsevents' but the producer is now the metadata poll — a forensic label that misleads incident attribution. |
| F3 | culled | — | git-boot-seed.ts comment change-history is a style nitpick, consistent with codebase convention, no impact. |
| F4 | culled | — | Same root cause as F3 — incident-date comment-style preference across workers, advisory only. |

## Out of scope

- The lifetime-vs-per-incident reseed-cap question (F1) — the cap is a deliberate, documented crash-loop guard and restart is the well-tested recovery path.
- The forward-facing-comment style sweep (F3/F4) — consistent with the surrounding codebase and carrying no behavior or correctness weight.
- All Test Gap items — the pure decision seams are unit-tested per the no-real-git fast-tier rule; the auditor confirmed the slow-tier wiring is acceptable.
