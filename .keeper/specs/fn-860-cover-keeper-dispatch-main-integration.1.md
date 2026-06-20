## Description

Add `main()`-level integration coverage for `cli/dispatch.ts`, which today
has none (confirmed: `main` is never imported in `test/keeper-cli.test.ts`;
only the pure seams are tested). Bundles three audit findings that share
one root cause — the command entry point is untested — and all land in the
same test file as one commit:

- **F5** (cli/dispatch.ts:308-325): the four mode mutual-exclusion
  `argFault` exit-2 branches (positional + `--prompt` together; neither
  supplied; `--prompt` + `--prompt-file` together; >1 positional).
- **F6** (cli/dispatch.ts:369-383): the free-form `--prompt-file`
  read-failure (`die` → exit 1) and the `validatePromptBytes` rejection
  wired through `main` (exit 2) — the leaf is unit-tested, its integration
  is not.
- **F7** (cli/dispatch.ts:400-416): the `--dry-run` output path and the
  successful / failed (`result.ok === false` → die) launch branches.

F7 requires making the launch seam injectable: `resolveExecBackend(...)
.ensureLaunched` is currently called directly inside `main`, so inject it
like the existing `QueryFn` seam so a launch test runs without a real tmux
backend. Drive `main()` with a captured exit/stdout/stderr shim (the
keeper-cli test already has an `ExitError`-tagged shim to reuse).

## Acceptance

- [ ] Each of the four exit-2 arg-fault branches asserted via `main()`.
- [ ] `--prompt-file` read-failure asserts exit 1; `validatePromptBytes`
      rejection through `main` asserts exit 2.
- [ ] `--dry-run` output and both launch-result branches covered with an
      injected/faked launch backend.

## Done summary
Added main()-level integration coverage for cli/dispatch.ts: injected a LaunchFn launch seam (and QueryFn) via MainDeps so launch tests run with a fake backend, and covered the arg-fault exit-2 branches, free-form prompt-file/validate paths, and dry-run/launch-result branches.
## Evidence
