## Description

**Size:** S
**Files:** planctl/models.py, planctl/run_claim.py, planctl/run_resolve_task.py, planctl/run_worker_resume.py, tests/test_models.py, tests/test_claim.py, tests/test_resolve_task.py, tests/test_worker_resume.py

### Approach

Add one shared helper in `planctl/models.py` beside `TASK_TIERS`:
`worker_agent_for_tier(tier: str | None) -> str | None`. Contract: returns
`f"plan:worker-{tier}"` for a `TASK_TIERS` member, returns `None` when
`tier is None` (legacy pre-fn-594 records), and raises `ValueError` for a
non-null string that is not a `TASK_TIERS` member (corrupt-on-disk guard).
Then in each of the three verbs, alongside the existing `"tier": tier`
entry in the emitted envelope dict, add `"worker_agent": worker_agent_for_tier(tier)`.
This is additive and backward-compatible: nothing reads the field yet
(the skill consumes it in task 2). `claim` still succeeds on a null-tier
task — claimability is its contract, not tier validity; the fail-loud on
null moves to the skill spawn site (task 2).

### Investigation targets

**Required** (read before coding):
- planctl/models.py:27 — `TASK_TIERS = ("medium","high","xhigh","max")`; the helper goes directly beside it and validates against this tuple (do NOT add a second tier list)
- planctl/models.py:~130 — the `tier` load-time null default; confirms `tier` is legitimately nullable
- planctl/run_claim.py:285 (tier read) and the `emit({...})` dict ~391-403 where `"tier": tier` is placed — add `worker_agent` in the same dict
- planctl/run_resolve_task.py:174 (tier read), :186 (emit) — same pattern
- planctl/run_worker_resume.py:102-113 (tier resolve), :189 (emit) — same pattern; leave the stderr tier note at :181 alone

**Optional** (reference as needed):
- planctl/brief.py:~104,132 — `assemble_brief` threads `tier`; do NOT add `worker_agent` here (it is a spawn-time routing fact, not worker-runtime context)

### Risks

Null-tier contract is the load-bearing decision — keep the helper returning
`None` (not a sentinel string) so the skill can branch cleanly. Do not let
`worker_agent_for_tier` silently format `None` into `"plan:worker-None"`.

### Test notes

Unit-test the helper directly (valid tiers → `plan:worker-<tier>`; `None` →
`None`; bogus string → `ValueError`). Extend the three verb tests to assert
`worker_agent` is present and equals `plan:worker-<tier>` for a normal task,
and `null` for a null-tier task.

## Acceptance

- [ ] `worker_agent_for_tier` exists in `models.py` beside `TASK_TIERS`; valid tier → `plan:worker-<tier>`, `None` → `None`, invalid string → `ValueError`
- [ ] `claim`, `resolve-task`, `worker resume` envelopes each carry `worker_agent` derived via the shared helper, beside the existing `tier` field
- [ ] null-tier task yields `worker_agent: null` in all three envelopes without erroring the verb
- [ ] helper + three-verb envelope tests pass; `worker_agent` is NOT added to the brief

## Done summary

## Evidence
