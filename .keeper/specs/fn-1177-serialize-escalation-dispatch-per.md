## Overview

Two concurrent same-repo escalation sessions (resolve::/deconflict::) both resolve
their cwd to the same shared checkout for a lane-into-default conflict and contend
for the working tree — the second burns its worker time parked waiting for the first
to release it. Gate the dispatch sweeps with a per-checkout occupancy guard: a
non-terminal, re-sweepable skip (sibling of at_cap/already_live) so the second
session dispatches only once the checkout frees.

## Quick commands

- bun test test/daemon.test.ts

## Acceptance

- [ ] Same-checkout escalation sessions serialize at the dispatch layer; different
      repos still dispatch concurrently; the deferred row re-sweeps and dispatches
      once the checkout frees, with no marker stamped and no row minted by the skip
