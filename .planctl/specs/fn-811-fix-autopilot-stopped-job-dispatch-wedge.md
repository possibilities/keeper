## Overview

The autopilot dispatcher's dedupe predicate treats every `stopped` jobs row as occupying its plan_ref, but `stopped` is the schema default for both a parked-alive session and a stopped-dead one — so a worker that ends its turn without completing its task (blocked on deps, crashed mid-task) wedges that task out of dispatch indefinitely, and `planctl task reset` cannot recover it (it never touches keeper's jobs projection). The readiness pipeline already classifies such tasks as ready, so the verdict and the dispatch gate disagree about stopped rows. Align the dispatch gate with a liveness-aware occupancy notion.

## Quick commands

- `bun test test/autopilot-worker.test.ts` — the dedupe block
- `bun run test:full` — mandatory for daemon/worker/db-path changes

## Acceptance

- [ ] A ready-and-unclaimed task whose only jobs row is stopped-with-dead-pane gets dispatched; a stopped-with-live-pane session still occupies; the working state still occupies; ended/killed still do not
