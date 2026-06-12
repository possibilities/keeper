## Description

**Size:** M
**Files:** src/verbs/refine_apply.ts (new), src/cli.ts, test/ additions

### Approach

Phase-faithful to run_refine_apply.py, reusing scaffold's validators and emit routing: delta parse (empty delta → bad_yaml; stdin cap per the pinned behavior); hand-rolled shape checks with the full code set incl. ref_invalid/target_invalid/id_collision; flock guards ONLY task-id allocation (scanMaxTaskId, two-pass ordinals; deps mixing existing-id strings and ordinal ints — detectCycles over the mixed-key post-delta graph); writes via the landed writer with fresh-mint paths tracked; Phase 4.5 OUTSIDE the flock: restampEpicOrFail(verb refine-apply, checkFilesystemRepos true) — this verb is a restamp MEMBER and re-stamps post-write; a Phase-4.5 raise unwinds only the fresh-mint new-task paths, leaving rewrites in place; envelope {epic_id, added_task_ids, rewritten_specs, rewired_deps, epic_spec_rewritten}.

### Investigation targets

**Required** (read before coding):
- planctl/run_refine_apply.py — the source spec
- tests/test_refine_apply.py — the ~26 eligible pins
- src/verbs/scaffold.ts — landed validator/emit conventions to reuse, never fork

### Risks

The narrow flock scope (task-id only) and the restamp-outside-lock ordering differ from scaffold — resist symmetry instincts; the asymmetry is the contract.

### Test notes

PLANCTL_BIN=dist/planctl-bun uv run pytest tests/test_refine_apply.py green (python_only/real_git residue visible); fast gate untouched.

## Acceptance

- [ ] test_refine_apply.py eligible set green via the compiled binary
- [ ] Restamp membership honored; unwind scope exact

## Done summary

## Evidence
