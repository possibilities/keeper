## Description

**Size:** M
**Files:** src/cli.ts, src/ids.ts, src/store.ts, src/discovery.ts, src/deps.ts (new), src/api.ts (new), src/runtime_status.ts (new or inlined), src/emit.ts, test/ additions

### Approach

The wave's foundation. cli.ts grows nested group dispatch: `epic <sub>` and `task <sub>` route to leaf runners with click-matching semantics (group --help with its own Commands section, unknown sub exit 2 with the group usage shape, --format accepted at top level as today); cat and validate register as no-trailer verbs alongside the existing mechanism. Fill the small spine gaps: ids.isEpicId; store raw loadJson (raise-on-missing — its error path matches Python's emit_error shape at verb level); readFileOrStdin; api.ts with loadEpic/loadTasksForEpic/taskSortKey/taskPriority; runtime_status's _expected_worker_cwd 3-level fallback (port or inline — small either way). discovery.ts gains resolveEpicGlobally (ResolveResult contract with .resolved/.ambiguous, owners list, fn-N integer-equality matching, cwd-short-circuit-then-roots-scan, fail-soft) and scanEpicIdsGlobal (last-walked-wins). deps.ts ports detectCycles (sorted nodes + sorted adjacency, three-color DFS, parent-pointer cycle reconstruction — cycle strings must match Python) and findDependents. emit.ts grows whatever thin support the conditionally-mutating verbs need to pick readonly-vs-mutating per invocation without duplicating seam logic. Sort every directory listing at the call site. bun:test units for resolution, cycles, and the dispatch table.

### Investigation targets

**Required** (read before coding):
- src/cli.ts — the landed flat dispatch being extended
- planctl/cli.py — group registration, _NO_TRACK_COMMANDS, group help shapes
- planctl/discovery.py:21-160 — ResolveResult and matching semantics
- planctl/deps.py — detect_cycles/find_dependents exact behavior
- planctl/api.py — the helper contracts

**Optional** (reference as needed):
- tests/test_cli.py — any group-help assertions the dispatcher must satisfy
- planctl/runtime_status.py — _expected_worker_cwd

### Risks

Group dispatch is the one surface every new verb routes through — get the usage-error and help shapes right against test_cli.py before stacking verbs on it. Cycle-string determinism depends on sorting discipline at every graph-construction site.

### Test notes

bun test green for new units; test_cli.py still green against the compiled binary; fast gate untouched.

## Acceptance

- [ ] Nested epic/task dispatch with click-matching help and exit-2 usage errors; cat/validate no-trailer registration
- [ ] resolveEpicGlobally/scanEpicIdsGlobal/detectCycles/findDependents/api helpers/isEpicId/loadJson/readFileOrStdin landed with units
- [ ] All directory listings sorted at the call site

## Done summary
Landed the read-surface spine: nested epic/task group dispatch with click-matching wrapped help + exit-2 usage errors, cat/validate no-trailer registration, and the helper spine (resolveEpicGlobally/scanEpicIdsGlobal, detectCycles/findDependents, api loaders, isEpicId, loadJson/readFileOrStdin, runtime_status cwd fallbacks). bun:test units green; test_cli.py conformance + Python fast gate untouched.
## Evidence
