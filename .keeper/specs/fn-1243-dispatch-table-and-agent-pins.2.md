## Description

**Size:** M
**Files:** src/daemon.ts, src/autopilot-worker.ts, src/reconcile-core.ts, src/handoff-worker.ts, cli/dispatch.ts, src/escalation-config.ts, src/agent/config.ts, test/autopilot-worker.test.ts, test/dispatch-cli.test.ts, test/agent-config.test.ts

### Approach

Cut every dispatch site to `resolveDispatchLaunchConfig(verb)` and finish the clean replace. Snapshot widening: the reconcile snapshot carries each verb's resolved pair (work AND close independently settable) — the producer resolves both verbs outside the fold; the pure core stays config-blind. Reroute: the `resolve::` dispatch stops inlining the worker constants (deliberate behavior change: it starts honoring operator config); the shared escalation dispatch's verb-blind `resolveConfig()` becomes verb-parameterized (`args.verb` is in scope — author against fn-1240's LANDED shape, where task-scoped resolve::<taskId>/deconflict::<taskId> share the same verb keys); handoff adds model/effort to its LaunchSpec only when the handoff row is present (deliberate behavior change: handoff becomes pinnable; absent row = today's flagless launch). cli/dispatch.ts precedence becomes explicit --model/--effort > --preset triple > dispatch[verb] > floor, byte-identical to the daemon path. Delete resolveWorkerLaunchConfig and src/escalation-config.ts (consumers now import the leaf module). Remove the catalog's worker/escalation fields and add the fail-loud migration hint naming the `dispatch:` block (clone the retired-presets: pattern). A catalog with neither legacy keys nor a dispatch table must produce byte-identical launch argv to today for every verb.

### Investigation targets

*Verify before relying — fn-1240 is rewriting the daemon dispatch surface; re-locate these anchors in the landed tree before coding.*

**Required** (read before coding):
- src/reconcile-core.ts:586-587, 1886-1887, 1963-1964 — snapshot.workerModel/workerEffort reads to widen per-verb
- src/autopilot-worker.ts (~:7252 pre-merge) — the snapshot producer call site that resolves worker config into the snapshot
- src/daemon.ts:3210 + :10694 — shared dispatchEscalationSession's verb-blind resolveConfig and its wiring
- src/daemon.ts:11582-11583 (pre-fn-1240) — the resolve:: inline constants being rerouted; fn-1240 may have moved/extended this site
- src/handoff-worker.ts:273-276 — the flagless handoff LaunchSpec
- cli/dispatch.ts:623-657 — the precedence block and its worker-vs-escalation verb branch
**Optional** (reference as needed):
- src/agent/config.ts:421-428 — the migration-hint pattern to clone for worker:/escalation:
- src/agent/launch-config.ts — LaunchSpec omits --model/--effort when fields are undefined (handoff rides this)

### Risks

- fn-1240 merge adjacency: the escalation/resolver code this task edits is the surface fn-1240 just rewrote — reconcile against its landed shape, not this spec's line numbers.
- The escalation-guard hook keys on KEEPER_ESCALATION_ROLE (a runtime marker), NOT the retired config key — no hook change is in scope; do not touch plugins/keeper hooks.
- Re-fold determinism: config resolution stays producer-side; nothing inside a fold reads the catalog.

### Test notes

Golden-argv tests: for each verb, a dispatch:-less catalog yields today's exact flags (work/close/resolve sonnet+max, escalations sonnet+high, handoff none); a configured row overrides; a leftover worker:/escalation: key fails loud with the hint. Extend the existing autopilot-worker resolver tests and dispatch-cli precedence tests rather than authoring parallel suites.

## Acceptance

- [ ] work, close, resolve, unblock, deconflict, repair, and handoff dispatches all source model/effort from the dispatch table; close is settable independently of work
- [ ] With no dispatch table and no legacy keys, every verb's launch argv is byte-identical to the prior defaults
- [ ] A leftover worker: or escalation: key fails the catalog loud with a migration hint naming dispatch:
- [ ] The twin resolvers are gone; manual keeper dispatch and autopilot resolve the same values for the same verb
- [ ] Setting resolve: in the table changes the resolver session's launch flags (the named behavior change is live)

## Done summary

## Evidence
