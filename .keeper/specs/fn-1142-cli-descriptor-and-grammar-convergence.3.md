## Description

**Size:** M
**Files:** plugins/plan/src/cli.ts, plugins/plan/src/descriptor.ts (new), plugins/plan/src/subgroup.ts, plugins/plan/test/cli-help.test.ts (new)

### Approach

Kill defect 3: top-level plan leaves (`show`, `ready`, `cat`, …) print the whole group help because CommandSpec carries no arg metadata. Migrate the COMMANDS table to a pure-data `descriptor.ts` (ordinal 1's shape) with per-verb argument/option metadata for all ~34 verbs, and render leaf help through the same shape subgroup.ts already gets right (printLeafHelp; help intercepted before the verb body). Subgroup leaves (`epic create`, `verdict submit`) keep working and route through the shared renderer. Bare-verb names are frozen (plugins/plan/CLAUDE.md) — zero renames. The `--format json|human` option surface is untouched here (yaml lands in ordinal 7). Frozen seams: exit-2 usage convention and the emit() parity family byte-unchanged.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/cli.ts:84-92 — CommandSpec + COMMANDS; :708 — the group-help-instead-of-leaf-help defect site; :897 — a representative dispatch case (assign-cells)
- plugins/plan/src/subgroup.ts:131-174 — printLeafHelp + dispatchGroup, the correct pattern to generalize
- cli/descriptor.ts (from ordinal 1) — descriptor shape

**Optional** (reference as needed):
- plugins/plan/test/verbs-readonly.test.ts — single-JSON-root guard the help path must not violate

### Risks

- 34 verbs of arg metadata is mechanical but wide — extract from each verb's readOption/positional calls, not from prose, so metadata matches the real parser.

### Test notes

New cli-help.test.ts: every descriptor verb × `--help` renders usage naming the verb, exits 0, dispatches no verb body (stub the dispatch map and assert no handler fired).

## Acceptance

- [ ] Every top-level plan verb with `--help` prints verb-specific leaf help (usage, arguments, options) and never runs the verb body
- [ ] Subgroup verbs keep their leaf help and both route through one shared renderer fed by a pure-data descriptor module
- [ ] The descriptor covers the full dispatchable verb set and the CLI's own parser consumes it

## Done summary

## Evidence
