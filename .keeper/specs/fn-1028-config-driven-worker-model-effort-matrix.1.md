## Description

**Size:** M
**Files:** plugins/plan/subagents.yaml (new), plugins/plan/src/subagents_config.ts (new loader), plugins/plan/src/models.ts, plugins/plan/src/verbs/{scaffold.ts,refine_apply.ts,task_set_tier.ts}, plugins/plan/src/yaml_input.ts (reuse), plugins/plan/package.json / build config

### Approach

Create `plugins/plan/subagents.yaml` with `efforts: [medium, high, xhigh, max]`, `models: [opus]`,
and `subagents: [template/agents/worker.md.tmpl]`. Add a shared loader module that exposes the parsed
matrix (efforts, models, subagent template list) with two access modes: build/renderer callers pass the
on-disk path through `loadYamlInput`; the runtime resolver reads a **compile-time embedded snapshot**
(`import cfg from "../subagents.yaml" with { type: "text" }`, then `parseYamlInput(Buffer.from(cfg))` —
the parser takes a Buffer, the embed yields a string, so wrap). Memoize the parse at module load. Replace
the `TASK_TIERS` const in `models.ts:128` with `efforts` read from the loader — **names stay unchanged**
this task (`workerAgentForTier` still emits `plan:worker-<tier>`); the point is to prove the compiled
binary reads the embedded config and to move the effort list into the SSOT with zero behavior change.
Fail LOUD on a malformed/missing config (no safe default — unlike `loadRoots`), but do not throw at
module-eval time in a way that crashes the three verb importers; surface a typed error at the call site.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/models.ts:128 — `TASK_TIERS`; :135 `workerAgentForTier` (keep the name output identical this task)
- plugins/plan/src/yaml_input.ts:112 — `parseYamlInput` signature (Buffer in, TextDecoder, YAML 1.1)
- plugins/plan/src/config.ts:74 — `loadRoots`, the committed-YAML-through-parseYamlInput precedent (its fail-soft default is NOT reusable here)
- cli/keeper.ts:20 — `import … with { type: "json" }` compile-time embed precedent
- plugins/plan/package.json — the `bun build --compile` boundary; confirm `with { type: "text" }` survives compile

**Optional** (reference as needed):
- plugins/plan/src/verbs/scaffold.ts:418,770 — the tier-validation sites that import `TASK_TIERS`

### Risks

- The `bun build --compile` binary at `~/.local/bin/keeper-plan` runs from arbitrary cwd; there is NO
  plugin-relative runtime path — the embed is load-bearing. If `with { type: "text" }` is not honored by
  the compiler, fall back to a render-emitted typed `subagents.generated.ts` the resolver imports.
- Module-eval-time config parse must not turn a malformed config into an import-time crash of claim/resolve/resume.

### Test notes

Unit-test the loader over a fixture config; assert the runtime path (string → Buffer → parseYamlInput)
yields the same parsed object as the disk path. Assert tier validation still accepts exactly the config's
`efforts`. Existing worker-name tests must stay green (names unchanged this task).

## Acceptance

- [ ] `plugins/plan/subagents.yaml` exists with `efforts`, `models`, `subagents`.
- [ ] A shared loader parses it via `yaml_input.ts`; runtime reads an embedded snapshot, build reads disk.
- [ ] `TASK_TIERS` is retired; the effort list comes from the config; worker names are unchanged this task.
- [ ] The compiled `keeper-plan` binary validates a task tier against the embedded config (proof the embed works).
- [ ] Malformed/missing config fails loud with a typed error, not an import-time crash.

## Done summary
Added plugins/plan/subagents.yaml as the SSOT for the {model x effort} axes and a subagents_config.ts loader with two access modes (runtime parses a compile-time embedded snapshot, build reads disk), both failing loud on a malformed matrix. Retired TASK_TIERS; scaffold/refine-apply/set-tier now read configuredEfforts() from the config with worker names unchanged. Proved the compiled keeper-plan binary validates a tier against the embedded config from an arbitrary cwd.
## Evidence
