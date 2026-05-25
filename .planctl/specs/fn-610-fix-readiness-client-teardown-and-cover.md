## Overview

Two findings survived the fn-609 close audit, both against
`src/readiness-client.ts` and its new test file. One is a real
teardown defect — the terminal-error branch leaves `pollTimer`
running, which keeps the event loop alive when a consumer overrides
`onFatal` with a non-exiting callback. The other is a coverage gap
against a load-bearing invariant the prior spec named explicitly:
the capped-backoff reconnect (250 ms → 5000 ms, doubling per
attempt) is not exercised by any test in `test/readiness-client.test.ts`.

Bundled in one task because both touchups land in the same two files
and share the same theme — readiness-client lifecycle robustness +
coverage of named invariants.

## Acceptance

- [ ] Terminal-error branch in `src/readiness-client.ts:418-439` clears `pollTimer` (or delegates to `teardownConnection()`) before invoking `onFatal`, so a non-exiting custom `onFatal` cannot leave a live `setInterval` holding the event loop open.
- [ ] The terminal-error test in `test/readiness-client.test.ts` (currently asserts `sock.ended === true`) gains a companion assertion that no `setInterval` is still pending after `onFatal` fires.
- [ ] New test exercises the reconnect-backoff path: repeated `connect` failures via the mock `ConnectFactory` produce a delay sequence that starts at `INITIAL_BACKOFF_MS` (250 ms), doubles each attempt, and caps at `MAX_BACKOFF_MS` (5000 ms).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Real localized teardown defect — terminal-error branch sets `shuttingDown` and ends the socket but never clears `pollTimer`. Verified at `src/readiness-client.ts:418-439`; the `teardownConnection()` helper at lines 443-447 already clears it correctly but is not called from this branch. Non-exiting custom `onFatal` callers would observe the helper holding the event loop open. |
| F2 | kept | .1 | Spec line 18 of `fn-609-cover-readiness-client-lifecycle-and.1` names capped-backoff reconnect (250 ms → 5000 ms doubling) as a load-bearing invariant; no test in `test/readiness-client.test.ts` covers it. The mock `ConnectFactory` infrastructure introduced in fn-609 makes coverage mechanically straightforward. |
| F3 | culled | — | Style/doc suggestion to comment the `as unknown as Promise<ReadinessSocket>` double-cast. No behavioral or readability surprise — the cast is acknowledged-safe in the auditor report itself. |
| F4 | culled | — | Internal test-mock comment polish on why `end()` resolves `resolveDone`. No impact on test correctness or production behavior. |
| F5 | culled | — | Style/doc suggestion to comment the `import.meta.main` guard. The guard is the standard Bun idiom; future readers will recognize it. |
| F6 | culled | — | `process.exit(1)` default for `onFatal` is correct; mocking `process.exit` to pin a test is a testability nicety, not a remediation of any defect. |
| F7 | culled | — | Audit-metadata observation about commit `96e2bbe` missing a `Task:` trailer. No code impact; the change itself was a behavior-identical async refactor of the test mock. |

## Out of scope

- Mocking `process.exit` to add a default-`onFatal` test (F6) — the default behavior is already correct.
- Retroactively adding `Task:` trailers to historical commits (F7).
- Any change to `scripts/board.ts` or `scripts/autopilot.ts` — both findings are localized to `src/readiness-client.ts` and its test file.
