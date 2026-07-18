## Description

**Size:** M
**Files:** plugins/plan/src/verbs/claim.ts, plugins/plan/src/verbs/worker_resume.ts, plugins/plan/src/verbs/resolve_task.ts, plugins/plan/template/_partials/worker-implement-wrapped.md, plugins/plan/template/agents/worker.md.tmpl, plugins/plan/test/saga-claim.test.ts, plugins/plan/test/src-brief-claim.test.ts, docs/adr/0047-provider-equivalence-map-and-worker-provider-pin.md

### Approach

Three coupled moves on the plan-plugin surface. Envelopes: the claim response
surfaces `dispatched_model`/`dispatched_tier`/`dispatch_constraint` beside
`worker_model` — values reflect the STAMPED runtime sidecar (hoist or capture
the env read so the response builder outside the task lock sees it), fields
OMITTED when unconstrained; an ALREADY_MINE re-claim without the env carriers
preserves the prior stamp instead of wiping it; `worker resume` and
`resolve-task` re-surface the same fields from the sidecar (the cold-resume
path is exactly the incident scenario). Templates: the wrapped partial and
worker template state the invariant — under a Provider constraint the
assigned `worker_model` may differ from the baked capability by design; the
worker validates against the Dispatched cell via its own
KEEPER_PLAN_DISPATCHED_MODEL env; empty carriers on a wrapped cell mean no
translation occurred and the baked capability is the launch truth; refusal
(TOOLING_FAILURE) triggers ONLY when a non-empty dispatched carrier
disagrees with the baked capability. Use "Dispatched cell" verbatim — never
"effective cell" (Avoid-listed). Recompile the worker manifests via the
prompt compiler (generated outputs never hand-edited) and amend the
provider-equivalence ADR (mind the duplicate 0047 filename) with the
corollary.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/claim.ts:158-173,339-346,385-400 — env read, in-lock stamp, out-of-lock response; the hoist and the ALREADY_MINE preserve rule
- plugins/plan/src/verbs/worker_resume.ts:172-188; resolve_task.ts:124-137 — the parallel envelopes to extend from the sidecar
- plugins/plan/template/_partials/worker-implement-wrapped.md:3,12,24-35,54 — where the baked capability and refusal guidance live
- plugins/plan/template/skills/work.md.tmpl:40-51,71-91 — orchestrator envelope consumption + spawn prompt (verify no new config line is needed since the worker reads env)

**Optional** (reference as needed):
- plugins/plan/test/consistency-skills.test.ts:933-972 — frontmatter pins that must stay green post-recompile
- src/exec-backend.ts:1421-1425 — the always-emit carrier contract relied on

### Risks

- The response must reflect the sidecar, not the raw env, or ALREADY_MINE re-claims diverge
- Recompile churns every generated worker manifest — the conformance pins must stay green

### Test notes

Claim under carriers → fields surface; native claim → omitted; ALREADY_MINE
re-claim without carriers → prior stamp preserved and surfaced; resume and
resolve-task surface the sidecar values; existing field-presence assertions
extended, none broken. Template conformance: the invariant prose present in
the wrapped partial; rendered manifests carry it post-recompile.

## Acceptance

- [ ] The three envelopes surface the Dispatched cell fields from the stamped sidecar when constrained and omit them when unconstrained, with ALREADY_MINE preserving prior stamps
- [ ] The worker templates state the validation invariant with the narrowed refusal rule and the committed vocabulary, and the recompiled manifests carry it
- [ ] The provider-equivalence ADR records the corollary
- [ ] The plan test gate passes with the extended envelope assertions

## Done summary

## Evidence
