## Overview

Fifth epic of the Python→Bun migration: planctl-bun gains the creation/deletion surface — scaffold, refine-apply, epic create, epic rm — on net-new machinery: a pyyaml-parity YAML input wrapper, bounded stdin, the fail-soft epic-id flock, scanMaxEpicId/scanMaxTaskId, slugify, throwing expandPath, and the accumulate-all failure envelope. This is the fixture-unpoisoning wave: seed_epic (which shells scaffold) starts working under conformance, so large existing test files join the gate — including a --run-slow conformance pass for the integration-marked test_scaffold.py.

## Quick commands

- `bun run build && PLANCTL_BIN="$PWD/dist/planctl-bun" uv run pytest tests/ --run-slow` — the broadened gate aspiration (python_only and still-unported close-saga surfaces skip-visible)
- `PLANCTL_BIN="$(command -v planctl)" uv run pytest tests/test_creation_verbs.py` — new module against Python first

## Acceptance

- [ ] tests/test_creation_verbs.py exists: YAML scalar-parity matrix (norway booleans, octal, timestamps, duplicate-key last-wins, underscore numerics) pinned from real pyyaml behavior, plus gap cases (duplicate_epic + --allow-duplicate fast variants, epic rm --dry-run/--force, refine-apply stdin cap) — green vs Python in both engines
- [ ] seed_epic works under conformance against dist/planctl-bun: the scaffold success envelope {epic_id, task_ids, repo_distribution} is byte-compatible (the keystone contract every fixture-dependent file rides)
- [ ] Newly-eligible existing files green against the bun binary: test_refine_apply.py, test_epic_rm.py, test_multi_repo_create_validate.py, test_envelope_shape.py, test_seed_state.py, plus the unpoisoned portions of test_task_set_tier/test_resolve_task/test_refine_context/test_run_epic_queue_jump/test_cross_project_epic_deps (python_only residue skips visible); test_scaffold.py green under a --run-slow conformance pass
- [ ] Cross-engine epic-id race harness proves no-duplicate contiguous ids with Python and bun workers minting concurrently against the shared lock file
- [ ] Python fast gate + full Python conformance untouched; bun lint/typecheck/test green; docs revised in place (authority statement, gate rows trending toward the full-suite invocation)

## Early proof point

Task that proves the approach: ordinal 2 (YAML wrapper + creation spine — if eemeli-1.1 cannot match the pyyaml matrix, the documented fallback is a coercion shim over js-yaml; the matrix fixtures from ordinal 1 are the arbiter either way).

## References

- Program: ⑤a of the restructured plan (⑤b close saga, ⑥ cutover remain). Python sources are the executable spec.
- scaffold anatomy (run_scaffold.py:408-1173): missing_session_id fail-closed at ENTRY (zero writes); 1 MiB cap pre-decode (stdin read MAX+1, TTY rejected, file length check; "exceeds N bytes (got M)" with truncated-read M); yaml.safe_load errors → bad_yaml ("YAML parse error" / "not valid UTF-8"); assert-all buckets with priority bad_yaml → spec_invalid → dep_invalid → epic_dep_invalid → repo_invalid → tier_invalid → dep_cycle, non-dominant buckets appended to the dominant envelope's details; failure envelope {"success":false,"error":{"code","message","details":[strings]}} via the accumulate-all path (pre-commit failures), success via the invocation-bearing mutating emit, commit_failed carve-out unchanged — three shapes, explicit routing; type-vs-value fork (non-string → bad_yaml; bad value → tier_invalid/repo_invalid) requires coercion-guard-first ordering; duplicate_epic guard INSIDE the flock (slugify + fullmatch regex to kill -suffix false matches; details ["<id> (status: <s>)"]; --allow-duplicate skips); two-pass ordinal deps (detectCycles on the ordinal-keyed graph; resolve to fn-N.M at mutate); epic.depends_on_epics via resolveEpicGlobally; FLOCK SCOPE: everything from dup-guard through ALL atomic writes inside, only emit() outside; mid-write unwind unlinks written_paths SPECS BEFORE JSONs (orphan-spec invariant — scanMaxEpicId scans specs/ too); pre-commit raise at emit() leaves the full tree on disk, NO rollback; in-RAM checkEpicTreeInMemory(checkFilesystemRepos=true, epicSpecContent) BEFORE writes → integrity_failed with zero disk side-effect; stamp minted DIRECTLY (scaffold is a restamp non-member); created_by_close_of read leniently (ignore-not-reject); repo_distribution = sorted counter object.
- refine-apply (run_refine_apply.py:108-808): delta keys epic.spec/add_tasks/rewrite_specs/rewire_deps; empty delta → bad_yaml; hand-rolled shape checks; codes incl. ref_invalid/target_invalid/id_collision; flock guards TASK-id allocation ONLY (scanMaxTaskId, two-pass ordinals; deps mix existing-id strings + ordinal ints — detectCycles must accept the mixed keying); post-delta whole-tree cycle check; Phase 4.5 OUTSIDE the flock: restampEpicOrFail(verb refine-apply, checkFilesystemRepos true) — RE-stamps (it IS a restamp member; scaffold is not — never conflate); Phase-4.5 raise unwinds ONLY fresh-mint new-task paths (rewrites keep their new bytes); envelope {epic_id, added_task_ids, rewritten_specs, rewired_deps, epic_spec_rewritten}; stdin cap behavior pinned from source.
- epic create (run_epic_create.py): flock INSIDE = scan/mint/checkGlobalNameUnique/exists-backstop/write epic JSON + spec, OUTSIDE = emit; branch default "main"; single hard emit_error (not accumulate-all); _epic_id_lock FAIL-SOFT (OSError → proceed unlocked; exists() backstop is the degraded guard).
- epic rm (run_epic_rm.py): unlink set = epics/<id>.json, specs/<id>.md + <id>.*.md, tasks/<id>.*.json, state/tasks/*.state.json, state/locks/*.lock; traversal guard ^[A-Za-z0-9_-]+$; live-task guard (in_progress OR lock-holding) behind --force; --dry-run emits {dry_run:true} with NO commit; --project bypass; primary_repo read BEFORE unlink; recordTouched(p) for EVERY path BEFORE unlinking — the landed commit seam already stages deletions (' D ' parse + git add --); dangling dependents → non-blocking warnings.
- YAML parity: pyyaml safe_load is YAML 1.1 (norway booleans → bool, ISO timestamps → datetime, duplicate keys silent last-wins, 0NNN octal, underscore numerics); js-yaml DEFAULT is 1.2-ish and THROWS on duplicate keys; the _is_str/_is_list_of_int guards fire on parser OUTPUT, so coercion must match before the guards. One input wrapper (eemeli yaml, version 1.1, duplicate-key last-wins) shared by scaffold/refine-apply AND config.ts loadRoots (parser unity). Cap stdin BEFORE parsing (billion-laughs defense).
- Net-new helpers: scanMaxEpicId/scanMaxTaskId (ids.ts), slugify/generateSuffix, expandPath (THROWS on unresolvable ~ — distinct from resolveUserPath), epic-id fail-soft flock helper (same lock path as Python, blocking LOCK_EX), checkGlobalNameUnique, yaml input wrapper, accumulate-all emit path, bounded stdin reader (chunked, reject-don't-truncate, concat once).
- Landed reuse (never duplicate): atomicWrite/atomicWriteJson/recordTouched/nowIso/serializeStateJson (store.ts), checkEpicTreeInMemory/validateRepoPath (integrity.ts), restampEpicOrFail (validation_restamp.ts), resolveEpicGlobally/scanEpicIdsGlobal/discoverProjects (discovery.ts), detectCycles (deps.ts), ensureValidTaskSpec (specs.ts), TASK_TIERS (models.ts), the commit/invocation/emit seam.
- Test classification: test_scaffold.py is wholesale @integration (54 tests; --run-slow only; ~5 monkeypatch fault-injection tests are python_only residue); test_refine_apply ~26 eligible (3 python_only, 1 real_git); test_epic_rm ~9 eligible; test_multi_repo_create_validate/test_envelope_shape/test_seed_state eligible as-is; test_cross_project_epic_deps 11 eligible (8 python_only). The gate must include a --run-slow conformance pass.

## Docs gaps

- **README.md:34 + :55, AGENTS.md:14 + :55, CLAUDE.md authority bullet**: verb enumeration grows; gate rows collapse toward the full-suite `PLANCTL_BIN=... uv run pytest tests/` shape; revise in place, mirrors together

## Best practices

- **Pin the YAML divergence matrix before writing the wrapper** — the guards fire on parser output; fixtures are the arbiter [philna.sh, bram.us]
- **Bounded stdin: reject, never truncate; cap before parsing** [Bun docs, js-yaml advisories]
- **flock auto-releases on crash; blocking LOCK_EX for short critical sections; expensive work outside the lock** [flock(2)]
- **git add -- stages deletions; explicit path lists, never -A** [git-add(1)]
- **Write-everything-then-validate beats rollback in a git-backed store; the commit is the atomic publish** [GoJournal/DFSCQ + repo §10]
