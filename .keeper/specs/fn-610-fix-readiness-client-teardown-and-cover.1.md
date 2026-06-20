## Description

Bundles two findings from the fn-609 close audit. Both touch
`src/readiness-client.ts` + `test/readiness-client.test.ts` and
share a "harden + cover lifecycle invariants" theme — natural to
land in one commit.

**F1 — pollTimer not cleared in terminal-error branch.** At
`src/readiness-client.ts:418-439`, when a terminal `error` frame
arrives (the `bad_frame` / `unknown_collection` branch where no
collection has `gotResult`), the code sets `shuttingDown = true`,
calls `currentSock?.end()`, then invokes `onFatal(...)`. It does
NOT call `clearInterval(pollTimer)`. The `teardownConnection()`
helper at lines 443-447 already clears `pollTimer` correctly but
is not called from this branch. With the default `onFatal`
(`process.exit(1)`) the leak is invisible because the process
exits, but a custom `onFatal` that returns rather than exits would
leave a live `setInterval` holding the event loop open
indefinitely. The terminal-error test at
`test/readiness-client.test.ts:639` asserts `sock.ended === true`
but does not assert that no `setInterval` is pending after
`onFatal` fires.

**F2 — reconnect-backoff path uncovered.** Spec line 18 of
`fn-609-cover-readiness-client-lifecycle-and.1` names capped-backoff
reconnect (250 ms → 5000 ms doubling, `INITIAL_BACKOFF_MS *
2 ** (attempt - 1)` capped at `MAX_BACKOFF_MS`, implemented at
`src/readiness-client.ts:524-525`) as load-bearing. No test in
`test/readiness-client.test.ts` exercises it. The mock
`ConnectFactory` infrastructure introduced in fn-609 (which
lets a test inject sequential connect outcomes) makes a delay-
sequence test cheap.

## Acceptance

- [ ] Terminal-error branch in `src/readiness-client.ts` clears `pollTimer` (either inline via `clearInterval(pollTimer); pollTimer = null;` or by delegating to `teardownConnection()`) before invoking `onFatal`.
- [ ] The existing terminal-error test in `test/readiness-client.test.ts` gains an assertion that no `setInterval` is pending after `onFatal` fires (e.g. by spying `setInterval`/`clearInterval` or by relying on a Bun-supported timer-leak probe).
- [ ] New test in `test/readiness-client.test.ts` drives the mock `ConnectFactory` to reject N times in a row and asserts the observed inter-attempt delays follow the expected sequence: 250 ms, 500 ms, 1000 ms, 2000 ms, 4000 ms, 5000 ms (capped) for subsequent attempts. Use a fake-timer or `Bun.sleep` interceptor to keep the test deterministic and fast.
- [ ] Both new assertions pass; no existing tests modified or weakened.

## Done summary
Terminal-error branch now teardownConnection()s before onFatal so a non-exiting custom callback can't pin the event loop open; added F1 setInterval-leak spy assertion and a new test that drives the mock ConnectFactory to reject in sequence and asserts the 250/500/1000/2000/4000/5000/5000 ms capped-backoff delays.
## Evidence
