## Description

**Size:** M
**Files:** src/readiness.ts, src/readiness-inputs.ts, src/readiness-client.ts, src/reconcile-core.ts, src/collections.ts, test/readiness.test.ts, test/readiness-client.test.ts, test/board.test.ts, CONTEXT.md, docs/adr/0087-provider-leg-activity-precedence.md

### Approach

Behavioral contract per ADR 0087: `computeReadiness` gains one new pure
input — a map from wrapper job id to the freshest owned live Provider
leg's activity timestamp (unix seconds) — appended LAST with an inert
empty default so every positional call site and the simulator stay
valid. One shared exported helper builds the map for BOTH assemblers
(the reconciler's input loader and the board client): join
provider-leg-ownership rows filtered explicitly to live state (never
rely on the subscribe-path default clause being applied by a direct
read) to the jobs projection via the leg's session/job id; freshest leg
activity wins per wrapper job; an absent leg row contributes no
evidence. In the task-path predicate-6 split and the close-row split
(both funnel through the shared staleness helper), when every running
sub-agent is age-stale but at least one owned leg's activity is fresh
within the existing staleness window, render the new distinct running
reason `provider-leg-active`; with no fresh leg evidence the
conservative `sub-agent-stale` path stays byte-identical (a
dead/unknown child keeps occupying the mutex). Same constant, no raised
timeout, no second ceiling: a wedged leg stops folding events and
re-stales naturally. One fresh owned leg on any of the row's embedded
jobs keeps the whole row non-stale (the existing every-not-any
discipline). A future-skewed leg timestamp (negative age) counts as
fresh. The new reason rides the generic running-kind handling: awaits
keep waiting, the pill formatter auto-renders, board color falls
through to running-blue.

Out of scope: the dash AGENTS-region glyph derivation (separate
harness-activity seam; acknowledged divergence in ADR 0087), status
tally taxonomy (the new reason counts as fresh running under ADR 0083),
wrapper footer/title UX.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/readiness.ts:963-980 — task-path predicate-6 stale split (root-cause site)
- src/readiness.ts:2274-2298 — allRunningSubagentsAreStale, the shared helper both paths call
- src/readiness.ts:1267-1278 and :2463-2494 — close-row split + allCloseRowRunningSubagentsAreStale
- src/readiness.ts:313-318, :331, :533-594 — RunningReason union, SUBAGENT_STALENESS_SEC, and the append-last-with-inert-default parameter pattern
- src/readiness-inputs.ts:107-224 — loadReadinessInputs, the sole reconciler-side builder (add the read + shared map here)
- src/readiness-client.ts:2292-2306, :2543-2564, :2609-2642 — board client already projects providerLegOwnershipTyped but never feeds computeReadiness
- src/collections.ts:806-840 — PROVIDER_LEG_OWNERSHIP_DESCRIPTOR (default clause is session-liveness, NOT live-state)
- src/db.ts:6037-6080 — provider_leg_ownership schema (leg_session_id joins to jobs.job_id; state; ownership_epoch_event_id)
- src/reconcile-core.ts:2326-2360 — positional computeReadiness call site to thread the new input

**Optional** (reference as needed):
- src/board-render.ts:590-629 — bucketForToken blue fall-through for the new token
- src/await-conditions.ts:222,265,815-860,1033 — running-kind → waiting mapping (assert the new kind joins no terminal/stuck set)
- test/readiness.test.ts:67-211 — fixture builders (makeTask/makeEpic/makeEmbeddedJob/makeSub)
- docs/adr/0087-provider-leg-activity-precedence.md — the recorded decision; true up if implementation names shifted

### Risks

- Direct-read vs default-clause semantics: if the reconciler read returns all ownership rows, an unfiltered join leaks settled/transferred leg activity — the explicit live-state + session-liveness filter in the shared helper is the guard; cover with a regression test.
- Which folded events advance a leg's jobs-row activity timestamp is the evidence-quality linchpin: if a non-progress event bumps it, precedence over-trusts a chatty leg for at most one window. Verify while implementing; record the finding in the ADR Consequences if it deviates. Do NOT add a second ceiling in this task.
- Nested leg cascade (a leg owning a leg): only the wrapper's direct legs are consulted; a nested-only progression stays conservative — acceptable, note if witnessed.
- Byte-identity: refold-equivalence and simulator suites guard the inert default; any divergence with an empty map is a defect.

### Test notes

Red-repro first: a fixture composing a wrapper embedded job + an open
subagent invocation with a frozen timestamp older than the window + a
separate top-level leg job with fresh activity + a live ownership row
must render provider-leg-active where today it renders sub-agent-stale;
the same fixture minus the fresh leg (or with a transferred-state row)
must stay sub-agent-stale. Cover the close-row analog. Named gates
only: `bun test ./test/readiness.test.ts ./test/readiness-client.test.ts ./test/board.test.ts`
plus `bun run typecheck`, and the refold-equivalence gate for
byte-identity.

## Acceptance

- [ ] A wrapped row (task or close) whose running sub-agent evidence is age-stale but whose owned live Provider leg shows fresh activity renders `[running:provider-leg-active]`, with verdict tag and mutex occupancy identical to other running reasons.
- [ ] With no fresh owned-leg evidence — no ownership row, absent leg job, settled/transferred leg, or a stale leg timestamp — the row renders `[running:sub-agent-stale]` exactly as before; deterministic regression tests prove the conservative path unchanged.
- [ ] One shared exported helper builds the wrapper-to-leg-activity map from live-state ownership rows joined to the jobs projection, and both the reconciler input loader and the board client consume it — no duplicated builder logic.
- [ ] An empty leg-activity input is byte-inert: existing readiness, readiness-client, and refold-equivalence suites pass without changes to their expectations.
- [ ] The new reason maps to waiting for awaits (never terminal/stuck) and colors as running-blue on the board, both asserted by tests.
- [ ] CONTEXT.md carries a provider-leg-active glossary entry; the recorded ADR decision matches shipped behavior (names trued up if they shifted).
- [ ] Focused named gates plus typecheck are green.

## Done summary
Added providerLegActivityByWrapperJobId (shared builder in readiness-client.ts, consumed by both loadReadinessInputs and subscribeReadiness) as a new appended-last computeReadiness input; task and close-row staleness splits now render running:provider-leg-active when an owned live Provider leg shows fresh activity within the staleness window, otherwise falling back to the byte-identical sub-agent-stale path. Added regression tests (fresh/stale/absent/future-skewed/transferred leg cases, close-row analog, await/board-color assertions) and a CONTEXT.md glossary entry; ADR 0087 Consequences trued up on evidence-quality wording.
## Evidence
