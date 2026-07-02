## Description

**Size:** S
**Files:** src/daemon.ts, src/reducer.ts, test/ (fold tests)

### Approach

Attribute reaps: the Killed mint (daemon.ts:4010-4046) stores {pid, start_time, close_kind}
and DispatchExpired (daemon.ts:5301-5340, producer :5674) stores {verb, id} — neither says
why. Add a reason field to both event payloads at mint time (what the producer knows:
expiry-timeout with the deadline, window-gone with close_kind context, kill-source). Fold
reads must default safely for the 2,071 historical events that lack the field — never throw
in a fold, zero-event-consistent defaults, refold-equivalence green. close_kind stays what it
is (how the session died); reason is why keeper acted. Surface the field wherever jobs
project (query jobs, show-job).

### Investigation targets

**Required** (read before coding):
- daemon.ts:4010-4046, 5301-5340, 5674 — the two mints + producer
- src/exec-backend.ts:482 classifyCloseKind — the existing how-died taxonomy to not duplicate
- reducer jobs fold — where the new field folds

### Risks

- This is an event payload addition, not a schema column — confirm no SCHEMA_VERSION bump is needed; if a jobs column IS added, the same-commit keeper/api.py whitelist + fixture regeneration rule applies.

### Test notes

Fold test: historical payload without reason folds to the safe default; new payload carries
it; refold-equivalence green.

## Acceptance

- [ ] Killed + DispatchExpired events carry reason at mint; jobs projection exposes it
- [ ] Historical events fold to safe defaults; refold-equivalence green

## Done summary
Killed and DispatchExpired reaps now carry a producer-stamped reason: Killed folds onto a new nullable jobs.kill_reason column (schema v103, orthogonal to close_kind) exposed in query jobs + show-job; DispatchExpired carries a reason on its event blob. Historical events fold to NULL with re-fold determinism preserved.
## Evidence
