## Description

**Size:** M
**Files:** plugins/plan/src/format.ts, plugins/plan/src/cli.ts, plugins/plan/src/subgroup.ts, plugins/prompt/src/cli.ts, plugins/prompt/src/bundle_io.ts, plugins/prompt/src/yaml_dump.ts (new), plugins/plan/README.md, plugins/plan/test/{src-format,verbs-readonly,src-cli,src-cli-groups,verbs-query}.test.ts, plugins/prompt/test/ (new yamlDump coverage)

### Approach

Relocate `yamlDump` from `plugins/plan/src/format.ts` into a prompt-local
module (`plugins/prompt/src/yaml_dump.ts`, co-located with its sole caller
`bundle_io.ts`) carrying the exact `{noArrayIndent:true, lineWidth:-1,
sortKeys:false}` options byte-for-byte. Repoint `bundle_io.ts`'s import.
Then strip the dead yaml output from plan: remove the `if (fmt === "yaml")`
branch in `formatOutput`, drop `"yaml"` from the `OutputFormat` union, and
remove the now-unused `import yaml from "js-yaml"` from `format.ts`
entirely (a dead top-level CJS import is NOT tree-shaken — it must be
gone). Because `OutputFormat` is shared, update BOTH plugins' `readFormat`
validators and ALL `--format` help strings in the same change or `tsc`
fails. Rewrite the `format.ts` header comment + `yamlDump` docstring
present-tense at the new home (forward-facing-doc rule). Update README +
tests last.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/format.ts:8,10,51-57,76-77 — js-yaml import, `OutputFormat` union, `yamlDump` def, the dead `if (fmt === "yaml")` branch
- plugins/prompt/src/bundle_io.ts:8,10,28,67 — prompt's own `js-yaml` read import, the `yamlDump` import to repoint, `serializeBundle` call site
- plugins/plan/src/cli.ts:738-743,773 — plan `readFormat` validator + `--format` help
- plugins/plan/src/subgroup.ts:107,140 — two more `--format [json|yaml|human]` help strings
- plugins/prompt/src/cli.ts:134-140,165 — prompt's SEPARATE `readFormat` copy + its help string
- plugins/plan/test/src-format.test.ts:8,62-105 — the `describe("yamlDump")` block (import + 3 tests) to move to a prompt-side test

**Optional** (reference as needed):
- plugins/plan/test/verbs-readonly.test.ts:233-250,318-341 — status/epics yaml output tests to remove
- plugins/plan/test/src-cli.test.ts:99-110 — "renders block style" yaml test to remove
- plugins/plan/test/src-cli-groups.test.ts:52 — help-string assertion to update to `[json|human]`
- plugins/plan/test/verbs-query.test.ts:300-317 — `cat` format-ignored test passes `--format yaml`; switch to `--format human` (yaml now exits 2)
- plugins/plan/README.md:8,142 — flag docs to drop the yaml option

### Risks

- Byte-parity: the relocated `yamlDump` must keep its exact options or the on-disk bundle YAML drifts and `serializeBundle` output changes — assert with a prompt-side round-trip test.
- Partial surface edit: miss one `readFormat` copy or help string and `tsc --noEmit` fails (the `OutputFormat` union is shared across both plugins). Change all five sites together.
- `--format yaml` becomes a hard error (exit 2), not a silent fallback — intended; the `cat` test must move off yaml or it flips from exit 0 to exit 2.

### Test notes

Move the `yamlDump` unit coverage to the prompt plugin (prompt currently
has zero coverage of `serializeBundle`/`bundle_io`). Run both plugin
suites. Per plugins/plan/CLAUDE.md the plan fast gate is `bun test`; slow
bucket via `KEEPER_PLAN_RUN_SLOW=1` — run the full suite before landing.

## Acceptance

- [ ] `yamlDump` defined in `plugins/prompt/src/yaml_dump.ts` with byte-parity options; `bundle_io.ts` imports from there; bundle write/read round-trip unchanged (prompt-side test asserts it)
- [ ] `format.ts` no longer imports `js-yaml`, the `"yaml"` member is gone from `OutputFormat`, and the `formatOutput` yaml branch is removed
- [ ] both `readFormat` validators (plan + prompt) and all four `--format` help strings drop `yaml`; `tsc --noEmit` passes in both plugins
- [ ] the five plan test files are updated (yaml-output tests removed, `cat` test switched to `human`, help assertion updated) and the yamlDump block lives in a prompt test; both suites green
- [ ] `plugins/plan/README.md` flag docs no longer mention `--format yaml`
- [ ] `format.ts` header + relocated `yamlDump` docstring are present-tense (no removal/"formerly" narration)

## Done summary
Removed the dead --format yaml output surface: relocated yamlDump into the prompt plugin (its sole caller's home) with byte-parity options intact, dropped js-yaml import + yaml branch from plan format.ts, and stripped yaml from both readFormat validators and all --format help strings. Both plugins typecheck/lint clean; touched plan suites green (fast+slow); prompt round-trip test asserts byte-identical bundle YAML.
## Evidence
