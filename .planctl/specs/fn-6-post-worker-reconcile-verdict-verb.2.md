## Description

**Size:** S
**Files:** template/agents/worker.md.tmpl, template/agents/worker-codex.md.tmpl

Relocate delivery-cleanliness from the orchestrator to the worker: before returning its summary, the worker confirms its own session work is fully committed. Edit ONLY the `template/` sources (rendered outputs are gitignored, promptctl-owned). This sits on top of fn-5's worker-template rewrite, so it lands after fn-5 (epic dep).

### Approach

After the worker's existing `planctl done` (its Phase 5), add a lightweight delivery self-check before the Phase 6 return: the worker runs `keeper session-state` and verifies its `session_files` are empty (everything it touched is committed); if any session file is still dirty, it commits via `keeper commit-work` before returning. The worker is already in keeper's call graph (Phase 4 runs `keeper commit-work`), so this adds no new tooling — it makes the worker OWN the cleanliness the orchestrator used to police. A `keeper session-state` / `commit-work` failure follows the existing `BLOCKED: TOOLING_FAILURE` path. Apply to both templates in lockstep; PRESERVE the codex sub-prompt asymmetry fn-5 establishes (the codex wrapper vs the codex sub-prompt). Keep prose present-tense.

### Investigation targets

**Required**:
- template/agents/worker.md.tmpl — Phases 4 (commit), 5 (done), 6 (return); the existing `keeper commit-work` usage to mirror.
- template/agents/worker-codex.md.tmpl — the parallel phases + the codex sub-prompt asymmetry to preserve.
- tests/test_work_skill_consistency.py Groups C/D/E — worker-template invariants (no `model=` kwarg, bare `work:worker` spawn, no `task set-tier`); don't regress.

### Risks

- **fn-5 coupling** — fn-5 task .3 rewrites these same templates (BRIEF_REF reads, codex asymmetry). This task lands after fn-5 (epic dep); apply the self-check on top of fn-5's final template shape, don't fight it.
- **Don't over-engineer** — a tight self-check, not a re-implementation of the orchestrator's old porcelain reasoning.

### Test notes

`tests/test_work_skill_consistency.py` must stay green (worker-template invariant groups). No new test runner; verify the templates still render (the generated guard runs in CI).

## Acceptance

- [ ] Both worker templates add a delivery self-check after `planctl done`, before return: `keeper session-state` → commit any still-dirty session files via `keeper commit-work`.
- [ ] Codex sub-prompt asymmetry preserved; prose present-tense; consistency-test invariant groups green.

## Done summary

## Evidence
