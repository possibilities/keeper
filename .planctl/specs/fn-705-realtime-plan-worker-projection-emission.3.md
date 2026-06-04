## Description

**Size:** M
**Files:** src/plan-worker.ts, src/daemon.ts, test/plan-worker.test.ts

Close the last non-realtime case: a brand-new epic scaffolded+committed in
a repo keeper has never seen a session in. The plan-worker watches
CONFIGURED roots so it sees the new epic file appear via FSEvents (bounces
to `pending`, not in HEAD — correct). But the git-worker discovers repos
from seen-cwds, so it isn't watching that repo's `.git`; the commit
produces no DB write (so T1's poll never wakes), and the commit doesn't
change the file bytes (so no second FSEvent fires on the file). The
in-HEAD transition has no realtime trigger. Fix: the plan-worker watches
`.git/logs/HEAD` for any repo where it currently holds a `pending` path —
a commit always appends there — and re-checks that repo's pending paths on
the append (now in HEAD → emit). Independently nudge git-worker discovery
when the plan-worker first sees a `.planctl` tree in an unwatched repo, so
attribution/GitSnapshot data flows normally thereafter.

### Approach

- When a path enters `pending`, ensure the owning repo's `.git/logs/HEAD`
  is covered by an `@parcel/watcher` subscription (reuse the existing
  watcher infra; `repoRootFromPlanctlPath`, `src/plan-worker.ts:1441`,
  gives the repo root). On an append event, run `recheckPending()` scoped
  to that repo's pending paths. Drop the `.git/logs/HEAD` watch when the
  repo has no remaining pending paths (keep subscriptions bounded).
- Treat the watch as a hint per the FSEvents discipline: `fstat`/probe
  on fire, never trust the event as data; idempotent re-check.
- Discovery nudge: when `discoverPlanctlDirs` first surfaces a `.planctl`
  root the worker hadn't seen, post a message → main → git-worker to add
  that root to its discovery candidates immediately (the git-worker's
  `.planctl` short-circuit in `shouldWatchRoot` then subscribes it),
  rather than waiting for the next full discovery sweep. Respect the
  `planWorkerRef`/worker forward-ref ordering (`src/daemon.ts:1494,2077`).
- Preserve fn-629: the `.git/logs/HEAD`-triggered re-check runs the GATED
  `recheckPending()` (re-probes `isPathInHead`); it does NOT blanket-pass
  `triggeredByCommit=true`. Only the genuinely git-proven commit channel
  keeps that bypass.

### Investigation targets

**Required** (read before coding):
- src/plan-worker.ts:1131-1138 (`recheckPending`), :1400 (`isPathInHead`), :1441 (`repoRootFromPlanctlPath`), :1693 (`discoverPlanctlDirs`), the `@parcel/watcher` subscribe site in worker main (~:1920-2101), :311-315 (`InboundMessage` union — add the new message type)
- src/git-worker.ts — `discoverProjectRoots` / `buildDiscoveryCandidates` / `shouldWatchRoot` `.planctl` short-circuit (the discovery-nudge target); reconcileRoots subscribe path
- src/daemon.ts:1494,2077 — `planWorkerRef` forward-ref ordering; the main↔worker message plumbing for the discovery nudge

**Optional** (reference as needed):
- The arthack deploy pipeline's `.git/logs/HEAD` inotify trigger (precedent for using the reflog append as a commit signal)
- test/plan-worker.test.ts — pending-set + watcher tests to extend

### Risks

- `.git/logs/HEAD` watch lifecycle: must add on first pending path for a repo and drop when pending clears, or subscriptions leak per repo. Bound and test teardown.
- `core.logAllRefUpdates=false` repos have no `.git/logs/HEAD`. Fall back to watching `.git/HEAD` or the packed-refs/HEAD mtime; T1's poll still covers any repo that produces a DB write, so this only matters for the truly-unwatched case — degrade gracefully (the lowered heartbeat is the final floor).
- Discovery-nudge ordering: the forward-ref tolerates a null worker ref; a nudge before the git-worker is ready must be a tolerated no-op.

### Test notes

- Integration: scaffold+commit an epic in a tmp repo NOT in the git-worker's candidate set; assert the EpicSnapshot emits on the `.git/logs/HEAD` append without a heartbeat-length wait.
- Assert the `.git/logs/HEAD` subscription is dropped once the repo's pending set empties.

## Acceptance

- [ ] A brand-new epic scaffolded+committed in a repo keeper has never watched emits realtime (test asserts no heartbeat-length wait)
- [ ] The `.git/logs/HEAD` (or fallback) watch is added when a repo gains a pending path and dropped when its pending set empties — no subscription leak
- [ ] The reflog-triggered re-check runs the gated `recheckPending()` (re-probes in-HEAD); no `triggeredByCommit=true` bypass, no fn-627 regression
- [ ] Discovery nudge: a newly-seen `.planctl` root is handed to git-worker discovery immediately, tolerating the forward-ref null window
- [ ] Graceful degrade where `.git/logs/HEAD` is absent; the lowered heartbeat remains the final floor
- [ ] `bun test test/plan-worker.test.ts` passes; no leaked watchers/timers under `--isolate`

## Done summary

## Evidence
