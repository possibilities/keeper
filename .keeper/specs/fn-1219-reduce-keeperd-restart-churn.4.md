## Description

**Size:** S
**Files:** system/buildbot/master.cfg, system/buildbot/deploypath.py, system/tests/test_deploypath.py

### Approach

keeper's plan tooling checkpoints board state under `.keeper/` — the majority of keeper main commits — and each such commit currently triggers a full keeper build on the serialized LocalWorker despite changing nothing a build verifies. Add a pure predicate (e.g. `is_keeper_state_only_change(files)`) in the deploypath module, mirroring the existing `is_sitter_plist_change` pattern (pure module so `checkconfig` never executes it and pytest covers it): True iff `files` is non-empty AND every path is under `.keeper/`. Thread an optional per-project file filter through the PROJECTS/JobSpec normalization so the keeper build scheduler constructs its ChangeFilter with `project=`, `branch=`, AND a `filter_fn` suppressing state-only changes — ChangeFilter conditions AND together, and `filter_fn` must not use renderables. Empty `change.files` lets the build through (explicit policy — some GitPoller/merge situations yield empty file lists, and fail-open is correct here). Filter ONLY at the upstream change-consuming scheduler: the Dependent keeper-install job green-gates on the build's completion and never re-runs file filters. collapseRequests semantics are untouched — a filtered change never becomes a build request, and a batch mixing one real change with several state-only commits still collapses into one build that correctly runs.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- system/buildbot/master.cfg:341-370 — normalize_jobs scheduler construction where the per-project filter threads in
- system/buildbot/master.cfg:489-497 + system/buildbot/deploypath.py — the is_sitter_plist_change pure-predicate precedent
- system/buildbot/master.cfg:539-548 — collapseRequests comment (interaction to leave untouched)

**Optional** (reference as needed):
- system/buildbot/master.cfg:756-767 — GitPoller wiring (change.files come from here, tree-relative)
- system/tests/test_buildbot_notify.py — the pytest idiom for buildbot-adjacent pure modules
- scripts/checkconfig.sh — the config gate to run after editing master.cfg

### Risks

- Predicate direction inverted (suppressing mixed commits) starves real builds — the pytest cases are the guard.
- A future rename of keeper's `.keeper/` state directory silently un-filters — fail-open and acceptable.

### Test notes

`uv run pytest` green with new predicate cases (all-state-only, mixed, empty list, nested paths); `bash scripts/checkconfig.sh` passes; lint/format per repo convention (`uv run ruff check .`, `uv run ruff format --check .`).

## Acceptance

- [ ] A change whose files are all under `.keeper/` produces no keeper build request, while mixed and empty-file-list changes still trigger the build — proven by pure predicate tests covering all three cases
- [ ] buildbot checkconfig passes with the filter in place
- [ ] The predicate lives in a pure module covered by pytest and the repo's full test suite stays green

## Done summary

## Evidence
