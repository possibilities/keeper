## Description

**Size:** S
**Files:** (validation only — no source; capture results in the epic Evidence)

### Approach

Final sign-off gate. Run planctl's existing full workflow cycle (init → scaffold → claim → done → close-preflight → audit → verdict → close-finalize) in a scratch repo against the relocated `plugins/plan/` build, watching planctl's rollback triggers (non-zero exit by verb, warmed steady-state p95 vs the `.1` baseline, the `Uncaught`/`error:`/`Traceback` stderr patterns). Then a combined-plugin regression check: a fresh keeper session behaves identically to the pre-fold baseline — keeper's own commit loop (`keeper commit-work` + the `git add <paths> && git commit` escape hatch) is NOT denied by planctl's content-blind commit-guard (this co-load is status quo, so confirm no regression), and the events-writer records tool-use rows alongside planctl's guards.

### Investigation targets

**Required**:
- planctl CLAUDE.md "Bun cutover runbook" — the soak cycle + the exact rollback triggers + p95 method
- the `.1` p95 baseline fixture — the steady-state comparison point

### Risks

- p95 > 2× the `.1` baseline, or any non-zero exit on a known-good verb during soak → roll back per the epic Rollout, surface loudly.

### Test notes

Soak in a scratch repo in its OWN fresh git repo (auto-commits need it). `claim` is cwd-agnostic — use `--project <scratch>` for a repo outside configured roots.

## Acceptance

- [ ] full planctl cycle passes against the `plugins/plan/` build; warmed p95 within the `.1` baseline triggers
- [ ] fresh keeper session: `keeper commit-work` + the escape-hatch commit are NOT denied by the co-loaded commit-guard (no regression vs status quo)
- [ ] events-writer + planctl guards both fire in one session without suppressing the `events` row append
- [ ] go / no-go recorded in the epic Evidence; if go, note the standalone `planctl` remote may now be archived (deferred, optional)

## Done summary
GO. Sign-off soak passed against the relocated plugins/plan/ build (built+promoted from new location, HEAD ed9c596a). Full cycle init->scaffold->claim->done->close-preflight->audit->verdict->close-finalize all exit 0, outcome=closed_clean; no Uncaught/error:/Traceback in any soak stderr. Warmed p95 122ms vs .1 baseline 152ms (2x trigger=304ms) — no regression, faster. Regression checks PASS: commit-guard fails open for keeper commit-work + git-add-paths escape hatch (no work-marker => allow, status quo); events-writer appends per-pid NDJSON row for same Bash event while commit-guard co-fires, both exit 0, row not suppressed; resolveEventsLogDir byte-synced (src/db.ts:334 == hook:406). Subtree split --prefix=plugins/plan reconstructs 409-commit pushable branch, merge commit e6c8f01e anchors git-subtree-dir trailer (no --squash damage). Standalone planctl remote may now be archived (deferred, optional).
## Evidence
