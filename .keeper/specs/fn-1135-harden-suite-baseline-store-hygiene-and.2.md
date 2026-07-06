## Description

Finding F2 (src/baseline-worker.ts:489). runDetached resolves the run promise
only on the child's close event, which waits for stdout/stderr EOF. The
deadline timer (line 481) SIGKILLs the process group via killGroup but never
force-resolves the promise. A suite that spawns a grandchild which double-forks
out of the group and keeps the inherited pipe open defers close indefinitely,
wedging the single-slot runner permanently (inFlight stuck true — the daemon
stays up but computes no further baselines). This violates the module's stated
"no zombie survives / never wedge" aim, and the audit flagged this exact
deadline->close path as the one runtime behavior not exercised by a test.

After killGroup, arm a bounded hard force-resolve (a short pipe-drain grace
timer, or resolve on exit plus a grace) so the run always terminates to a
timeout outcome (exitCode 124 / timedOut true) even if close never fires. Keep
the existing close path as the normal resolution. Exercise the deadline
liveness path through the module's injectable seam so it is no longer untested.

Files: src/baseline-worker.ts

## Acceptance

- [ ] A deadline that fires with a child whose close never arrives still resolves runDetached to a timeout outcome within a bounded grace; inFlight is released.
- [ ] A test drives the deadline->force-resolve liveness path through the runner's injectable seam.

## Done summary

## Evidence
