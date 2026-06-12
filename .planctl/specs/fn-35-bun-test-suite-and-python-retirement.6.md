## Description

**Size:** M
**Files:** planctl/ (deleted), tests/ (deleted), pyproject.toml + uv.lock + pyrightconfig.json (deleted), .gitignore, template/agents/worker.md.tmpl + regenerated agents, CLAUDE.md, README.md, package.json (if script residue)

### Approach

The retirement. Purge __pycache__ trees first; then the purely-subtractive deletion commit: planctl/, tests/, pyproject.toml, uv.lock, pyrightconfig.json. Residue pass in a follow-up commit: .gitignore python block pruned; worker template runner-detection and check-matrix rows pruned of Python entries and EVERY rendered agent regenerated from the template (verify the full rendered set — recon found six files mentioning pyproject/pytest/ruff; distinguish template-rendered from hand-authored before touching any); CLAUDE.md Running Things collapses to the bun rows plus a PLANCTL_RUN_SLOW row, the polyglot bullet becomes the single-implementation statement, the PLANCTL_BIN env entry goes; README loses the Python prerequisites and reference paragraphs, and the rollback note becomes the forward fact that reverting the deletion commit restores the reference implementation. Final checks: git grep residue sweep (pytest/conftest/uv run/.py outside markdown and .planctl history) clean; bun test green fast and slow; lint/typecheck green; the binary on PATH still answers (nothing in this epic touches it).

### Investigation targets

**Required** (read before coding):
- The mapping-gate task's ledger — deletion is unblocked only by its sign-off
- template/agents/ rendering mechanism — how agents regenerate from worker.md.tmpl

### Risks

This closes the rollback window permanently — the gate task's sign-off is the only authorization; any red discovered mid-deletion means stop and restore, not push through.

## Acceptance

- [ ] Repo contains zero Python source/config; deletion commit subtractive; residue commit separate
- [ ] bun test green (fast + slow), lint/typecheck green, binary answers; docs single-implementation present-tense

## Done summary
Retired the Python reference implementation: purely-subtractive deletion commit (planctl/, tests/, pyproject.toml, uv.lock, pyrightconfig.json; 144 files, zero insertions) then a separate residue commit pruning the .gitignore Python block, worker-template runner/check-matrix Python rows (all rendered agents re-rendered), and CLAUDE.md/README single-implementation present-tense docs with the git-revert rollback fact. bun test green fast (887 pass/73 skip) and slow (960 pass), lint/typecheck exit 0, binary answers.
## Evidence
