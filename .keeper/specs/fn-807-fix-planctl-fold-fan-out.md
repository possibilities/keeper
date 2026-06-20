## Overview

Planctl folds (any event with `planctl_op`, a `/plan:plan` opener, or a Commit with a planctl trailer) run `syncPlanctlLinks`, which re-scans every Commit event's JSON blob once per swept session (~40 full scans per fold) while holding the reducer's writer lock — 0.5–1.5s warm per fold today, minutes under memory pressure (the 2026-06-12 487s/437s stall). This epic makes the commit-trailer channel O(1) scans then O(indexed-read), removes the malformed-JSON throw surface from the fold, adds the telemetry that would have attributed the incident in one log line, and lets the UDS server recover connection slots on cap-hit instead of rejecting clients during a wedge.

## Quick commands

- `bun test test/reducer-links.test.ts test/reducer-projections.test.ts` — fold semantics + byte-identity fast check
- `bun run test:full` — mandatory gate (db/server-worker/daemon slow tier)
- `tail -50 ~/.local/state/keeper/server.stderr | grep -E 'fold-slow|breakdown'` — observe the new lock_wait/work + planctl counters on the live daemon

## Acceptance

- [ ] A planctl fold performs exactly one commit-trailer load per `syncPlanctlLinks` call (task 1), and zero blob scans once the projection table lands (task 2)
- [ ] A malformed Commit `data` payload folds to "no trailer facts" — no code path can throw from the commit-trailer channel inside a fold
- [ ] From-scratch re-fold reproduces `commit_trailer_facts` and all link projections byte-identically (migration backfill included)
- [ ] `[fold-slow]` splits lock_wait_ms from work_ms; planctl fan-out counters appear in breakdown lines; PreToolUse folds have breakdown coverage
- [ ] On conn-cap hit, the server synchronously sweeps reapable connections and accepts when space opens; a live board subscriber is never evicted
- [ ] `bun run test:full` green

## Early proof point

Task that proves the approach: `.1` (single-scan hoist with byte-identity preserved). If the in-memory regroup cannot reproduce the per-session scan results byte-identically, fall back to landing the projection table first and pointing the existing per-session loaders at it (order swap, same end state).

## References

- Incident evidence: `~/.local/state/keeper/server.stderr` ~line 48095 (`[fold-slow] id=4237245 dur=486890ms`, `[ptufold-breakdown] jobs_arm=486862ms`); events 4237245 (scaffold fn-33 planctl op) and 4237254 (/plan:plan opener), same session
- Fan-out shape: src/reducer.ts:4959 (`syncPlanctlLinks`), :4863/:4914 (the two blob-scan loaders), :5111 (per-session call site), :2331-2336 (foldCommit trigger)
- Amplifier context (out of scope here): `PRAGMA mmap_size = 4294967296` at src/db.ts:1085 — page-fault amplification under memory pressure; deferred to a post-epic re-evaluation armed separately
- Commit sparse-column gotcha: Commit events carry NULL `planctl_*` sparse columns; trailer facts live only in the JSON payload (`committer_session_id` is in-payload; `events.session_id` on a Commit is the project dir)

## Docs gaps

- **README.md ~83-84/1395/1996-2003**: replace the per-session commit-trailer sweep characterization in place (single-scan, then projection-read)
- **README.md ~519-527**: add new breakdown log-line classes to the telemetry inventory
- **README.md ~1248-1258**: revise the conn-cap paragraph in place (sweep-then-accept policy)
- **README.md ~1490-1940**: one compact forward-facing bullet for schema v67 / commit_trailer_facts
