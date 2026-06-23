## Description

**Size:** M
**Files:** plugins/plan/test/harness.ts, plugins/plan/src/cli.ts, plugins/plan/src/emit.ts, plugins/plan/src/store.ts, plugins/plan/src/yaml_input.ts, plugins/plan/src/submit_common.ts

### Approach

Replace `runCli`'s compiled-binary spawn with an IN-PROCESS call to
`main(argv)` (`cli.ts:1107`), eliminating ~414 process spawns AND the
`bun run build` dependency in one harness change — still with real git at
this step (the VCS fake is the next task). In `runCli`, set `process.env`
to `buildEnv(...)` and `process.chdir(opts.cwd)`, capture
`process.stdout/stderr.write` into strings, and make `process.exit` throw a
private `ExitCode` carrier; restore everything in `finally`. Reset
`emit.ts`'s process-lifetime `selfEmitted` sentinel at the start of each
invocation (add `resetSelfEmit()`), or it leaks across in-process calls.
Add a tiny stdin-provider seam (default `readFileSync(0,"utf-8")`, test
override returns `opts.input` + controls `isTTY`) used by the fd-0 readers
(`store.ts:61`, `yaml_input.ts`, `submit_common.ts`), since in-process
can't faithfully replace fd 0. The three tests that intentionally exercise
the compiled binary / process boundary move to a `KEEPER_PLAN_RUN_PROCESS`
slow bucket (or are rewritten onto `runCli`).

### Investigation targets

**Required** (read before coding):
- plugins/plan/test/harness.ts:42 (`BIN`), :155 (`runCli`), :140-175 (`RunOptions`/decode)
- plugins/plan/src/cli.ts:1107 (`main(argv): number`) — the in-process entry
- plugins/plan/src/emit.ts — the `selfEmitted` sentinel that must reset per call
- plugins/plan/src/store.ts:61, yaml_input.ts, submit_common.ts — the fd-0 stdin readers needing the seam

**Optional** (reference as needed):
- plugins/plan/src/verbs/*.ts — the per-verb `runX()` handlers `main` dispatches to

### Risks

- Globals (`cwd`, `env`, stdout/stderr, `selfEmitted`) leak across
  in-process calls — restore in `finally`, reset in `afterEach`.
- A verb calling `process.exit` mid-run must unwind cleanly via the thrown
  `ExitCode` so the harness still returns `{code,stdout,stderr}`.

### Test notes

Keep `KEEPER_PLAN_BIN` honored for the slow process bucket. Verify a
representative verb (init, scaffold, reconcile) returns the identical
`{code,stdout,stderr}` shape in-process as it did spawned.

## Acceptance

- [ ] `runCli` dispatches `main(argv)` in-process; the default plan `bun test` requires no `bun run build` and spawns the binary zero times
- [ ] `selfEmitted` is reset per invocation; env/cwd/stdout/stderr/exit are captured and restored in `finally`
- [ ] A stdin-provider seam feeds `opts.input` to the fd-0 readers
- [ ] Process/compiled-binary-specific tests are quarantined to `KEEPER_PLAN_RUN_PROCESS`; the rest pass in-process

## Done summary
runCli now dispatches main(argv) in-process (no bun run build, zero binary spawns); env/cwd/stdout/stderr/exit captured+restored in finally, selfEmitted reset per call, a stdin-provider seam feeds opts.input to the fd-0 readers, and git/gh spawns get explicit env so the fixture identity/PATH-shim propagate. Process-boundary tests quarantined to KEEPER_PLAN_RUN_PROCESS.
## Evidence
