# 5. Compute-once suite baseline over per-worker re-runs

## Status

Accepted.

## Context

Concurrent workers each need to answer "is this test failure pre-existing at my
base commit, or did I cause it?". Left unserved, workers improvise: re-running
the suite against a hand-cleaned tree, historically via `git stash` — which is
banned for workers because the stash stack is repo-global across every linked
worktree and the human's checkout. Per-worker re-runs also multiply cost (N
workers × full suite) and each requires provisioning a clean environment.

## Decision

keeper computes a suite baseline once per key and shares the result with every
asker. The key is `(repo, commit sha, toolchain fingerprint)` — the suite
definition rides the tree at the sha, but the Bun version does not, so the
fingerprint prevents a stale result being served across a toolchain bump.

The flow is file-based and socket-free, composing three existing sole-writer
patterns rather than widening the closed mutating-RPC allowlist:

- The CLI is the sole writer of a state-dir **request spool** (maildir shape).
- A supervised **baseline worker** consumes the spool, provisions a detached
  scratch worktree at the requested sha (`bun install --frozen-lockfile`,
  lifecycle scripts blocked by Bun's default trust posture), runs the test-gate
  phase in its own process group under a deadline, and is the sole writer of
  per-key **result leafs**. Requests for an in-flight key coalesce onto the one
  computation.
- `keeper baseline` reads leafs directly; `--wait` is file-polling with a
  deadline. Because spool and leafs are durable files, a daemon restart simply
  re-derives in-flight work as a fresh miss and readers keep polling.

A result separates "suite ran, tests failed" from "the run could not happen"
(checkout, install, or timeout failure) so an infra error never reads as a
clean baseline. Failed tests retry once at the same sha and both runs are
recorded; verdicts are derived from raw runs, never stored in their place.

Running committed lane-sha code as the daemon user is accepted: autopilot
workers already execute arbitrary repo code in the same single-user trust
domain, so the baseline runner adds no new privilege boundary.

## Consequences

- N workers asking about one sha cost one suite run, and every answer comes
  from the same shared, durable result.
- No new socket or RPC surface: the mutating-RPC allowlist stays closed, and
  reads work even while the daemon is mid-restart.
- Results are trustworthy across toolchain changes because the fingerprint is
  part of the key, at the cost of recomputing after upgrades.
- The runner's scratch worktrees and result files are bounded and reaped;
  retention is eviction, never invalidation, since a key's result is immutable.
- The baseline answers "red at this sha in a healthy environment" — a worker's
  own worktree may still be environmentally broken; that distinction lives in
  worker guidance, and fixing worker-worktree provisioning is out of scope.
