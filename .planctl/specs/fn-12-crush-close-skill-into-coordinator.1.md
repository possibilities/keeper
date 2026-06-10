## Description

**Size:** M
**Files:** planctl/audit_artifacts.py (new), planctl/run_close_preflight.py, tests/test_audit_artifacts.py (new), tests/test_close_preflight.py

### Approach

New `planctl/audit_artifacts.py` owns the artifact subtree: path helpers for `<primary_repo>/.planctl/state/audits/<epic_id>/{brief.json,report.md,verdict.json,followup.yaml}` (lazy `mkdir(parents=True)`, dir mode 0700), `AUDIT_SCHEMA_VERSION = 1` (integer, additive-only, reader hard-fails too-new), `compute_commit_set_hash(commit_groups)` (canonicalize: per-repo lexicographically sorted SHAs, sorted-key JSON incl. schema version, SHA-256 hex; first-seen `commit_groups` order untouched), and a commit-free atomic writer cloned from `brief.py:write_brief` (mkstemp same-dir, fsync, os.replace, parent-dir fsync, 0600, temp cleanup) — deliberately NOT `store.atomic_write_json`, which records touched-paths and would draw a commit. Rewrite `run_close_preflight` on top: assemble brief dict (snippet_context, commit_groups, ordinal-ordered task list incl. status + done summaries, commit_set_hash, schema_version, epic_id), write AFTER the promptctl render succeeds (assemble-then-write, no partial brief), envelope returns `{brief_ref, commit_set_hash, primary_repo, all_done:true, tasks}` and DROPS `snippet_context`/`commit_groups`. Flip `all_done:false` to typed error `TASKS_NOT_DONE` with non-done ids in `details`. Three-way id branch: epic-shape proceeds; task-shape errors naming the parent epic ("close operates on epics — parent epic is fn-N-slug"); garbage stays `BAD_EPIC_ID`.

### Investigation targets

**Required** (read before coding):
- planctl/brief.py — write_brief body to clone (atomic, commit-free, 0600); BRIEF_SCHEMA_VERSION doc header is the schema_version model
- planctl/run_close_preflight.py:168-247 — current verb: is_epic_id at ~179, all_done as data at ~229, _emit_preflight_error + _set_invocation_sentinel pair
- planctl/commit_lookup.py:185 — find_commit_groups deterministic output (the hash input; never re-derive trailer logic)

**Optional** (reference as needed):
- planctl/store.py:134 — read_file_or_stdin (not needed here but the submit verbs build on this module)
- tests/test_close_preflight.py + tests/conftest.py — planctl_git_repo + _roots_at_tmp_project fixtures to reuse

### Risks

Hash non-determinism (set iteration, unsorted dicts) silently breaks finalize's stale check — cover with a property-style test (same groups, shuffled input order → same hash). A state write that trips auto-commit violates the runtime-state-only contract — assert no commit lands in tests.

### Test notes

test_audit_artifacts: hash determinism/order-independence, schema-version field present, writer atomicity (no temp residue on failure), 0700/0600 modes, NO git commit after writes. test_close_preflight: brief file shape, envelope has brief_ref + hash and no prose fields, TASKS_NOT_DONE with details, parent-epic message on task id, render-failure leaves no brief.

## Acceptance

- [ ] `audit_artifacts.py` exists with path helpers, `compute_commit_set_hash`, commit-free atomic writer; hash is deterministic and order-independent
- [ ] `close-preflight` writes `audits/<epic_id>/brief.json` and returns `{brief_ref, commit_set_hash, primary_repo}` with no prose fields; no `.planctl/` commit fires
- [ ] `all_done:false` → typed `TASKS_NOT_DONE` (non-done ids in details); task-id input → error naming parent epic; garbage → `BAD_EPIC_ID`
- [ ] `uv run pytest tests/test_audit_artifacts.py tests/test_close_preflight.py -q` green

## Done summary
Added planctl/audit_artifacts.py (path helpers, AUDIT_SCHEMA_VERSION, order-independent compute_commit_set_hash, commit-free atomic writer) and rewrote close-preflight to assemble+persist audits/<epic>/brief.json, returning a content-blind {brief_ref, commit_set_hash, primary_repo, all_done, tasks} envelope with TASKS_NOT_DONE + parent-epic id branching. Full test coverage in tests/test_audit_artifacts.py and rewritten tests/test_close_preflight.py.
## Evidence
