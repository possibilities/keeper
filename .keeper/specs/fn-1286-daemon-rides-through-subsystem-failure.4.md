## Description

**Size:** S
**Files:** src/readiness.ts, src/readiness-client.ts, src/await-conditions.ts, test/board.test.ts

### Approach

The `running:sub-agent-stale` hold is an open `subagent_invocations` row whose SubagentStop never landed — by design, so fan-in never fires while a worker might still write. But when the owning pid is PROVEN dead and the worker phase is done, the hold can never release on its own: the process that would emit the terminal event no longer exists. Add the escape valve ADR 0060 specifies: the readiness completion predicate discounts an open sub-agent invocation when the owning session's pid is proven dead AND worker_phase is done. This is a pure computation change consuming already-plumbed liveness facts — no schema change, no fold change, no new RPC. The discount applies ONLY to the done phase: a working-phase orphan stays held (that is phantom-working territory with its own machinery). Trace exactly which liveness facts reach the readiness computation (proven-dead evidence lives in the autopilot reconcile snapshot; readiness is computed client-side with an injected clock) — plumbing a proven-dead fact through to the predicate, if absent, is in scope; inventing a new liveness probe is not.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/readiness.ts:1-45 — computeReadiness predicate pipeline; the done-AND-idle hold and its header comment
- src/await-conditions.ts:855-860 — "a done task without SubagentStop is running:sub-agent-stale by design" — the consumer whose semantics this valve refines
- src/subagent-invocations.ts:167-174 — the open-invocation row shape (status='running', duration_ms NULL)
- src/autopilot-worker.ts:8748-8760 — the pid reprobe that proves death into provenDeadJobIds (the evidence source)

**Optional** (reference as needed):
- src/readiness-client.ts:2353-2355 — caller-injected clock (the purity pattern any new fact must follow)
- src/reconcile-core.ts:759-760 — harnessActivityByJobId threading (the fact-plumbing precedent)
- docs/adr/0060-zombie-session-hybrid-reaper.md — the valve's recorded rationale

### Risks

- The valve must not weaken the mutex-holding property for live sessions: a pid that is alive — even ambiguous — keeps the hold. Only proven-dead discounts.
- Fact availability is the real work: if readiness cannot currently see proven-dead evidence, the plumbing must follow the existing injected-facts pattern, never an in-predicate liveness probe (folds and pure passes never probe).

### Test notes

Truth-table: done + open invocation + pid proven dead → completed; done + open invocation + pid alive → running:sub-agent-stale (unchanged); working + open invocation + pid dead → held (unchanged, not this valve's business). Extend the existing readiness/board suites; register any new file with the fn-1281 gate manifest.

## Acceptance

- [ ] A done-stamped task whose owning session pid is proven dead completes despite an open sub-agent invocation; dependent tasks unblock.
- [ ] A done-stamped task whose owning pid is alive keeps the running:sub-agent-stale hold exactly as before.
- [ ] A working-phase task is unaffected by the valve in every liveness state.
- [ ] The touched suites and the named gate pass.

## Done summary

## Evidence
