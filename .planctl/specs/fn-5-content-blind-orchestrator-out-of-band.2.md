## Description

**Size:** S
**Files:** planctl/run_worker_resume.py, tests/test_worker_resume.py

Convert `planctl worker resume` from a narrative prose prompt to a typed envelope that regenerates the brief fresh, reusing the `planctl/brief.py` helper from task `.1`. This makes the resume entrypoint content-blind like the happy path and removes the `planctl cat` self-reference.

### Approach

Drop `_build_prompt` (54-103), `_extract_files_line` (32-52), `_render_human`/`prompt` plumbing, and the `planctl cat` missing-files branch. Using the resume verb's existing `resolve_project()` context, call `assemble_brief(...)` + `write_brief(...)` from `brief.py` to REGENERATE the brief fresh (bake-fresh-on-each-entrypoint), translating `BriefRenderError` to the resume verb's own `emit_error`. Compute `source_commit_sha` (via the existing git-state capture, or `None` when no source commit) and `dirty_session_file_count` if cheaply available (else omit). Build the `nudge` — a one-line process string, e.g. `Resume task <id>. status=<s> source_commit=<sha|null> dirty_session_files=<n>. Read BRIEF_REF, finish commit-then-done.` Emit the typed envelope `{task_id, status, tier, brief_ref, nudge, target_repo, primary_repo, source_commit_sha?, dirty_session_file_count?}` — add `target_repo`/`primary_repo` (not present today) so the skill's cold-resume spawn prompt is byte-uniform with the claim-path prompt.

Keep `worker resume` runtime-state-only/readonly — regenerating the brief under gitignored `state/` lands no commit.

### Investigation targets

**Required**:
- planctl/run_worker_resume.py (whole file) — everything narrative gets deleted; `resolve_project()` at 125; current envelope at 202-208 (only `prompt`/`task_id`/`status`/`tier` today).
- planctl/brief.py (task .1) — `assemble_brief` / `write_brief` signatures.
- planctl/run_claim.py:266-271 — how `target_repo`/`primary_repo` are resolved (mirror for the resume envelope).
- tests/test_worker_resume.py — asserts keyed on `TASK_ID:`/`CONTEXT:`/`Files changed:`/`**Files:**` parsing (all break; rewrite to typed-field asserts).

### Risks

- **Resume regenerates, never reads a foreign brief** — so the Python-side `schema_version` gate is moot here; just always overwrite.
- **Repo resolution differs from claim** (cwd `resolve_project()` vs roots discovery) — feed the helper resolved inputs; don't let `brief.py` re-resolve.

### Test notes

Replace prose asserts with typed-envelope-field asserts: `brief_ref` present + absolute, `nudge` is a one-line process string (no spec prose), `status`/`tier`/`target_repo`/`primary_repo` present, and the on-disk brief regenerated fresh. Confirm no `planctl cat` / `**Files:**` text remains in the output.

## Acceptance

- [ ] `worker resume` returns the typed envelope (incl. `brief_ref`, `nudge`, `target_repo`, `primary_repo`); no narrative `prompt` field, no `planctl cat` reference.
- [ ] The brief is regenerated fresh via `brief.py` on every resume.
- [ ] `_build_prompt` / `_extract_files_line` removed.
- [ ] `worker resume` stays readonly (no commit).
- [ ] `tests/test_worker_resume.py` rewritten and green; ruff + ty clean.

## Done summary

## Evidence
