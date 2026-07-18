## Overview

A wrapped worker receives ambiguous cell signals: the claim response returns the
ASSIGNED model while the worker's baked capability is the Dispatched cell, with
nothing stating the provider-constraint translation is intentional — so one
worker refused a correct launch as a suspected bug while its sibling proceeded.
This epic surfaces requested and Dispatched side by side on the claim, resume,
and reconcile envelopes, states the validation invariant in the worker
templates (validate against the Dispatched cell; refuse only when the baked
capability disagrees with it), and recompiles the worker manifests.

## Quick commands

- cd plugins/plan && bun test ./test/saga-claim.test.ts && bun run test:gate
- keeper prompt compile --role work:worker --target claude

## Acceptance

- [ ] Claim, worker-resume, and resolve-task envelopes surface the Dispatched cell fields beside worker_model when a constraint translated the launch, omitted when unconstrained; an ALREADY_MINE re-claim without the env preserves the prior stamp
- [ ] The worker templates state the invariant: assigned-vs-baked difference under a constraint is expected; refusal triggers only on baked-vs-dispatched disagreement or a declared-but-contradictory carrier
- [ ] Recompiled manifests carry the invariant; the provider-equivalence ADR gains the requested-vs-dispatched corollary using the committed "Dispatched cell" vocabulary

## Early proof point

The claim-response test: a claim under the dispatched env carriers surfaces the
fields; a native claim omits them. If the response-builder hoist proves messy
inside the task lock: capture into function scope, reflecting the stamped
sidecar, never the raw env.

## References

- plugins/plan/src/verbs/claim.ts:158-173 env read; :339-346 stamp inside withTaskLock; :385-400 response built outside — hoist/capture needed; ALREADY_MINE overwrite at :346 must preserve-if-empty
- plugins/plan/src/verbs/worker_resume.ts:172-188 and resolve_task.ts:124-137 — parallel envelopes missing the fields (cold-resume IS the incident path); both read the stamped sidecar, no env needed
- plugins/plan/template/_partials/worker-implement-wrapped.md + template/agents/worker.md.tmpl — the carve-out home; workers read their own KEEPER_PLAN_DISPATCHED_MODEL env for validation (already at the child boundary; the spawn prompt needs no new line)
- Producer always-emit contract: src/exec-backend.ts:166-172,1421-1425 + src/reconcile-core.ts:1255-1271 (out of surface; the invariant relied on)
- CONTEXT.md:24 Dispatched cell (never "effective cell"); :53 Provider constraint; ADR target is 0047-provider-equivalence (a DUPLICATE 0047-audit-gate exists — land in the right one)
- Epic deps: none — plan-plugin surface only

## Docs gaps

- **docs/adr/0047-provider-equivalence-map-and-worker-provider-pin.md**: amend in place with the requested-vs-dispatched envelope corollary and the worker validation invariant
- **CONTEXT.md**: no new terms — the committed Dispatched cell and Provider constraint entries already carry the vocabulary

## Best practices

- **Requested and resolved side by side, never overwriting the request**; consumers validate against the RESOLVED value
- **Additive envelope fields with absent-means-unconstrained semantics** keep every existing consumer working
- **Strict refusal stays** — narrowed to the genuine bug signal (baked capability vs dispatched disagreement), never the expected translation
