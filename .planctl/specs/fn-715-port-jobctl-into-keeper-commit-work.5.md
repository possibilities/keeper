## Description

**Size:** S
**Files:** planctl/run_close_preflight.py, planctl/cli.py, planctl/run_worker_resume.py, tests/test_util_vendored.py, planctl/CLAUDE.md, planctl/README.md, docs/reference/commit-at-mutation-boundary.md, plus any planctl skill prompt referencing `jobctl commit-work`

### Approach

Retarget the three `jobctl find-task-commit` subprocess call sites
(run_close_preflight.py:135, cli.py:557, run_worker_resume.py:135) to shell
`keeper find-task-commit` — argv[0] only; the envelope is byte-identical so
no parsing logic changes, and the fail-loud-on-non-zero behavior stays.
VERIFY `~/.bun/bin` (where `keeper` lives) is on planctl's spawn PATH at the
sites that run under cron/daemon/agent shells; if not, resolve `keeper` by an
absolute path or extend PATH. Scrape planctl's INERT cli_common provenance
docstrings in `tests/test_util_vendored.py` (the "vendored from cli_common"
history comments) — but KEEP `tests/test_sketch_refs_helper.py`'s guard test
`test_no_promptctl_or_cli_common_imports_remain_in_planctl` intact (its regex
names cli_common deliberately — it is the anti-regression mechanism, not a
stray reference). Update planctl docs: CLAUDE.md:30,32 and README:104-116 and
docs/reference/commit-at-mutation-boundary.md §6 — replace `jobctl
commit-work` → `keeper commit-work` and the lock-path mention; verify the
NDJSON envelope description matches the new TS impl. Leave
`planctl-bug-history.md` archival.

### Investigation targets

**Required** (read before coding):
- ~/code/planctl/planctl/run_close_preflight.py:135 — the literal argv + fail-loud handling
- ~/code/planctl/planctl/cli.py:557, ~/code/planctl/planctl/run_worker_resume.py:135 — other call sites
- ~/code/planctl/tests/test_util_vendored.py — the provenance docstrings to scrub
- ~/code/planctl/tests/test_sketch_refs_helper.py — the guard test to PRESERVE

### Risks

- PATH: `keeper`→`~/.bun/bin`, old `jobctl`→`~/.local/bin`; a spawn env missing `~/.bun/bin` breaks the retarget at runtime → COMMIT_LOOKUP_FAILED.
- Accidentally weakening the cli_common guard test while "scrubbing references".

### Test notes

planctl test suite green; `rg -n 'jobctl' planctl/ docs/` returns zero
functional refs (archival bug-history excepted); the guard test still fails
if a cli_common import is reintroduced.

## Acceptance

- [ ] Three call sites shell `keeper find-task-commit`, fail-loud preserved, `~/.bun/bin` PATH verified.
- [ ] Inert cli_common provenance docstrings removed; guard test preserved and still enforcing.
- [ ] planctl CLAUDE.md/README/commit-at-mutation-boundary.md renamed; bug-history untouched; tests green.

## Done summary
Retargeted close-preflight's commit-lookup call site to shell keeper find-task-commit (fail-loud preserved; ~/.bun/bin confirmed on PATH), scrubbed inert cli_common provenance docstrings in test_util_vendored.py while preserving the cli_common guard test, and renamed jobctl->keeper across CLAUDE.md/README/commit-at-mutation-boundary.md plus the work/worker skill+agent templates (regenerated) and test mocks. 792 tests pass.
## Evidence
