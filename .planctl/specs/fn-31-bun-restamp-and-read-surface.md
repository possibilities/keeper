## Overview

Fourth epic of the Python→Bun migration: planctl-bun gains the integrity/restamp machinery and completes its read surface — integrity.ts (the whole-epic check with its exact error/warning string catalog), validationRestamp.ts (the shared check-then-stamp pipeline all nine in-wave restamp members ride), global epic resolution (resolveEpicGlobally + scanEpicIdsGlobal), cycle detection, nested epic/task group dispatch, and ~19 verbs: the setter family, dep editors, validate (whole-project + --epic), refine-context, show, cat, list, ready, tasks, resolve-task. Wave boundary: no scaffold/refine-apply/epic create/rm/close, no epic-id lock, no close saga, no jsonschema. String parity rides a committed golden corpus captured from the Python binary.

## Quick commands

- `bun run build && PLANCTL_BIN="$PWD/dist/planctl-bun" uv run pytest tests/test_cli.py tests/test_readonly_verbs.py tests/test_worker_verbs.py tests/test_query_verbs.py tests/test_restamp_verbs.py` — the scoped gate (plus `tests/test_init.py` under `--run-slow`)
- `PLANCTL_BIN="$(command -v planctl)" uv run pytest tests/test_query_verbs.py tests/test_restamp_verbs.py` — the new modules against Python (proves the tests)

## Acceptance

- [ ] tests/test_query_verbs.py and tests/test_restamp_verbs.py exist: seed_state-seeded, engine-agnostic, green against Python in both engines, covering every in-wave verb incl. multi-root resolution (seed_state per project dir + set_roots), restamp-failure no-rollback semantics, conditionally-mutating short-circuits, and golden-pinned strings
- [ ] Scoped gate green against compiled dist/planctl-bun, serially and with -n
- [ ] Integrity error/warning catalog byte-identical to Python (golden corpus, incl. repr-quoted repo warnings); validate emits the {valid,errors,warnings} envelope with exit 1 on invalid and NO trailer; cat stays format-free with NO trailer
- [ ] Restamp members fail-forward (write landed, marker stale, integrity_failed compact envelope, exit 1) except add-dep which rolls back; validate --epic stamps only on the None→timestamp transition, before its commit; already-stamped re-run is a pure no-op
- [ ] Python fast gate + full Python conformance untouched; bun lint/typecheck/test green
- [ ] Authority statement + gate rows revised in place, both mirrors in sync, no history narration

## Early proof point

Task that proves the approach: ordinal 4 (integrity + restamp pipeline against the golden catalog). If the linear-check port fights string parity, fallback: land integrity.ts behind the validate verb only and stage the restamp members one callback at a time — same acceptance, slower burn.

## References

- Program: epic ④ of ~6 (fn-28/29/30 closed; ⑤ creation/close machinery — scaffold, refine-apply, epic create/rm/close, close saga, after which the FULL suite becomes bun-gateable; ⑥ cutover). Python sources are the executable spec.
- Restamp: planctl/validation_restamp.py — in-wave members set-description, set-acceptance, reset, add-dep, add-deps, rm-dep, set-primary-repo, set-touched-repos, set-target-repo (refine-apply is next wave); restamp_epic_or_fail loads the on-disk tree, extends the epic universe across discover_projects()+scan_epic_ids_global FAIL-SOFT (exception → empty map), runs _check_epic_tree, on errors emits {success:false,error:{code:"integrity_failed",message:"<verb> on <epic_id> produced an invalid epic tree; last_validated_at NOT re-stamped",details:[...]}} compact, exit 1, NO rollback — the structural write stays, the next mutating verb's auto-commit sweeps it. add-dep alone snapshots prior state and rolls back on introduced cycles.
- NOT restamp members (plain or short-circuit verbs): set-tier, set-branch, set-title, invalidate, queue-jump. invalidate/queue-jump/refine-context --invalidate use the short-circuit pattern: already-in-target-state → readonly envelope, no commit; else write + mutating emit.
- validate: planctl/run_validate.py — root checks (meta.json/schema_version, required dirs) then per-epic validate_epic_integrity_with_warnings; envelope {valid,errors,warnings} via format_output (NOT emit), exit 0/1 on valid; --epic stamps ONLY when valid AND last_validated_at IS None: write stamp → auto_commit_from_invocation → CommitFailed → commit_failed envelope exit 1; the stamp write precedes the commit (inverse of the restamp helper); stamped output adds a SECOND compact {"planctl_invocation": ...} line; cat and validate are NO-trailer verbs.
- Integrity: planctl/integrity.py _check_epic_tree — exact-match strings incl. "Epic {eid}: dependency {dep} does not exist", "Epic {eid}: epic-dep cycle detected: {a -> b}", repo "path does not exist"/"path exists but contains no .git/", warning "target_repo {x!r} is not in epic.touched_repos" (Python repr quoting); two distinct path-comparison semantics: os.path.samefile for primary_repo mis-location vs Path.resolve() string compare for target_repo coverage — reproduce both; check_filesystem_repos toggle: set-*-repo verbs pass False, validate passes True. Reuse bun specs.ts validateTaskSpecHeadings.
- Resolution: discovery.resolve_epic_globally → ResolveResult(.resolved/.ambiguous, owners, resolved_id); cwd short-circuit then roots scan; number-only fn-N is integer-equality, never prefix; ids.scan_epic_ids_global last-walked-wins. add-deps error priority bad_id → dep_ambiguous_id → epic_not_found → dep_done → dep_cycle; results WIRED|ALREADY_PRESENT|SKIPPED_*; writes only when new_edges>0; target-epic-not-found fails loud even under --skip-invalid.
- Determinism: sort every readdir glob immediately; sort node ids AND adjacency lists before DFS; three-color DFS with parent-pointer cycle reconstruction; ASCII ids make Python/JS default sorts equivalent.
- Spine gaps to fill: nested epic/task group dispatch in cli.ts; ids.isEpicId; store raw loadJson (raise-on-missing); readFileOrStdin; api helpers loadEpic/loadTasksForEpic/taskSortKey/taskPriority; discovery resolveEpicGlobally/scanEpicIdsGlobal; deps.ts detectCycles/findDependents; runtime_status _expected_worker_cwd (3-level target_repo fallback) for resolve-task; resolve-task surfaces tier as explicit JSON null when unset.
- Conformance seeding: ALL new coverage seed_state-seeded (existing setter/validate test files are scaffold-poisoned — leave untouched); multi-root pattern = seed_state into each project dir + set_roots (tmp-HOME config.yaml under conformance); fixed_clock sets PLANCTL_NOW, engine-agnostic; goldens captured under LC_ALL=C with a documented regeneration path.

## Docs gaps

- **CLAUDE.md + AGENTS.md**: authority-statement verb enumeration grows (revise the bullet in place); bun gate row gains the two new modules
- **README.md**: prerequisites bullet and bun section scope phrase revised; verb-reference section already complete, untouched

## Best practices

- **Golden corpus over inline strings:** capture reference output from the Python binary under LC_ALL=C/NO_COLOR; commit fixtures; document regeneration; audit every f-string interpolation incl. !r repr quoting [practice-scout]
- **Table-driven setters:** one shared load→gate→validate→write→restamp→emit pipeline with per-verb callbacks; special cases are hooks, not forks [practice-scout]
- **Deterministic graphs:** sort node ids and adjacency lists before DFS; readdir order is arbitrary in BOTH languages — sort at the call site [Node #3232, Python docs]
- **Renderers return string arrays:** never write inside tree-building; match padding and trailing-newline bytes from captured goldens; never read terminal width [practice-scout]
