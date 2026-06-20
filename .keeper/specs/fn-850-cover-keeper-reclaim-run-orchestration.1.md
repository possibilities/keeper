## Description

Covers audit findings F4 and F5 (root cause: no `run()`-level integration
coverage of the one irreversible operation). Evidence: cli/reclaim.ts:183-265
is thin dependency-injected glue (`RunDeps` for stdout/stderr/exit) over
already-tested helpers, but the destructive sequence itself — pre-reclaim
snapshot → reclaimDb → verifyReclaim → atomic same-fs swap → `dropSidecars`
(cli/reclaim.ts:261-265) — is asserted by no test. F4 is the happy path; F5
is the daemon-up HARD-GUARD refusal at cli/reclaim.ts:192-202. Both drive
`run()` with injected `RunDeps` against a real temp DB, so they bundle into
one test file touching the same orchestration surface and land as one commit.

## Acceptance

- [ ] A test invokes `run()` against a real temp DB with no daemon and
      asserts: the live `dbPath` now holds the reclaimed (smaller/vacuumed)
      contents, the `.reclaim` output is consumed by the swap, and the OLD
      file's `-wal`/`-shm` sidecars are removed.
- [ ] A test writes a `<sock>.lock` with a live pid and asserts `run()`
      exits 1 via injected `RunDeps.exit`, emits the REFUSING message, and
      leaves the source DB byte-identical (no snapshot/reclaim/swap performed).
- [ ] Tests sandbox all state paths and use the in-process temp-DB helper;
      `bun run test:full` stays green.

## Done summary

## Evidence
