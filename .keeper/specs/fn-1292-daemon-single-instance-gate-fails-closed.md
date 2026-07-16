## Overview

keeperd's single-instance flock gate is the sole protection of the event store's sole-writer invariant, but it fails OPEN on an inconclusive lock. `decideSingleInstanceGate` correctly classifies a THROWN lock primitive (EPERM/ENOSPC/EROFS on the lockfile, a broken flock) as `degraded` — but the consumer `acquireSingleInstanceLock` logs and BOOTS ANYWAY on degraded, letting a second daemon migrate and write the same keeper.db (silent dual-writer corruption of the event store), exactly when the host is already unhealthy. This epic makes the degraded outcome fail CLOSED: exit non-zero before any DB open, mirroring the existing live-incumbent (`refused`) branch. Aligns with ADR 0003 (fail-fast for the critical sole-writer invariant); distinct from the fn-1286/ADR-0059 non-critical-degrade class.

## Quick commands

- `bun test test/single-instance-lock.test.ts` — the pure truth-table home (existing + new consumer-action rows)
- `bun run test:gate` — the named deterministic fast gate (root-phase auto-discovers this file)
- `rg -n 'fail OPEN|boots anyway|booting WITHOUT the' src/daemon.ts docs/adr/0030-*.md` — should return nothing after the fix (all stale fail-open language inverted)

## Acceptance

- [ ] An inconclusive/throwing lock primitive causes the daemon to exit non-zero BEFORE opening the DB, migrating, or appending a boot-ledger entry — never boots ungated.
- [ ] A live incumbent (`refused`) still exits exactly as before; a clean acquisition (`acquired`) still proceeds and pins the lock.
- [ ] The degraded exit emits an operator diagnostic naming the lock path and the underlying error, and its exit code is distinguishable from the refused exit.
- [ ] All source comments and ADR 0030's decision text describe fail-closed-on-inconclusive; no doc or comment still frames degraded as intended fail-open.

## Early proof point

Task that proves the approach: `.1` (the whole fix). If the pure-seam extraction proves entangled with `acquireSingleInstanceLock`'s singleton assignment, fall back to an inline degraded-branch change mirroring refused + a narrower seam that returns only the exit decision.

## References

- docs/adr/0030-single-instance-gate-and-restart-provenance.md (Decision point 1, line ~15 — documents the fail-open verbatim; this epic revises it in place)
- docs/adr/0003-fatal-exit-over-self-heal.md (the doctrine this fix aligns with — fatalExit over in-process self-heal; no edit needed)
- `fn-1286-daemon-rides-through-subsystem-failure` (overlap): edits src/daemon.ts in different regions (serve-liveness watchdog, paging) — dep wired for same-file fan-in ordering. Its degrade-in-place class (ADR 0059) is the OPPOSITE direction and correct for a NON-critical subsystem; this gate is critical, so it fails closed.
- sol review M8 (the finding); gate introduced whole by fn-1222 (commit 2077a272).

## Docs gaps

- **docs/adr/0030-single-instance-gate-and-restart-provenance.md**: revise Decision-point-1 ("An inconclusive primitive … logs loudly and boots anyway") in place to fail-closed, and amend the Consequences (the dual-writer window now closes on the inconclusive-lock edge too, not only the live-incumbent case).

## Best practices

- **Fail-closed for a sole-writer integrity gate:** any non-clean-acquisition exits before side effects — "couldn't prove exclusivity → deny" is the canonical rule; fail-open here is a denial-of-integrity primitive. [SQLite single-writer; fail-secure-for-integrity consensus]
- **Side-effect-free exit + launchd throttle is the backoff:** a persistently-broken-lock fail-closed loop is the correct loud steady-state (beats silent corruption); do NOT add an in-process retry (violates no-self-heal) and do NOT suppress it via KeepAlive SuccessfulExit. [launchd ThrottleInterval]
- **Classify by errno, collapse is intentional:** EWOULDBLOCK/EAGAIN = held-by-other (refused); every other throw = inconclusive (degraded) — both fail closed, one action covers all non-contention throws. [POSIX fcntl/flock]
