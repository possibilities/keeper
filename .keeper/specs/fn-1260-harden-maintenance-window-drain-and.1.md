## Description

Two edges in scripts/maintenance-window.ts, bundled here because they share
the file and the drain/verify orchestration theme and land as one commit.

F1 (awaitDrain, maintenance-window.ts:416): the gate returns as soon as
in_flight.board_work_jobs === 0, but pending_dispatches is a separate
launch-window projection (src/readiness-inputs.ts:58) tracking workers already
spawned but not yet bound. Pausing autopilot does not recall an open pending
dispatch, so such a worker can bind (becoming a board-work job) in the poll gap
between the gate reading zero and stopDaemon() booting keeperd, landing mid-RPC
when the daemon stops. Also gate the drain on the launch-window count reaching
zero (or the in_flight total), so the tool waits for a fully quiet board.

F2 (captureForensicsTerm, maintenance-window.ts:352): the captured term does
.replace(/[%_\]/g, "") to strip LIKE wildcards, but cli/search-history.ts:136
escapeLike ESCAPEs those same chars for a literal LIKE match. A prompt whose
first 32 chars contain a literal % _ or \ yields a stripped term that is no
longer a substring of the stored prompt, so the verify() forensics probe finds
no match and spuriously fails an otherwise-successful reclaim. Escape rather
than strip (mirroring search-history), or drop the strip since search-history
already escapes, so the captured term stays a literal substring.

Files: scripts/maintenance-window.ts (and its orchestration test file).

## Acceptance

- [ ] awaitDrain does not return drained while a launch-window (pending) dispatch is still open.
- [ ] The forensics verify probe matches a prompt containing a literal %, _, or \ in its captured prefix.
- [ ] New/updated orchestration unit tests cover both paths via the injected seams; fast tier stays subprocess-free.

## Done summary

## Evidence
