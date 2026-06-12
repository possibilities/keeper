## Description

**Size:** M
**Files:** tests/test_worker_verbs.py (new)

### Approach

Write the engine-agnostic spec for claim/done/block before the bun side exists, proven against Python in both engines. Seed exclusively via seed_state + monkeypatch.chdir + run_cli (the tests/test_session_markers.py:221+ pattern); never seed_epic (it calls scaffold, which the bun binary does not implement). Coverage: claim success envelope (task_id/epic_id/target_repo/primary_repo/tier/worker_agent/task_state/epic_state/brief_ref) with runtime state read back from the .planctl/state file; claim typed error envelopes and the --force matrix (TASK_DONE never bypassed; CLAIMED_BY_OTHER/TASK_BLOCKED/DEPS_UNMET bypassed); claim and block produce ZERO commits (git log count delta, the test_emit.py:279 no-op pattern); block sets blocked + blocked_reason and clears on disk; done under frozen PLANCTL_NOW + CLAUDE_CODE_SESSION_ID: spec sections patched, worker_done_at stamped on the tracked task JSON equal to the frozen value, exactly one commit whose subject is `chore(planctl): done <task_id>`-shaped and whose body carries Planctl-Op/Planctl-Target/Planctl-Prev-Op (+ Session-Id) trailers; done without CLAUDE_CODE_SESSION_ID hard-errors (fail-closed) while claim succeeds without it (fail-open). Commit-asserting tests carry real_git so the default engine exercises them honestly; under conformance everything is real git anyway. Assert on envelopes, .planctl/ files, and git log — not on Python internals.

### Investigation targets

**Required** (read before coding):
- tests/test_session_markers.py:221+ — the seed_state-seeded claim/done pattern to copy
- tests/test_emit.py:279 — the no-op/zero-commit assertion pattern
- planctl/run_claim.py — gate codes, force matrix, envelope fields
- planctl/run_done.py and planctl/run_block.py — stamps, patches, error gates
- tests/conftest.py seed_state — what the seeder writes (no briefs/ dir; spec files present)

**Optional** (reference as needed):
- tests/test_readonly_verbs.py — established engine-agnostic idioms (trailer split, byte pins)
- tests/test_init.py — already conformance-eligible; do not duplicate its coverage

### Risks

Work-marker assertions live under HOME and are engine-portable only via the session-marker file contract — include them only where the existing pattern already proves portability; over-reaching into marker internals makes tests python-bound.

### Test notes

Green three ways before done: default engine, PLANCTL_BIN=python planctl, and the full fast gate unchanged.

## Acceptance

- [ ] claim/done/block covered incl. force matrix, fail-open/fail-closed session-id polarity, zero-commit and one-commit assertions, frozen-clock stamp equality
- [ ] Green in default engine and against Python via PLANCTL_BIN; fast gate untouched
- [ ] No seed_epic/scaffold seeding anywhere in the module

## Done summary

## Evidence
