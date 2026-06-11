## Description

Closes the dash process-shell test-coverage gap surfaced as audit findings
F4 and F5 on fn-780. Both land in one commit because they cover the same
layer (`src/dash/app.ts` process shell + its forked `src/dash/exit-triggers.ts`)
and naturally share a test file — file-touch overlap and a single
exit/teardown theme.

- **F4** (`createDashApp`, src/dash/app.ts:404-476): the process shell has no
  direct test. `armExitTriggers` was pulled out as `defaultArmExitTriggers`
  and made injectable "so {@link createDashApp} can take an injected stub" —
  use that seam. Assert: the `exited` idempotency flag (exit runs once across
  repeated triggers), that `app.destroy()` precedes `process.exit`, that the
  three subscription handles + the elapsed interval + the triggers are all
  disposed/disarmed on teardown, and that `onFatalError`
  (uncaughtException/unhandledRejection) routes through the same restore-then-exit
  tail with exit code 1 and a stderr write.
- **F5** (src/dash/exit-triggers.ts): `armViewerExitTriggers` is a verbatim
  fork of the tested `src/view-shell.ts` original (signature, `ppidPollMs`/
  `initialPpid` knobs, TTY guard, `resume()`, ppid===1 poll). Add coverage
  for its arm/disarm behavior, or a parity assertion / fork-source-commit pin,
  so the fork cannot drift silently from its source.

## Acceptance

- [ ] A direct test exercises `createDashApp` via the injectable `armExitTriggers` stub and asserts idempotent teardown, destroy-before-exit, full handle disposal, and the onFatal/uncaughtException exit-1 routing.
- [ ] `armViewerExitTriggers` has dedicated coverage or a parity/source-pin guarding against silent drift from `src/view-shell.ts`.
- [ ] New tests are wired into the correct tier per the repo's two-tier convention (and the `test:opentui` / fast-tier ignore lists if they touch the OpenTUI materializer).

## Done summary
Added test/dash-shell.test.ts covering createDashApp teardown discipline (destroy-before-exit, idempotent tail, socket+trigger disposal, onFatal exit-1+stderr routing) via new injectable buildRenderer/connect/exit/onProcess seams, plus behavioral + byte-parity coverage of the dash armViewerExitTriggers fork. Wired into the test:opentui serial chain and fast-tier ignore lists.
## Evidence
