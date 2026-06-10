## Description

**Size:** S
**Files:** work-plugins/ (delete), tests/test_generated_guard_hook.py

### Approach

Physically remove the `work-plugins/` directory tree (its contents are
gitignored rendered agents + manifests + sidecars; `git rm` touches nothing
tracked, so a plain `rm -rf work-plugins/` plus committing the now-absent
`.gitignore` lines from task 2 is the whole change). Update the cosmetic
`work-plugins/.../worker.md` path strings in `tests/test_generated_guard_hook.py`
(~120, 216) — they live inside stubbed promptctl envelopes the stub never
reads from disk, so they are illustrative, not behavioral; repoint them to the
`agents/worker-<tier>.md` shape for accuracy. Run a final
`promptctl render-plugin-templates` + check-generated pass to confirm nothing
regenerates under `work-plugins/`. **This task only dispatches after the
keeperd bounce (epic Rollout) — deleting earlier breaks a live old daemon.**

### Investigation targets

**Required** (read before coding):
- work-plugins/ — confirm every file under it is gitignored (rendered output + sidecars); nothing tracked to `git rm`
- tests/test_generated_guard_hook.py:~120,216 — `work-plugins/.../worker.md` strings inside stub envelopes; cosmetic repoint to `agents/worker-<tier>.md`

### Risks

Ordering: this is the only step unsafe before the keeperd bounce. The `deps: [3]`
edge plus the Rollout runbook enforce it. Do not delete if any `work-plugins`
reference still resolves in a running daemon.

### Test notes

`uv run pytest tests/test_generated_guard_hook.py` green; full suite green;
`promptctl render-plugin-templates --project-root <root>` produces no
`work-plugins/` output.

## Acceptance

- [ ] `work-plugins/` tree removed; re-render produces no `work-plugins/` output
- [ ] `test_generated_guard_hook.py` stub path strings repointed to `agents/worker-<tier>.md`; tests green
- [ ] full planctl suite green

## Done summary
Deleted the gitignored work-plugins/ tree (per-tier rendered agents + manifests + sidecars; nothing tracked) and repointed the cosmetic stub-envelope path in test_generated_guard_hook.py to the agents/worker-high.md shape. Re-render produces no work-plugins/ output; full planctl suite green.
## Evidence
