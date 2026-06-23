## Description

Finding F4. keeper's `cli/pair.ts` orchestration — the launch→wait→show
compose, window reaping, atomic temp-then-rename, and the SIGTERM handler —
has no direct test; only the pure builders/parsers in `src/pair-command.ts`
are unit-tested (`test/pair-command.test.ts`). The load-bearing invariant is
the two-line Monitor contract: exactly one `started` line and exactly one
terminal (`completed`/`failed`) line on EVERY exit path, asserted today only
by the module doc. The highest-value coverage is a failure path (bad
agentwrap path, or `wait-for-stop` exiting non-zero) that still emits exactly
one `started` + one `failed` line.

Add a direct test of `main()` (or the narrowest orchestration entry point)
that drives a failure path and asserts the two-line contract holds. A SIGTERM
reap assertion is desirable if reachable without flake.

## Acceptance

- [ ] A test drives a `cli/pair.ts` failure path and asserts exactly one `started` line plus exactly one `failed` line are emitted.
- [ ] The test sandboxes its state per the repo's test-isolation rules and polls rather than sleeps for any async wait.

## Done summary

## Evidence
