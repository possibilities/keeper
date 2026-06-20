## Description

**Size:** M
**Files:** apps/jobctl/ (remove), pyproject.toml, uv.lock, scripts/install.sh, CLAUDE.md, plus a new thin `jobctl` shim (location per investigation), and any arthack skill/prompt referencing `jobctl commit-work`

### Approach

Pull the Python package once everything routes through keeper (tasks 2-3
live + tested, planctl retargeted in task 5). Remove `apps/jobctl/` entirely;
drop it from the uv workspace members + root `pyproject.toml` + `uv.lock` +
`scripts/install.sh`; the cross-repo editable `keeper-py = {path=...}` dep
that lived in jobctl's pyproject goes away with it. Install a thin standalone
`jobctl` shim (a small executable on PATH — today `~/.local/bin/jobctl`) that
re-execs `keeper "$@"` so `jobctl commit-work …`, `jobctl find-task-commit …`
etc. keep working for stale in-flight agent prompts (the verbs map 1:1 by
name). Update arthack `CLAUDE.md:30` (worker contract: `jobctl commit-work` →
`keeper commit-work`, flock name) and replace `apps/jobctl/CLAUDE.md` with a
one-line tombstone pointing at `keeper commit-work`. Sweep arthack
skills/prompts for `jobctl commit-work` and rename. Confirm `cli-common`
losing jobctl as a consumer leaves no dangling reference.

### Investigation targets

**Required** (read before coding):
- ~/code/arthack/apps/jobctl/pyproject.toml — the keeper-py editable dep + scripts entry to remove
- ~/code/arthack/pyproject.toml, ~/code/arthack/scripts/install.sh — workspace membership + install wiring
- ~/code/arthack/CLAUDE.md:30 — the worker-contract bullet to rename
- where `jobctl` is currently installed on PATH (`which jobctl` → `~/.local/bin/jobctl`) — the shim target

### Risks

- Ordering: must land AFTER tasks 2/3/5 — deleting the Python verbs before keeper's are proven + planctl retargeted would break commits/close-preflight.
- The shim must re-exec, not recurse: ensure `keeper` (not `jobctl`) is invoked, and the verb name passes through unchanged (commit-work stays commit-work).
- Untracked build artifacts under `apps/jobctl` can block removal in some sync setups — verify a clean delete.

### Test notes

`test ! -d apps/jobctl`; `jobctl commit-work --help` (via shim) returns
keeper's help; arthack lint/test green; `rg -n 'jobctl commit-work' ~/code/arthack`
returns only the shim + archival.

## Acceptance

- [ ] `apps/jobctl` removed; scrubbed from uv workspace + pyproject + uv.lock + install.sh.
- [ ] `jobctl` shim re-execs `keeper`, verbs pass through 1:1; stale `jobctl commit-work` prompts still work.
- [ ] arthack CLAUDE.md renamed, apps/jobctl/CLAUDE.md tombstoned, skills/prompts swept.
- [ ] arthack lint + tests green.

## Done summary
Retired the Python jobctl package: removed apps/jobctl/, scrubbed it from the uv workspace + root pyproject + uv.lock + pnpm-lock + install.sh, dropped chatctl's dead jobctl dep, and installed a thin jobctl shim (system/arthack/.local/bin/jobctl) that re-execs keeper so stale agent prompts still work. Swept docs/skills/prompts/hooks/cli-boundaries from jobctl commit-work to keeper commit-work and renamed the commit-via-jobctl-default snippet to commit-via-keeper-default. arthack lints + edited-surface tests green.
## Evidence
