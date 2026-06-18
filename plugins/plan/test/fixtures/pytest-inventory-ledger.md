# pytest → bun migration completeness ledger

The count gate for the Python retirement. Pairs with `pytest-inventory.txt` (the
live `pytest --collect-only -q` capture, the permanent record committed outside
`tests/`). Every inventory node resolves here to one of three dispositions:

- **translated** — a bun `*.test.ts` file reproduces the module's behavior
  (1:1, expanded into `test.each`, or consolidated with siblings).
- **cited** — a pure-import module whose subject is a function now ported to
  `src/`; its behavior is covered by an existing src-level bun unit rather than
  reproduced node-for-node.
- **drop** — pins the deleted in-process Python engine; there is no
  subprocess-against-the-binary analogue. The 29 `@pytest.mark.python_only`
  nodes (monkeypatch Python internals) and the single `test_stub_contracts`
  node are the only drops.

## Gate result (deletion UNBLOCKED)

- **pytest inventory:** 900 nodes across 63 modules.
- **enumerated drops:** 30 = 29 `@pytest.mark.python_only` + 1
  `test_stub_contracts`.
- **translated/cited:** 900 − 30 = 870 nodes, every one mapped to a bun file or
  cited src unit below. Zero unmapped modules.
- **bun suite:** 960 tests across 58 files. Fast: 887 pass + 73 slow-skip, 0
  fail. `PLANCTL_RUN_SLOW=1`: 960 pass, 0 fail. **Zero `test.todo`.**
- **direction of the count:** bun (960) > inventory translatable (870) because
  translations expand stacked-parametrize cross-products and split clustered
  assertions; the gate is per-node accountability, not sum equality, and the
  independently-green bun run confirms the suite is sound.

### Side-by-side green (final run, this task)

| suite | command | result |
|---|---|---|
| pytest fast | `uv run pytest tests/` | 675 passed, 225 skipped |
| pytest full | `uv run pytest tests/ --run-slow` | 898 passed, 2 skipped¹ |
| pytest conformance | `PLANCTL_BIN=$(command -v planctl) uv run pytest tests/` | 658 passed, 242 skipped |
| bun fast | `bun test` | 887 pass, 73 skip, 0 fail |
| bun full | `PLANCTL_RUN_SLOW=1 bun test` | 960 pass, 0 fail |

¹ The 2 `--run-slow` skips are `test_epic_files_no_audited_into_field` and
`test_epic_files_no_draft_field` — parametrized over checked-in epic JSONs that
carry the retired fields; the parameter set is empty (no such epic exists), so
pytest reports an empty-parametrize skip. Their forward-looking field-hygiene
assertion is carried in bun by `consistency-skills.test.ts`'s "checked-in epic
JSON field hygiene" suite.

## Spot-audit (dense files, node-by-node)

The gate exists to catch parametrize collapses and cluster-summarized
translations. The three densest non-pure-import modules were audited node-by-node
against their bun targets:

- **`test_scaffold.py`** (54 nodes, 5 python_only) → `saga-scaffold.test.ts` (47
  runtime tests, all slow-gated, 0 fail). All 54 concepts present in the bun
  file; the 49 translatable nodes consolidate into 47 cases. Zero silent loss.
- **`test_validate_marker.py`** (28 nodes, 0 python_only) →
  `saga-validate-marker.test.ts` (26 tests). All 28 concepts present; 2
  same-precondition pairs consolidate into shared cases. Zero silent loss.
- **`test_cross_project_epic_deps.py`** (19 nodes, 8 python_only) →
  `cross-project-deps.test.ts` (11 tests). 19 − 8 drops = 11 translatable;
  bun has exactly 11. Exact match.

## Per-module mapping

| pytest module | nodes | python_only drops | disposition | bun target / citation |
|---|---:|---:|---|---|
| `cli_decorator/test_decorator_hardening.py` | 6 | 0 | translated | verbs-decorator-mapping.test.ts |
| `cli_decorator/test_no_track_commands.py` | 2 | 0 | translated | verbs-decorator-mapping.test.ts |
| `test_api.py` | 9 | 0 | cited | src-store / src-resolution units (pure-import API re-export surface) |
| `test_audit_artifacts.py` | 24 | 0 | translated | audit-artifacts.test.ts |
| `test_audit_submit.py` | 8 | 0 | translated | audit-submit.test.ts |
| `test_claim.py` | 22 | 1 | translated | saga-claim.test.ts |
| `test_cli.py` | 4 | 0 | translated | verbs-cli-init.test.ts |
| `test_cli_invoker_guard.py` | 1 | 0 | translated | verbs-decorator-mapping.test.ts |
| `test_close_finalize.py` | 20 | 0 | translated | saga-close-finalize.test.ts |
| `test_close_preflight.py` | 27 | 1 | translated | saga-close-preflight.test.ts |
| `test_close_skill.py` | 2 | 0 | translated | consistency-skills.test.ts |
| `test_close_skill_consistency.py` | 11 | 0 | translated | consistency-skills.test.ts |
| `test_commit.py` | 19 | 0 | translated | src-commit.test.ts + saga-commit.test.ts |
| `test_commit_guard_hook.py` | 7 | 0 | translated | commit-guard.test.ts |
| `test_creation_verbs.py` | 17 | 0 | translated | verbs-creation.test.ts |
| `test_cross_project_epic_deps.py` | 19 | 8 | translated | cross-project-deps.test.ts |
| `test_defer_skill_consistency.py` | 6 | 0 | translated | consistency-skills.test.ts |
| `test_emit.py` | 6 | 2 | translated | verbs-envelope.test.ts |
| `test_envelope.py` | 13 | 0 | translated | verbs-envelope.test.ts |
| `test_envelope_shape.py` | 12 | 0 | translated | verbs-envelope.test.ts |
| `test_epic_add_dep.py` | 1 | 0 | translated | creation-epic-ops.test.ts |
| `test_epic_add_deps.py` | 13 | 0 | translated | creation-epic-ops.test.ts |
| `test_epic_close.py` | 3 | 0 | translated | creation-epic-ops.test.ts |
| `test_epic_files_no_audited_into_field.py` | 1 | 0 | translated | consistency-skills.test.ts (epic JSON field hygiene) |
| `test_epic_files_no_draft_field.py` | 1 | 0 | translated | consistency-skills.test.ts (epic JSON field hygiene) |
| `test_epic_rm.py` | 13 | 2 | translated | saga-epic-rm.test.ts |
| `test_find_task_commit.py` | 13 | 1 | translated | saga-find-task-commit.test.ts |
| `test_followup_submit.py` | 14 | 0 | translated | audit-followup-submit.test.ts + src-scaffold-dryrun.test.ts |
| `test_generated_guard_hook.py` | 21 | 0 | translated | consistency-generated-guard.test.ts |
| `test_gist.py` | 4 | 0 | translated | verbs-gist.test.ts |
| `test_global_state.py` | 58 | 0 | cited | src-resolution.test.ts / verbs-query.test.ts (workable + plan-state model, pure-import) |
| `test_init.py` | 7 | 0 | translated | verbs-cli-init.test.ts |
| `test_models.py` | 37 | 0 | cited | src-models.test.ts (pure-import dataclass / normalize surface) |
| `test_multi_repo_create_validate.py` | 2 | 0 | translated | saga-validate-resolve.test.ts |
| `test_next_skill_consistency.py` | 6 | 0 | translated | consistency-skills.test.ts |
| `test_now_iso_contract.py` | 9 | 0 | translated | src-store.test.ts |
| `test_query_verbs.py` | 34 | 0 | translated | verbs-query.test.ts |
| `test_readonly_verbs.py` | 15 | 0 | translated | verbs-readonly.test.ts |
| `test_reconcile.py` | 23 | 1 | translated | saga-reconcile.test.ts |
| `test_refine_apply.py` | 30 | 4 | translated | saga-refine-apply.test.ts |
| `test_refine_context.py` | 10 | 0 | translated | saga-refine-context.test.ts |
| `test_repo_inference.py` | 24 | 0 | cited | src-discovery-config.test.ts / src-project.test.ts (pure-import path classification) |
| `test_resolve_task.py` | 10 | 0 | translated | saga-validate-resolve.test.ts |
| `test_restamp_verbs.py` | 29 | 0 | translated | verbs-restamp.test.ts |
| `test_roots_discovery.py` | 15 | 0 | translated | roots-discovery.test.ts |
| `test_run_epic_queue_jump.py` | 4 | 0 | translated | creation-epic-ops.test.ts |
| `test_runtime_status.py` | 39 | 0 | cited | src-resolution.test.ts / verbs-query.test.ts (pure-import status derivation) |
| `test_scaffold.py` | 54 | 5 | translated | saga-scaffold.test.ts |
| `test_seed_state.py` | 6 | 0 | translated | harness.test.ts |
| `test_session_markers.py` | 28 | 1 | translated | session-markers.test.ts |
| `test_set_primary_repo_warning.py` | 6 | 0 | translated | creation-epic-ops.test.ts |
| `test_stop_guard_hook.py` | 11 | 0 | translated | stop-guard.test.ts |
| `test_stub_contracts.py` | 1 | 0 | drop | pins the deleted in-process Python stub-injection contract; no subprocess analogue |
| `test_subagent_stop_guard_hook.py` | 8 | 0 | translated | subagent-stop-guard.test.ts |
| `test_task_set_tier.py` | 11 | 0 | translated | creation-epic-ops.test.ts |
| `test_util_vendored.py` | 6 | 0 | cited | src-format.test.ts / src-ids.test.ts (pure-import vendored helpers) |
| `test_validate.py` | 12 | 2 | translated | saga-validate-resolve.test.ts |
| `test_validate_marker.py` | 28 | 0 | translated | saga-validate-marker.test.ts |
| `test_verdict_submit.py` | 16 | 0 | translated | audit-verdict-submit.test.ts |
| `test_work_skill_consistency.py` | 13 | 0 | translated | consistency-skills.test.ts |
| `test_worker_resume.py` | 11 | 1 | translated | saga-worker-resume.test.ts |
| `test_worker_template_discipline.py` | 4 | 0 | translated | consistency-skills.test.ts (worker.md.tmpl doc-discipline block) |
| `test_worker_verbs.py` | 14 | 0 | translated | verbs-worker.test.ts + saga-claim.test.ts |

**Totals:** 63 modules, 900 inventory nodes, 29 python_only drops + 1 stub_contracts drop = 30 enumerated drops, 870 translated/cited nodes. Every node accounted; deletion (task .6) unblocked.
