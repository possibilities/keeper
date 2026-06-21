## Description

**Size:** M
**Files:** src/bus-worker.ts (register + publish identity resolution; bounded ancestry-walk helper), test/bus-worker.test.ts (+ a live-registration integration test, full tier)

Fix Bug A: channels must take their identity from the Claude HARNESS pid,
not the `keeper bus watch` subprocess pid, so `name`/`session_id`/
name_history resolve and agents are reachable by name.

### Approach

In the `register` handler, replace the bare-peer-pid enrichment
(`src/bus-worker.ts:606-607`) with a server-side HARNESS RESOLUTION: walk
the server-resolved peer pid's ancestry (bounded depth, e.g. ≤40 like
chatctl) and select the NEAREST ancestor that has a keeper.db `jobs` row —
since keeper only tracks harness pids, that ancestor IS the Claude harness.
Use that pid to (a) enrich name/title/session_id/name_history (via the
existing `enrichPeerFromJobs` / bus-identity Layer-2 resolver) and (b) be
the channel's stored identity pid. Apply the same harness-resolved identity
to the publish `from` so messages show the real sender. Keep the peer pid as
the anti-spoof ROOT of the walk (a client can only resolve to an ancestor it
is actually descended from). Reuse keeper's existing ppid helper if one
exists; else a bounded `ps -o ppid= -p <pid>` walk in the worker (the worker
already reads process liveness via `isAlive`, so this is within the worker
contract — producers may read process state). Fall back gracefully (name
stays null) when no ancestor has a jobs row (the resume-gap case), exactly
as today.

### Investigation targets

**Required** (read before coding):
- src/bus-worker.ts:606-607 (peerPid enrichment — the bug site), :59/:188-193/:626-645 (peerPid plumbing + channel record), :283-303 (isAlive usage — process-state read precedent)
- src/bus-identity.ts (Layer-2 resolver — it already resolves name/history given a pid; feed it the harness pid)
- src/db.ts:614 (idx_jobs_pid), :622 (jobs.pid), :642 (name_history)
- ~/code/arthack/apps/chatctl/chatctl/identity.py (bounded ancestry-walk shape)

**Optional** (reference as needed):
- src/derivers.ts / src/exec-backend.ts (any existing ppid/process helper to reuse)

### Risks

- macOS has no /proc — use `ps -o ppid=` (bounded, per-registration; registrations are infrequent so the cost is fine).
- Anti-spoof must hold: the walk MUST start from the server-resolved peer pid, never a client-supplied pid; do not trust a client-sent harness pid without verifying ancestry.
- pid reuse: pair the resolved harness pid with its start_time where available (the channel identity is `(pid, start_time)` per the schema).

### Test notes

Unit-test the walk-and-resolve with a synthetic jobs table (`freshMemDb`):
a peer pid whose ancestor chain hits a jobs row resolves to that title;
no-ancestor-with-a-job → null (resume gap). Add a full-tier test that
actually registers over the socket from a process whose ancestor has a jobs
row and asserts the channel carries the title (the gap unit tests missed).

## Acceptance

- [ ] On register, identity is resolved from the nearest ancestor of the peer pid that has a keeper `jobs` row (the harness), not the bare peer pid
- [ ] A live `keeper bus list` channel shows the harness title + session_id (not null); reachable by current AND former name
- [ ] The publish `from` carries the harness-resolved identity
- [ ] Anti-spoof preserved: walk roots at the server-resolved peer pid; no client-supplied pid is trusted unverified
- [ ] Unit + full-tier live-registration tests pass

## Done summary

## Evidence
