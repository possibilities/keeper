## Description

**Size:** M
**Files:** src/baseline-worker.ts, src/daemon.ts, test/baseline-worker.test.ts

### Approach

The supervised producer. A worker on the standard contract (isMainThread
guard, own read-only DB connection only if it prepares statements —
likely none, typed {kind}/{type} messages, supervisor-owned lifecycle,
spawned by main after migrate+boot-drain) polls the request spool with a
setTimeout-after-completion loop and an in-flight skip flag. Per request:
dedupe onto the in-flight computation when the key matches; otherwise
provision the detached scratch worktree (task 2), run
`bun install --frozen-lockfile` (lifecycle scripts stay blocked — never
--trust/--all), run the test-gate phase only (not the opentui phase) in
its own detached process group under an AbortController deadline with a
bounded parallel cap, retry failed tests once at the same sha, classify
via the task-1 verdict logic, write the result leaf atomically, and reap
the worktree on every outcome including crash and timeout (kill the
process group, then consume the exit — no zombies). Queue depth is
bounded with oldest-first processing; runner concurrency starts at 1. On
boot the worker prunes orphaned scratch worktrees and treats interrupted
computations as fresh misses. Every failure is caught inside the loop and
folded into an infra-error or timeout leaf — nothing escapes to
main's onerror/fatalExit, and a red or flaky suite must never crash-loop
the daemon. Export the decision core (spool ordering, dedupe, deadline
bookkeeping, reap decisions) pure for tests.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/builds-worker.ts:1-90 — the poll-loop archetype: setTimeout-after-completion, in-flight flag, transient failures contained inside the loop
- src/maintenance-worker.ts:1-50 — the producer-side rules this worker lives by: never a fold, never the DB, writes only its own state files
- src/daemon.ts — supervisor wiring for existing workers (spawn-after-boot-drain, typed message plumbing, shutdown handler) and the restart-ledger helpers at :2088-2165
- scripts/test-gate.ts:37 — buildBunTestArgs: the parallel/no-orphans discipline; invoke the gate phase, do not re-derive its flags
- package.json — the test script is two-phase (gate + opentui); the baseline runs the gate phase only

**Optional** (reference as needed):
- src/worktree-git.ts — the task-2 helper surface this worker consumes
- src/notadb-tolerance.ts — the shared transient-tolerance idiom if any DB read appears
- CLAUDE.md worker contract + process invariants — the lifecycle rules main-side wiring must respect

### Risks

- Dep install at an arbitrary sha is the epic's unproven surface: frozen-lockfile install can legitimately fail at old shas (lockfile drift) — that is infra-error: install, not a retry loop, and the worktree still reaps.
- The suite subprocess is heavy: RSS competes with keeperd and live workers — keep runner concurrency 1 and the parallel cap conservative; a deadline without process-group kill+reap leaks zombie test processes.
- A worker owning external resources (scratch worktrees, in-flight subprocess) must release them in its own shutdown handler.

### Test notes

Pure-seam tests over the exported decision core: spool ordering, same-key
dedupe/coalescing, deadline expiry to timeout verdict, reap-on-every-path
decisions, boot-prune planning, install-failure classification. No test
spawns a Worker, subprocess, or git — the daemon wiring is asserted by
module shape (inert import) and production is the integration net.

## Acceptance

- [ ] With the daemon running, a spool request for an uncomputed key produces exactly one computation whose leaf lands atomically, and concurrent same-key requests coalesce onto it
- [ ] The suite runs gate-phase-only inside a detached process group under a deadline; deadline expiry yields a timeout leaf with the group killed and reaped
- [ ] Checkout, install, and spawn failures yield infra-error leafs of the right kind, the scratch worktree is reaped on every outcome, and boot prunes any orphaned scratch worktree
- [ ] No path writes keeper.db, mints a synthetic event, or adds an RPC surface; a red or flaky suite never escalates to fatalExit
- [ ] The suite is green via the sanctioned fast gate

## Done summary

## Evidence
