## Description

**Size:** M
**Files:** cli/pair.ts, src/pair-command.ts, cli/dispatch.ts, plugins/keeper/skills/pair/SKILL.md, plugins/keeper/skills/dispatch/SKILL.md

### Approach

Add `--preset <name>` to `keeper pair send` and `keeper dispatch`, both forwarding
preset resolution to the task-1 launcher rather than re-deriving model/effort.

- **Pair** (`cli/pair.ts` :191-205): add a `--preset` option; relax the
  `cli === undefined` hard-fail (:245-250) so `--preset` alone is valid. Pair
  resolves the preset registry itself (dep-free `loadPresetRegistry`) to read
  the `harness` (drives claude-vs-codex orchestration: env strip, reap policy,
  codex trust-seed) and the optional `role` (feeds the existing `PairRole`/
  `isPairRole` :52-59). Add `preset?` to `PairLaunchOpts` (:151-170);
  `buildPairLaunchArgv` (:200-224) forwards `--agentwrap-preset <name>` into
  `wrapperFlags` so the launcher owns model/effort — pair never re-derives them.
  `--cli` becomes an optional compatibility alias; `--cli` + `--preset` with
  disagreeing harnesses → fail loud. Emit `preset=<name>` alongside
  `cli=<harness>` in the started/completed output events.
- **Known asymmetry to preserve**: the claude pair path has no headless effort
  flag (`pair-command.ts:163-165`), so a preset's `effort` is dropped for claude
  pairs (honored for codex via `-c` and for the interactive `keeper agent claude`
  path). Document it; do not error.
- **PairCli excludes pi** (:42): a preset pinning `pi` handed to pair fails loud.
- **Dispatch** (`cli/dispatch.ts` :337-353): add `--preset`; claude-only for now
  (`LaunchSpec` in `src/exec-backend.ts:77-85` carries only claude model/effort —
  codex/pi dispatch is a follow-up that widens `LaunchSpec`, out of scope). The
  plan-form (`work::`/`close::`) defaults to the SAME `worker` preset the
  autopilot uses, so manual and automated workers are byte-identical. `--model`/
  `--effort` remain overrides.
- **Docs**: add `--preset` to both SKILL flag tables + argument-hints (mark
  `--cli` "required unless `--preset` given") and the `cli/pair.ts` / `cli/dispatch.ts`
  usage strings.

### Investigation targets

**Required**:
- cli/pair.ts:191-270, :384-396 — parseArgs options, the `--effort` codex-only + `cli===undefined` guards, the `buildPairLaunchArgv` call.
- src/pair-command.ts:40-59, :151-224, :237-289 — `PairCli`, `PAIR_ROLES`/`isPairRole`, `PairLaunchOpts`, `buildPairLaunchArgv`, `nativeClaudeArgs`/`nativeCodexArgs`.
- cli/dispatch.ts:337-353, :496-526 — parseArgs options, `buildDispatchLaunchArgv` call, `LaunchSpec` build.
- src/exec-backend.ts:77-85 — `LaunchSpec` (claude-only) confirming the dispatch constraint.

### Risks

- Argv ordering: `--name <key>` adjacency is load-bearing for reap/classify — preset forwarding must not reorder it.
- Pair must resolve the registry dep-free (no `src/db.ts`).

### Test notes

- test/pair-command.test.ts argv pins updated; `--preset` forwards `--agentwrap-preset`; `--cli` alias still works; harness disagreement fails loud; pi preset to pair fails loud.
- `bun run test:full`.

## Acceptance

- [ ] `keeper pair send --preset <name>` launches with the preset's harness/model/effort; `--cli` still works as an alias; disagreement fails loud.
- [ ] Pair forwards `--agentwrap-preset` rather than re-deriving model/effort; output events carry `preset=<name>`.
- [ ] `keeper dispatch --preset <name>` works claude-only; plan-form defaults to the `worker` preset; `--model`/`--effort` override.
- [ ] Both SKILL flag tables + cli usage strings document `--preset`.

## Done summary

## Evidence
