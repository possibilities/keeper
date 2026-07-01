## Description

**Size:** M
**Files:** plugins/plan/src/models.ts, plugins/plan/src/verbs/{scaffold.ts,refine_apply.ts,claim.ts,worker_resume.ts,resolve_task.ts}, plugins/plan/src/verbs/task_set_tier.ts (delete), plugins/plan/src/cli.ts, plugins/plan/src/brief.ts, plugins/plan/skills/plan/SKILL.md, plugins/plan/skills/work/SKILL.md, plugins/plan/CLAUDE.md, plugins/plan/test/*

### Approach

Add `model` to the task schema: default `model: null` in `normalizeTask` (mirror the `tier: null` default
at models.ts:67 — required is enforced only at the creation-verb layer, never at fold/normalize, so
legacy tasks never throw). Add `model` validation to scaffold's three tier sites and to refine_apply,
accumulating a `modelErrors` list and emitting a new `model_invalid` code in the SAME accumulate-all pass
(not short-circuiting ahead of `tier_invalid`). Change the resolver to `workerAgentFor(tier, model)`:
compose `plan:worker-<model>-<effort>` from the task's own fields; return null (→ `/plan:work` stops with
a typed "model unset — remediate via /plan:plan refine") when EITHER axis is null, and throw on a non-null
value outside the config sets. Emit `worker_model` on the claim/resume/resolve envelopes. **Remove**
`task_set_tier.ts` + its `cli.ts` registration and add `set-tier` to the plan CLAUDE.md "Removed verbs
(do not re-add)" list; do NOT add `set-model`. Leave the op-deriver's historical `set-tier` recognition
intact (re-fold determinism — historical events must still derive the same `plan_op`). Update plan
SKILL.md: add a `model` field beside `tier` (5d/5e), YAML examples, and prune "Every worker runs opus".

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/models.ts:52-77 (`normalizeTask`, tier:null default at :67), :135 (`workerAgentForTier` → `workerAgentFor`, null-return contract)
- plugins/plan/src/verbs/scaffold.ts:418-508,770-782 (the three tier sites), refine_apply.ts:309-321 — mirror for model + `model_invalid`
- plugins/plan/src/verbs/task_set_tier.ts + plugins/plan/src/cli.ts — the verb + registration to remove
- plugins/plan/skills/plan/SKILL.md:372-380,426,490 — tier bands + YAML examples to twin with model
- plugins/plan/skills/work/SKILL.md:46,62,64 — field list + null-tier-stop prose to generalize to null-model

**Optional** (reference as needed):
- plugins/plan/src/brief.ts:38,55 — tier carry; add a model sibling only if resume/telemetry needs it (the worker itself does not)
- the op-deriver + test/derivers.test.ts — confirm historical set-tier recognition stays

### Risks

- Event-sourcing back-compat: a legacy task with no model must fold to `model: null` and stop like null-tier, never throw in a fold.
- Removing the verb must not remove the deriver's historical `set-tier` op mapping (re-fold determinism).
- The two null sources (tier or model) collapse to one null-stop; make the typed stop message name which axis is unset if cheap.

### Test notes

Test `model_invalid` accumulates alongside `tier_invalid`; null-model → null resolver return → stop;
`workerAgentFor` unit (member/null/throw for both axes). Update/remove set-tier tests (src-cli-groups,
verbs-restamp, saga-validate-resolve, creation-epic-ops, saga-worker-resume). Confirm derivers.test.ts
still passes with set-tier recognition retained.

## Acceptance

- [ ] `model` is a required, config-validated per-task field; `model_invalid` mirrors `tier_invalid` in the accumulate-all pass.
- [ ] The resolver composes `plan:worker-<model>-<effort>` from task fields; null on either axis stops like null-tier; envelopes carry `worker_model`.
- [ ] `normalizeTask` defaults `model: null`; legacy model-less tasks never throw in a fold.
- [ ] `set-tier` is removed (verb + CLI + tests) and listed under Removed verbs; `set-model` is not added; the deriver still recognizes historical `set-tier`.
- [ ] plan/work SKILL.md document `model` as a first-class per-task field; "Every worker runs opus" is pruned.

## Done summary
model is now a required, config-validated per-task axis: normalizeTask defaults model:null (legacy tasks fold, never throw), scaffold/refine-apply emit model_invalid in the accumulate-all pass after tier_invalid, and the resolver composes plan:worker-<model>-<effort> via workerAgentFor(tier,model) with claim/resume/resolve envelopes carrying worker_model (null on either axis stops /plan:work). set-tier verb removed; deriver keeps historical recognition.
## Evidence
