## Description

**Size:** M
**Files:** template/skills/work.md.tmpl, tests/test_work_skill_consistency.py

Rewrite the orchestrator's post-worker tail to a single `planctl reconcile` call + mechanical switch, and drop the redundant test phase. Edit ONLY the template (the consistency test parses `template/skills/work.md.tmpl`; the rendered `skills/work/SKILL.md` regenerates). Depends on task `.1` (the verb must be registered so `planctl reconcile --help` exits 0 for the consistency test) and on fn-5 (it rewrites the same Phases 2b/3/4).

### Approach

Replace Phase 2b's verify calls (`planctl show` + `keeper find-task-commit`) AND Phase 4's `planctl validate --epic && keeper session-state` + the session_files-vs-porcelain reasoning with a SINGLE `planctl reconcile <task_id>` call + a switch on `verdict`. DROP Phase 3 (orchestrator tests) entirely. DROP the per-task `validate --epic` (epic validation is `/plan:close`'s job). The orchestrator no longer reads git porcelain or reasons over attribution; there is no orchestrator-side dirty-after-done branch (the worker owns delivery cleanliness, task `.2`).

**Switch arms** (reuse fn-5's Phase 2b resume machinery — warm SendMessage directive if `worker_agent_id` addressable, else cold `planctl worker resume` respawn; shared 5-attempt budget; surface, not block, when exhausted):
- `done` → Phase 5 report, finished.
- `in_progress_committed` → resume nudge "source commit `<sha>` landed — run `planctl done`."
- `in_progress_uncommitted` → resume nudge "finish implementation, commit, done."
- `state_uncommitted` → resume nudge "re-run `planctl done` to land the state commit."
- `blocked` → surface `blocked_reason`, stop.
- `not_started` → surface verbatim (unexpected post-worker), stop.
- `tooling_error` → surface verbatim, stop (fail-closed — do NOT act on an unreliable verdict).

Phase 5 report uses reconcile's `epic_progress` + the worker's returned commit sha. Renumber the remaining phases / guardrails consistently after Phase 3 is removed. Keep prose present-tense.

### Investigation targets

**Required**:
- template/skills/work.md.tmpl — Phase 2b (verify/recovery), Phase 3 (quality — delete), Phase 4 (ship/dirty-check — collapse into the switch), Phase 5 (report), Guardrails (renumber). NOTE: this template already carries fn-5's in-progress rewrite (BRIEF_REF / worker resume) — build on that shape.
- planctl/run_reconcile.py (task .1) — the verdict envelope shape + enum the switch consumes.
- tests/test_work_skill_consistency.py — Group A (every `planctl <verb>` in the template resolves — `reconcile` must be registered) + Groups C/D/E (worker invariants).

### Risks

- **Ordering** — needs task `.1` (verb registered) AND fn-5 (same phases). The epic dep + `deps: [1]` encode this.
- **Phase renumber** — dropping Phase 3 shifts references in Phases 4/5 + Guardrails; update them all or the prose desyncs.
- **Don't regress** the consistency-test worker-invariant groups when touching the spawn/resume prose.

### Test notes

`uv run pytest tests/test_work_skill_consistency.py` — Group A now includes `reconcile`; confirm `planctl reconcile --help` (task .1) exits 0. No new narrative `keeper find-task-commit` / `keeper session-state` / `validate --epic` calls remain in the orchestrator bash blocks.

## Acceptance

- [ ] Post-worker tail is a single `planctl reconcile` call + a total switch on the 7 verdicts; Phase 3 removed; per-task `validate --epic` removed; no orchestrator porcelain/attribution reasoning.
- [ ] Resume arms reuse fn-5's warm/cold machinery + the 5-attempt budget (surface when exhausted); `tooling_error` surfaces-and-stops.
- [ ] Phases/guardrails renumbered consistently; prose present-tense.
- [ ] `tests/test_work_skill_consistency.py` green.

## Done summary
Collapsed the work skill's post-worker tail into a single planctl reconcile call + total switch on the seven verdicts; dropped Phase 3 (orchestrator tests) and the per-task validate --epic; folded delivery cleanliness onto the worker; renumbered report to Phase 3 and refreshed guardrails. Consistency tests green.
## Evidence
