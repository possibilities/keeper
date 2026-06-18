## Description

**Size:** M
**Files:** cli/keeper.ts, cli/plan.ts (new), test/keeper-cli.test.ts, test/plan-shim.test.ts (new)

### Approach

Add `"plan"` as a keeper subcommand that execs the compiled `~/.local/bin/planctl` with full passthrough — the human-facing alias for `planctl <verb>`, the hot path keeps calling `planctl` directly. New `cli/plan.ts` exports `main(argv)`: resolve the binary once at startup (`Bun.which("planctl") ?? join(homedir(), ".local/bin/planctl")`, fail-loud exit 127 if missing), then `Bun.spawnSync({ cmd: [bin, ...argv], stdin: "inherit", stdout: "inherit", stderr: "inherit" })` and `process.exit(result.exitCode ?? (result.signalCode ? 128 + signalNum(result.signalCode) : 1))`. The dispatcher already hands the handler `argv.slice(1)`, so `keeper plan claim X` → handler gets `["claim","X"]` → planctl sees `claim X` (the `plan` token is already stripped — do NOT re-prepend). No `shell:true`, no `pipe`. Mirror the passthrough shape of `plugin/bin/git` and the test shape of `test/git-wrapper.test.ts`.

### Investigation targets

**Required** (read before coding):
- cli/keeper.ts:26-42 — `SUBCOMMANDS` tuple (add `"plan"`)
- cli/keeper.ts:45-81 — `USAGE` block (add a `plan` line; prune the stale ":4 four TUI subcommands" comment)
- cli/keeper.ts:147-168 — `handlers` map is `Record<Subcommand,…>` (exhaustive — add `plan:` wiring or TS errors)
- test/keeper-cli.test.ts:46 — `makeHarness()` hand-lists every handler key (add `plan: mkHandler("plan")`)
- test/keeper-cli.test.ts:173-195 — `isSubcommand` test hand-lists each name (add a `plan` assertion)
- plugin/bin/git — canonical `exec "$REAL_GIT" "$@"` full-passthrough shim to mirror
- test/git-wrapper.test.ts:18-34 — spawn helper resolving binary via `import.meta.dir`; asserts code/stdout/stderr — the exact conformance-test shape

**Optional**:
- cli/setup-tmux.ts:99-110 — injectable `SyncSpawnFn` seam for unit-testing argv without a real subprocess

### Risks

- Adding `"plan"` to `SUBCOMMANDS` WITHOUT updating the handler map (cli/keeper.ts:147) AND the two hand-listed test sites breaks the build/test in lockstep — three sites move together.
- `result.exitCode` is `null` on signal death; the `?? 1` fallback must not mask a signal exit (map `signalCode` → `128+n`).
- Bun can print an extra "exited with code N" banner if `process.exit` isn't the terminal statement (Bun #5455) — always reach it.

### Test notes

`test/keeper-cli.test.ts` is in the fast-tier ignore list — the conformance test runs ONLY under `bun run test:full`. New `test/plan-shim.test.ts` must assert: `plan` token stripped + residual argv forwarded verbatim; stdin piped through; exit code propagated; the trailing `planctl_invocation` NDJSON trailer survives byte-intact; missing-binary → exit 127. Capture a `planctl <verb>` baseline (help + a representative verb across `--format`) as the golden fixture this test asserts against.

## Acceptance

- [ ] `keeper plan <verb> [args]` produces byte-identical stdout/stderr/exit-code to `planctl <verb> [args]`, including the `planctl_invocation` trailer
- [ ] stdin is forwarded (a verb reading piped stdin works through the shim)
- [ ] missing `~/.local/bin/planctl` → fail-loud exit 127 (never silent 0)
- [ ] signal death (SIGINT) maps to `128+signal`, not a masked 1
- [ ] `SUBCOMMANDS` + handler map + both hand-listed `test/keeper-cli.test.ts` sites updated; `bun run test:full` green
- [ ] `cli/keeper.ts` USAGE has a `plan` line; the stale "four TUI subcommands" comment is pruned
- [ ] fully reversible: no source moved, revert = delete `cli/plan.ts` + the 3 one-line dispatch edits

## Done summary
Added 'keeper plan <verb>' exec-shim (cli/plan.ts) execing the compiled planctl with full stdin/stdout/stderr passthrough, 128+signal mapping, and exit-127 on missing binary; wired plan into the dispatcher + both keeper-cli test sites; conformance test (test/plan-shim.test.ts) asserts byte-identical output to planctl detect including the planctl_invocation trailer. Fully reversible.
## Evidence
