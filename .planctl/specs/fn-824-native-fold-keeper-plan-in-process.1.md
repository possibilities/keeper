## Description

**Size:** M
**Files:** cli/plan.ts, cli/keeper.ts (no change expected), package.json, plugins/plan/src/cli.ts (entrypoint guard if needed)

### Approach

Replace the exec-shim body of `cli/plan.ts:main(argv)` with an in-process call into the plan verb dispatcher exported by `plugins/plan/src/cli.ts`. Add an exported `run(argv)` (or equivalent) to the plan CLI that the keeper subcommand calls, and guard `plugins/plan/src/cli.ts`'s top-level run behind `import.meta.main` so importing it is inert (mirrors keeper's `cli/git.ts` pattern). Hoist `js-yaml` + `yaml` into keeper's root `package.json` so the import resolves from keeper's node_modules. Delete `resolveBinary`/`Bun.spawnSync`/exit-mapping — the in-process path uses the verb's own `process.exit`. Keep `install.sh` §6d (binary build/promote) UNTOUCHED this epic.

### Investigation targets

**Required**:
- cli/plan.ts — the shim to replace (resolveBinary, spawnSync, exitCodeFor)
- plugins/plan/src/cli.ts — the dispatcher; confirm its entrypoint runs only under `import.meta.main` (add the guard if it runs on import)
- cli/git.ts:5-11 — the canonical "subcommand module is inert on import" pattern
- test/plan-shim.test.ts (or the fn-822 conformance test) — adapt from exec-assertion to in-process
- plugins/plan/package.json — the deps (js-yaml, yaml) to hoist

### Risks

- plan's `cli.ts` may `process.exit` or run side-effects on import → guard behind `import.meta.main`, export a pure `run(argv)`.
- Two `bun.lock`/dep trees (keeper root + subtree) — confirm the hoisted deps resolve; a workspace decl may be needed.

### Test notes

`bun run test:full` (the conformance test is fast-tier-ignored). Assert `keeper plan status`/`keeper plan --help` match `planctl` byte-for-byte, stdin forwards, exit codes propagate.

## Acceptance

- [ ] `cli/plan.ts` imports + calls the plan dispatcher in-process; no `exec`, no `Bun.which`
- [ ] importing `plugins/plan/src/cli.ts` is inert (guarded entrypoint)
- [ ] js-yaml + yaml resolve from keeper's package graph
- [ ] conformance test green in-process under `bun run test:full`; the `planctl` binary build is untouched

## Done summary
keeper plan now runs the planctl verb dispatcher in-process (cli/plan.ts imports plugins/plan/src/cli.ts main(), no Bun.which/exec); hoisted js-yaml+yaml into keeper's package graph, enabled allowImportingTsExtensions for the subtree imports, and rewrote the plan-shim conformance test to assert in-process byte-parity against the real planctl binary. Full suite green; the standalone planctl binary still builds untouched.
## Evidence
