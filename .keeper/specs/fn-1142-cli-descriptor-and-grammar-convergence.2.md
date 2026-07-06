## Description

**Size:** M
**Files:** plugins/prompt/src/cli.ts, plugins/prompt/src/descriptor.ts (new), plugins/prompt/test/cli.test.ts

### Approach

Kill defect 1: `keeper prompt <verb> --help` currently EXECUTES the verb — `main()` honors parsed.help only when command === null, so `build-snippets --help` performs a write. Route `--help`/`-h` for ANY parsed verb before dispatch. Move the COMMANDS table to a pure-data `descriptor.ts` (conforming to the shape ordinal 1 defined) carrying per-verb argument/option metadata, and render verb-specific leaf help from it (usage line, arguments, options). The prompt CLI's own parser and help renderer consume this descriptor — single source within the plugin. No verb renames, no output changes for non-help invocations; the frozen exit-2 usage convention is untouched.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/prompt/src/cli.ts:353-359 — the defect site (help honored only when command === null)
- plugins/prompt/src/cli.ts:33-85 — COMMANDS table to migrate; :96 hand-rolled parseArgs walker; :321,340 positional()/readOption() helpers
- plugins/plan/src/subgroup.ts:131-174 — printLeafHelp + dispatchGroup pattern (help intercepted before verb body) to mirror
- cli/descriptor.ts (from ordinal 1) — the descriptor shape to conform to

**Optional** (reference as needed):
- plugins/prompt/src/build_snippets.ts — the write path that must be unreachable from help

### Risks

- The prompt CLI ships interpreted via the keeper binary's in-process dispatch — verify no import of the descriptor pulls verb implementation modules (keep it data-only so ordinal 5's purity test passes).

### Test notes

In-process: for every descriptor verb, `main(["<verb>", "--help"])` under a tmpdir sandbox exits 0, prints usage naming the verb, and leaves the corpus tree byte-unchanged (build-snippets is the regression case).

## Acceptance

- [ ] Every prompt verb with `--help`/`-h` prints verb-specific leaf help, exits 0, and performs zero filesystem writes
- [ ] The prompt verb table lives in a pure-data descriptor module the CLI's own parser and help renderer consume
- [ ] Non-help behavior of every prompt verb is unchanged

## Done summary

## Evidence
