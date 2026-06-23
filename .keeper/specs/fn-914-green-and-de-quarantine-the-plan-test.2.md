## Description

**Size:** M
**Files:** plugins/plan/test/src-commit.test.ts, plugins/plan/test/src-cli.test.ts, plugins/plan/test/src-cli-groups.test.ts, plugins/plan/test/src-brief-claim.test.ts, plugins/plan/test/saga-scaffold.test.ts, plugins/plan/test/harness.test.ts, plugins/plan/test/harness.ts, plugins/plan/package.json

### Approach

The ~89 plan tests gated by `describe.skipIf(!SLOW_ENABLED)` /
`skipIf(!PROCESS_ENABLED)` run NOWHERE — no script or CI sets
`KEEPER_PLAN_RUN_SLOW` / `KEEPER_PLAN_RUN_PROCESS`. Resolve each bucket so
nothing is left perpetually skipped. Bias to DELETE (Pantera): any
SLOW/PROCESS test whose coverage is now redundant with the in-process
`main(argv)` dispatch + fake-VCS / synthetic-git coverage fn-904 added is
deleted outright. Keep a test ONLY if it covers something genuinely unique
that the fast tier cannot (e.g. one compiled-binary smoke, real-git format
contract) — and for anything kept, make it actually run: either convert it
to in-process, or wire an explicit `test:slow` / `test:process` npm script
(PROCESS needs a `bun run build` first) and document it. After the pass, no
`skipIf(!SLOW_ENABLED|!PROCESS_ENABLED)` gate may remain without a wired
runner that exercises it. Leave the keeper-root `.slow.test.ts` files alone
— they already run under `test:full`; just confirm + note that.

### Investigation targets

**Required** (read before coding):
- plugins/plan/test/harness.ts — `SLOW_ENABLED` / `PROCESS_ENABLED` definitions and the `KEEPER_PLAN_RUN_*` env reads
- plugins/plan/test/src-cli.test.ts:40+ , src-cli-groups.test.ts, src-commit.test.ts, src-brief-claim.test.ts, saga-scaffold.test.ts, harness.test.ts — the `describe.skipIf(...)` blocks; judge each block's coverage against the in-process/synthetic equivalents
- plugins/plan/package.json — the bare `"test": "bun test --timeout 30000"` (no env); where a `test:slow`/`test:process` script would land if any bucket is kept

**Optional** (reference as needed):
- package.json (root) `test`/`test:full` — how the keeper-root `.slow` quarantine is expressed (ignored by fast tier, run by full) as the model for any kept plan slow tier

### Risks

- Deleting a PROCESS/SLOW test that is the ONLY coverage of a real behavior
  (e.g. compiled-binary arg parsing) silently drops it — for each deletion,
  confirm an in-process/synthetic test already covers the same decision, or
  keep+wire it instead.
- A kept `test:process` script reintroduces the compiled-binary build
  dependency for that tier only — keep it OUT of the default `bun test`.

### Test notes

Final state check: `grep -rnE 'skipIf\(!(SLOW|PROCESS)_ENABLED\)' plugins/plan/test`
returns only gates a wired script runs (or nothing). Default
`cd plugins/plan && bun test` stays fast, in-process, zero real git.

## Acceptance

- [ ] Every `SLOW_ENABLED`/`PROCESS_ENABLED`-gated plan test is deleted or reachable via a wired `test:slow`/`test:process` script — none left perpetually skipped
- [ ] Any kept slow/process tier is a separate npm script (not the default `bun test`) and is documented
- [ ] Default `cd plugins/plan && bun test` stays fast + in-process + zero real git (`test:hygiene` passes)
- [ ] Keeper-root `.slow.test.ts` reachability via `test:full` confirmed and noted

## Done summary
De-quarantined the plan SLOW/PROCESS test buckets: un-gated saga-scaffold (51 fake-VCS nodes now in the default tier), converted src-cli-groups to in-process, deleted redundant src-cli + the src-brief-claim PROCESS block, and kept src-commit's real-git blocks wired via a new test:slow script. Default bun test is 0 fail with the only skips reachable via test:slow; typecheck/lint/hygiene all clean.
## Evidence
