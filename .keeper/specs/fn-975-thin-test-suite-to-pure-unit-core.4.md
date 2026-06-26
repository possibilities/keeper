## Description

**Size:** S
**Files:** test/events-writer.test.ts, test/sidecar-writer.test.ts, test/branch-guard.test.ts

### Approach

Cut the subprocess-spawning hook tests (each spawns a real `bun` child running
the hook) but PRESERVE coverage of the hook DECISION logic by calling the
exported functions directly — no spawn. A broken hook fails the human's live
session closed or corrupts the repo, so this is the one coverage class kept
via a pure in-process seam rather than dropped to production-only. Cover:
events-writer's NDJSON record builder + must-exit-0 contract; sidecar-writer's
decision; branch-guard's allow/deny classification in BOTH directions — deny a
subagent git branch/switch/worktree op (agent_id present) AND allow main's own
in-daemon worktree producer (no agent_id) — plus the `permissionDecision:"deny"`
envelope shape. Use the exec-backend/restore-worker injected-stub pattern. If a
hook's decision isn't already an exported pure function, factor a thin pure seam;
prefer testing existing exports.

### Investigation targets

**Required** (read before coding):
- plugins/keeper/plugin/hooks/ — branch-guard, events-writer, sidecar-writer sources (what's exported as pure logic)
- test/branch-guard.test.ts:141/249/270, test/events-writer.test.ts:103/167/358/1214/1338, test/sidecar-writer.test.ts:306 — the spawn tests being replaced
- test/exec-backend.test.ts, test/restore-worker.test.ts — the injected-stub pure pattern

### Risks

The decision logic may not be cleanly exported (factoring a seam adds scope).
The branch-guard allow-main-producer / deny-subagent contract is subtle — the
pure test MUST assert both directions or it gives false confidence.

### Test notes

No hook test spawns a subprocess after this; the deny/allow/exit-0 contracts are
asserted by direct calls against constructed inputs.

## Acceptance

- [ ] No hook test spawns a real subprocess
- [ ] Pure in-process tests cover: events-writer exit-0 + record build, sidecar decision, branch-guard deny-subagent AND allow-main-producer + deny-envelope shape

## Done summary
Factored pure decision seams (branch-guard decideBranchGuard, events-writer buildEventBindings) and converted all three hook tests to in-process calls — zero subprocess spawns; covers both gate directions, the events record build + exit-0 totality, and the sidecar commit decision.
## Evidence
