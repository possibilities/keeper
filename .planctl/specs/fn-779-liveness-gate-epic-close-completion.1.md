## Description

**Size:** M
**Files:** src/readiness.ts, src/epic-deps.ts, test/readiness.test.ts

### Approach

Two coupled edits in the readiness pass, both pure (injected `now`, no Date.now/env/DB):

1. **Close-row predicate 1** (`evaluateCloseRow`): change the terminal guard to `epic.status === "done" && !anyEmbeddedJobWorking(epic.jobs) && !closeRowHasRunningSubagent(epic, perTask, subRunningByJobId) && !closeRowMonitorOccupies(epic, perTask, now)`. Use the CLOSE-scope poolers — the exact calls predicates 5/6/6.6 make below — not the task-path primitives, so the guard and the fall-through verdicts agree on scope (epic-level close jobs + completed-task backstop). The stale-split helpers (`allCloseRow*AreStale`) stay out of predicate 1; only the booleans gate. A done-but-live close row then falls through to `running:job-running` / `sub-agent-running|stale` / `monitor-running|stale`, which keeps it a live-work/root occupant. Fall-through is safe: once idle, predicate 1 fires `completed`; while not-done the pipeline never reaches the bottom `ready`.

2. **Predicate 9 `satisfied` branch** (`evaluateTask`): build an `epicsById: Map<string, Epic>` once in the `computeReadiness` prologue (from the already-materialized `epicsArr`; no epic map currently exists) and thread it to `evaluateTask`. On `dep.state === "satisfied"`, look up `dep.resolved_epic_id` in the map. If the upstream is present AND a new helper `epicHasLiveCloseScopeWork(upstream, subRunningByJobId, now)` returns true, emit `{ tag: "blocked", reason: { kind: "dep-on-epic", upstream: dep.resolved_epic_id, cross_project: dep.cross_project } }` — the existing reason kind byte-for-byte, no new vocabulary. If the upstream is absent (cross-project, out-of-snapshot, or null `resolved_epic_id`), keep today's `continue`. Check EVERY satisfied entry, not just the first. Do not perturb the `resolved_epic_deps === null` short-circuit.

3. **The new helper** must be order-independent: pool ANY embedded job on the upstream (epic-level or task-level) that is working, ANY running subagent under those jobs, ANY live monitor lease — deliberately NOT gated on `perTask` completed tags and NOT reading `perCloseRow`. A forward-referenced upstream (consumer epic sorts earlier in `epicsArr`) has no verdicts computed yet; gating on them would make the answer depend on board sort order. For a done upstream, a live job anywhere is wind-down and must hold the dependent.

Reducer and resolver stay untouched: `epicIsCompleted` (src/epic-deps.ts) and the `resolved_epic_deps` stamp in src/reducer.ts remain status-only by invariant (folds never probe liveness).

Comment work in the blocks this task edits (conventions agreed with the in-flight prose-overhaul epic — apply them, do not extend the old style): rewrite each touched comment to the present-tense invariant plus the why the code cannot show; zero ticket ids in comments (provenance lives in the commit message and this spec); delete REMOVED-predicate tombstones on touch, keeping at most a forward rule where re-adding is a plausible trap. Must rewrite: the close-row predicate-1 comment (currently says completion is status-alone), the "dep-on-epic — not applicable to the close row" comment above predicate 9's close-row counterpart, the predicate-9 comment block, and the `epicIsCompleted` docstring in src/epic-deps.ts (it claims identity with the close-row terminal check — now an intentional divergence: resolver = status-only stamp; close-row completed = status AND idle). The predicate RANK ORDER comment at the top of the file stays intact.

Deliberate non-goal: no TTL/ceiling auto-promote for a never-idle closer (human-confirmed policy). The escape hatches are the existing exit-watcher Killed arm (main close job), the monitor release ceiling, and the sub-agent-stale pill + pause/manual replay.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:1046-1050 — close-row predicate 1, the edit site
- src/readiness.ts:733-740 — task-path predicate 1, the mirror pattern
- src/readiness.ts:1102-1160 — predicates 5/6/6.6 and the exact pooler call shapes
- src/readiness.ts:881-934 — predicate 9 and its satisfied/blocked-incomplete/dangling branches
- src/readiness.ts:412-537 — computeReadiness prologue (taskById/epicsArr; where epicsById gets built) and the per-epic loop order at :551-585 (why forward refs have no verdicts)
- src/readiness.ts:1804-1816, 1991-2008, 2072-2089 — anyEmbeddedJobWorking, closeRowHasRunningSubagent, closeRowMonitorOccupies signatures
- test/readiness.test.ts:46-219 — fixture builders (makeEpic/makeTask/makeEmbeddedJob with plan_verb override, makeSub, makeResolvedDep) and the run/runWithNow runners
- test/readiness.test.ts:1779-1803 — the out-of-snapshot satisfied test that MUST keep passing unmodified

**Optional** (reference as needed):
- test/readiness.test.ts:332, :370, :429 — task-path liveness tests to clone as close-row twins
- src/epic-deps.ts:110-146 — epicIsCompleted + ResolvedEpicDep shape (resolved_epic_id, cross_project)

### Risks

- Order-dependence is the trap: if the upstream check reads perCloseRow or gates its scan on perTask tags, a forward-referenced upstream silently falls back to satisfied and the bug survives for exactly that subset. The helper pools raw epic state only.
- The close-row guard and the fall-through predicates must agree on scope; using task-path primitives in the guard would let a live completed-task backstop job produce completed-with-live-work.
- A close row that flips done then completed one cycle later must not re-arm dispatch; the redispatch cooldown already covers this window — do not add suppression.

### Test notes

Fast tier (default bun test). Close-row twins of the task-path liveness tests, built with plan_verb:"close" epic-level jobs, asserted via snap.perCloseRow: done + working job → running:job-running; done + running subagent → running:sub-agent-running; done + all-stale subagents (runWithNow) → running:sub-agent-stale; done + live monitor (runWithNow) → running:monitor-running; done + idle → completed. Predicate 9: upstream in snapshot with live closer → blocked:dep-on-epic; upstream in snapshot idle → ready; upstream NOT in snapshot → ready (existing test untouched); multiple satisfied deps where a later one is live → blocked; forward-reference order (consumer epic before upstream in the input array) → still blocked, proving order independence.

## Acceptance

- [ ] Close row with status done + live close-scope work renders running:* and still occupies the per-epic/per-root mutexes; flips completed only when idle
- [ ] Downstream task with a satisfied dep on an in-snapshot, live-closing upstream renders blocked:dep-on-epic with the existing reason payload; idle and out-of-snapshot upstreams behave as today
- [ ] test/readiness.test.ts:1779-1803 passes unmodified
- [ ] src/reducer.ts and the epicIsCompleted return value are untouched (docstring rewrite only)
- [ ] Touched comments rewritten to present-tense invariants with no ticket ids; RANK ORDER comment intact
- [ ] bun test passes

## Done summary

## Evidence
