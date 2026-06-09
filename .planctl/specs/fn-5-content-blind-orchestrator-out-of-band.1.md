## Description

**Size:** M
**Files:** planctl/brief.py (new), planctl/run_claim.py, tests/test_claim.py

Introduce the out-of-band brief: a shared writer module plus the `planctl claim` integration that writes the brief file and swaps the claim envelope from inline prose to a `brief_ref` handle. This is the keystone — tasks `.2` and `.3` build against the brief schema and the claim contract established here.

### Approach

Create `planctl/brief.py` (flat single-purpose module, matching `sketch_refs.py` / `bundle_ref.py` convention). Relocate `_read_spec_md` and `_render_snippet_context` out of `run_claim.py` into `brief.py` as pure functions that **raise a typed `BriefRenderError`** instead of calling `_emit_claim_error` (so `claim` and `worker resume` can each translate it to their own envelope). Add:
- `assemble_brief(*, task_id, epic_id, target_repo, primary_repo, state_repo, tier, data_dir) -> dict` — builds the brief dict `{schema_version: 1, generated_at: now_iso(), task_id, epic_id, target_repo, primary_repo, state_repo, tier, task_spec_md, epic_spec_md, snippet_context}`. `snippet_context` is `""` (not omitted) when there is no substrate. Accepts **already-resolved** inputs — does NOT do roots discovery or `resolve_project()` (claim and resume resolve differently).
- `write_brief(briefs_dir, task_id, brief_dict) -> Path` — `briefs_dir.mkdir(parents=True, exist_ok=True)` (legacy projects only have `state/tasks` + `state/locks`), then atomic write to `briefs_dir / f"{task_id}.json"`. Reuse `store.atomic_write_json` for the atomic os.replace baseline; set mode `0600`; same-filesystem temp; clean up temp on failure. Return the absolute path.

In `run_claim.py`: keep prose COMPUTE before the CAS (so a render failure strands no claim, unchanged) — call `assemble_brief` before `lock_task`, translating `BriefRenderError` to the existing `SNIPPET_RENDER_FAILED` emit. Inside the `lock_task` block, AFTER `save_runtime` and only on outcome ∈ {CLAIMED, ALREADY_MINE}, call `write_brief`; on failure emit a new `_emit_claim_error("BRIEF_WRITE_FAILED", ...)` (leaves the task `in_progress`; repair-on-reclaim). Change the `emit()` dict: DROP `task_spec_md` / `epic_spec_md` / `snippet_context`, ADD `brief_ref` (the absolute path). Envelope becomes `{task_id, epic_id, target_repo, primary_repo, tier, task_state, epic_state, brief_ref}`. `claim` stays readonly-invocation — do NOT flip it to a committing verb.

`state_repo` for the brief = `epic.primary_repo` falling back to `repo_root` (already equals the computed `primary_repo` in claim). Keep `target_repo` distinct from `primary_repo`/`state_repo` for cross-repo epics.

### Investigation targets

**Required** (read before coding):
- planctl/run_claim.py:184-223 — `_render_snippet_context` + `_read_spec_md` to relocate.
- planctl/run_claim.py:315-410 — prose compute (pre-CAS), the `lock_task` CAS + `save_runtime` (325-378), the `emit()` envelope dict (396-409).
- planctl/run_claim.py:40-83 — `_emit_claim_error` + `_set_invocation_sentinel` pattern (add `BRIEF_WRITE_FAILED`).
- planctl/store.py — `atomic_write_json` (113), `now_iso` (264), `LocalFileStateStore.__init__` state-dir layout (156-160), `lock_task`/`save_runtime` (182-219).
- planctl/sketch_refs.py — the flat helper-module + typed-error convention to mirror.
- tests/test_claim.py — the happy-path "11-key envelope" assert + the `task_spec_md`/`epic_spec_md`/`snippet_context` asserts (rewrite); the `SNIPPET_RENDER_FAILED` monkeypatch test (314-339).

**Optional**:
- planctl/run_init.py:89-97 — confirms `state/briefs/` is not pre-created and `.gitignore` is exactly `state/`.

### Risks

- **Lock-section ordering**: brief AFTER `save_runtime`; a crash between leaves `in_progress` + no brief — acceptable (repair-on-reclaim). Do NOT unwind the state write.
- **Shared-helper coupling**: `assemble_brief`/`write_brief` must not call `_emit_claim_error` or do project resolution — keep them pure so `worker resume` (task .2) reuses them.
- **fn-756.3 overlap**: do NOT add the helper to `store.py` (concurrently edited) — new `brief.py` only.

### Test notes

Rewrite the happy-path test: assert `task_spec_md`/`epic_spec_md`/`snippet_context` are ABSENT, `brief_ref` is present and absolute, and the on-disk `state/briefs/<task_id>.json` parses with the full schema (`schema_version == 1`, the prose fields populated, `generated_at` present). Assert the invocation stays readonly (NULL subject/files, no commit). Confirm a `SNIPPET_RENDER_FAILED` aborts before any brief file is written. Confirm the brief file is gitignored (untracked).

## Acceptance

- [ ] `planctl/brief.py` exists with `assemble_brief` + `write_brief` + relocated pure `_read_spec_md`/`_render_snippet_context` raising `BriefRenderError`.
- [ ] `claim` writes `state/briefs/<task_id>.json` inside `lock_task` after `save_runtime`, only on CLAIMED/ALREADY_MINE; envelope carries `brief_ref` and drops the three prose fields.
- [ ] Brief JSON matches the schema; `schema_version` is integer `1`; `snippet_context` is `""` when empty.
- [ ] `claim` invocation stays readonly (no commit); brief file is gitignored.
- [ ] `BRIEF_WRITE_FAILED` typed error path exists and leaves the task `in_progress`.
- [ ] `tests/test_claim.py` updated and green; ruff + ty clean.

## Done summary
Added planctl/brief.py (assemble_brief + write_brief + relocated pure spec-read/snippet-render raising BriefRenderError); claim now writes state/briefs/<task_id>.json inside lock_task after save_runtime and returns a brief_ref handle instead of inline prose, with a BRIEF_WRITE_FAILED path that leaves the task in_progress for repair-on-reclaim.
## Evidence
