## Description

**Size:** S
**Files:** cli/keeper.ts, test/help-purity.test.ts (new), test/completions.test.ts, test/descriptor-purity.test.ts (new)

### Approach

Close the loop on ADR 0008. Wire lazy imports of the plan/prompt descriptor modules into `--help --json` and buildCompletionCli so their verb sets render from plugin reality (retiring the last static verb lists); the dispatch tree keeps its residual pass-through untouched. Add the two mechanical gates: (1) an import-graph test asserting all three descriptor modules resolve with zero non-type imports outside their own module (pure data — no plugin boot, no src/db.ts, no daemon client on the help/completion path); (2) the help-purity walk — for every leaf and verb in the merged descriptor tree, invoke its main in-process with `--help` (and `--version`/`--agent-help` where declared) under stub deps in which any db open, socket connect, filesystem write, or subprocess spawn throws; assert exit 0 and non-empty stdout. This is the regression-proof for the whole purity property, not just the fixed sites.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/keeper.ts:355-360 — pass-through constraint the wiring must preserve; :411 — completion tree where plugin verbs may nest
- cli/descriptor.ts + plugins/plan/src/descriptor.ts + plugins/prompt/src/descriptor.ts (ordinals 1-3) — the three trees to merge
- test/keeper-cli.test.ts:1-60 — stub/sink/ExitError harness to reuse for the walk

**Optional** (reference as needed):
- plugins/plan/test/verbs-readonly.test.ts — prior art for walk-every-verb suites

### Risks

- The purity walk must stay in-process (repo test rule: no subprocess) — leaves whose main is not yet injectable may need a DispatchDeps-style seam; keep such seams minimal and mechanical.

### Test notes

The walk is the acceptance; also assert `keeper --help --json` plan verb count equals the plan descriptor's dispatchable count (the drift regression).

## Acceptance

- [ ] `keeper --help --json` and completions render plan/prompt verb sets from the plugins' own descriptor modules, matching dispatchable reality
- [ ] An import-graph test pins all three descriptor modules dependency-free
- [ ] A help-purity test walks every descriptor leaf/verb under throwing stub deps and passes

## Done summary
Merged plan/prompt plugin verb sets live into keeper --help --json + completions (ADR 0008); retired the static verb lists in cli/descriptor.ts. Sync merge via static import of the pure-data plugin descriptors (forced by keeper-cli.test.ts requiring buildHelpIndex() sync). Added keeper completions --help. New test/help-purity.test.ts walks every descriptor leaf/verb --help (and --agent-help) in-process under throwing db/socket/fs/subprocess stubs; test/descriptor-purity.test.ts pins all three descriptors dependency-free.
## Evidence
