## Description

**Size:** M
**Files:** src/verbs/show.ts, cat.ts, list.ts, ready.ts, tasks.ts, resolve_task.ts, refine_context.ts, validate.ts (all new), src/cli.ts, test/ additions

### Approach

Eight verbs against the landed pins from tests/test_query_verbs.py. show: task/epic branches with merged runtime and task_summary. cat: validate id, read specs/<id>.md, raw bytes to stdout, errors to stderr exit 1, --format accepted-and-ignored, no trailer. list: the tree human renderer golden-matched char-for-char (renderer returns a string array; trailing-newline byte matched). ready: dep-met classification and task_priority sort. tasks: filters and (epic_num, task_num) sort with unparseable-last. resolve-task: find_projects_with_task with the typed error set, tier as explicit null, _expected_worker_cwd fallback, readonly invocation. refine-context: api helpers, empty-string specs, typed errors, plus the --invalidate branch (short-circuit readonly when already null; write null + mutating emit when stamped). validate: root checks then per-epic validateEpicIntegrityWithWarnings; the {valid,errors,warnings} envelope through the format path (NOT the success seam), exit 1 on invalid, no trailer; --epic stamps only on the None→timestamp transition, stamp write BEFORE the manual auto-commit, second compact invocation line only when the stamp landed, commit_failed envelope + exit 1 on commit failure, already-stamped re-run a pure no-op.

### Investigation targets

**Required** (read before coding):
- tests/test_query_verbs.py — the pins these verbs satisfy
- planctl/run_validate.py — the two-line stamp contract
- planctl/run_list.py:_render_human + the golden fixture — renderer parity
- planctl/run_resolve_task.py — typed errors and fallback chain

**Optional** (reference as needed):
- src/verbs/epics.ts — the landed human-renderer idiom
- planctl/run_refine_context.py — envelope and --invalidate branches

### Risks

validate's dual-formatting stdout (format-aware envelope + always-compact second line) doesn't fit the existing one-envelope seam — implement it explicitly rather than bending emitMutating.

### Test notes

test_query_verbs.py green against the compiled binary; bun units for renderers; fast gate untouched.

## Acceptance

- [ ] All eight verbs green in tests/test_query_verbs.py via dist/planctl-bun
- [ ] cat/validate no-trailer and envelope divergences byte-faithful
- [ ] validate --epic state machine exact across all four branches (invalid, valid+unstamped, valid+stamped, commit-failure)

## Done summary

## Evidence
