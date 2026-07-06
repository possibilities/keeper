## Description

**Size:** S
**Files:** src/derivers.ts, src/dispatch-command.ts, cli/dispatch.ts, src/reconcile-core.ts

### Approach

Register the two escalation spawn names as first-class verbs and give them their own launch tier. `SPAWN_VERB_REF_RE` (src/derivers.ts) gains `unblock|deconflict` so their sessions fold `jobs.plan_verb`/`plan_ref` and inherit reap/instant-death handling like `resolve::` (module stays dep-free). Launch config: `ESCALATION_MODEL = "sonnet"` / `ESCALATION_EFFORT = "high"` constants beside the worker constants, plus an escalation-config resolver that coalesces an `escalation` preset from presets.yaml over the constants (mirror resolveWorkerLaunchConfig; place it where the daemon imports it without pulling the worker module — check the import graph) — deliberately independent of the `worker` preset. Manual parity: `keeper dispatch` accepts `unblock::fn-N-slug.M` / `deconflict::fn-N-slug` with the same race guard, defaulting model/effort from the escalation config and booting the `/plan:<verb> <id>` prompt. The retry wire stays narrow: sticky rows remain keyed `work::<task>` / `close::<epic>`, so RETRY_DISPATCH_VERBS is NOT extended — if manual dispatch parsing needs the new names, grow a separate dispatchable-verb set rather than widening the retry_dispatch validator. Verify boot orphan-GC and isRetryableDispatchKey treat live unblock::/deconflict:: jobs correctly (first-class jobs rows, not GC-able orphan keys) and add a regression test.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/derivers.ts:37 — SPAWN_VERB_REF_RE deliberately-locked whitelist; src/derivers.ts:52 — HANDOFF_SPAWN_RE contrast (the class the new verbs are NOT)
- src/reconcile-core.ts:256-257 — WORKER_MODEL/WORKER_EFFORT; src/autopilot-worker.ts:435-474 — resolveWorkerLaunchConfig preset-coalesce shape
- src/dispatch-command.ts:25-31, :59-100, :109, :135-137 — retry verbs, parseDispatchKey, isRetryableDispatchKey, defaultPlanPrompt
- cli/dispatch.ts:508-540 (model precedence), :349-387 (race guard), :597 (plan-form prompt)

**Optional** (reference as needed):
- src/agent/config.ts — presets.yaml schema for the escalation preset key

### Risks

- Widening RETRY_DISPATCH_VERBS by reflex would let retry_dispatch accept keys that never exist as sticky rows — keep the retry wire unchanged.
- The dep-free discipline on derivers.ts and dispatch-command.ts binds (hook-imported leaf modules).

### Test notes

Unit tests beside the existing derivers/dispatch-command tests: the regex accepts and folds both new spawn names; escalation config coalesces preset-over-constants; manual dispatch parses both keys; the retry_dispatch wire validator is byte-identical in behavior.

## Acceptance

- [ ] unblock::/deconflict:: spawn names project jobs.plan_verb/plan_ref like resolve::
- [ ] The escalation launch config resolves sonnet/high by default and honors an escalation preset independently of the worker preset
- [ ] keeper dispatch accepts the two escalation keys manually with race-guard parity while the retry_dispatch wire validator is unchanged
- [ ] derivers and dispatch-command modules remain dep-free

## Done summary
Registered unblock::/deconflict:: as first-class escalation dispatch verbs: SPAWN_VERB_REF_RE folds them into jobs.plan_verb/plan_ref like resolve::; added ESCALATION_MODEL/EFFORT constants + resolveEscalationLaunchConfig (light leaf, no worker-module pull); parseDispatchableKey widens manual dispatch while retry_dispatch stays byte-identical; keeper dispatch accepts both keys with race-guard parity and escalation model/effort defaults.
## Evidence
