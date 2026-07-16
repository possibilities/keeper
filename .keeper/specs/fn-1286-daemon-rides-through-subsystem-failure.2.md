## Description

**Size:** M
**Files:** src/daemon.ts, src/dispatch-failure-key.ts, docs/problem-codes.md, CLAUDE.md, test/daemon.test.ts

### Approach

The serve-liveness watchdog fatalExits the whole daemon on `accept-stall-bus` even when the READ server probe is green — restart cannot fix an external cause, so a bus-side storm crash-loops the daemon (ADR 0059 records the decision and tradeoff). Give the pure reducer a third verdict kind: `{kind:"degrade", trigger:"accept-stall-bus"}`. The reducer's existing check order (server streak before bus streak) is the safety proof — both-probes-dead still resolves server-first to fatal. The MAIN-thread consumer answers a degrade by minting one idempotent, level-triggered bus-degraded distress row (new key in the dispatch-failure-key vocabulary; producer-owned, exempt from retry_dispatch clears; it pages via the task-1 fail-visible path) and keeps the bus probe armed so recovery is observable; the row level-clears the moment the probe reports live again. The mint must ride the recoverable-event path, never a raw insert — a SQLITE_BUSY throw on the watchdog tick would re-introduce the crash-loop this fix removes. All other triggers (including accept-stall-server) keep fatalExit unchanged. Mirror the tmux-control degrade-in-place shape. Carry the one-line CLAUDE.md serve-liveness correction (prune-not-append, lint green) and the problem-codes.md row.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves (fn-1282 deletes other regions of daemon.ts).*

**Required** (read before coding):
- src/daemon.ts:4292-4301 — ServeLivenessTrigger union + verdict type (gains the degrade variant)
- src/daemon.ts:4378-4524 — decideServeLivenessWatchdog pure reducer; the accept-stall-bus branch at ~4502-4507 is THE line; check order at ~4496 is the both-dead safety proof
- src/daemon.ts:14184-14309 — the MAIN-thread watchdog consumer (currently fatalExits on every escalate; gains the degrade branch)
- src/daemon.ts:7588 — mintRecoverableSnapshotEvent: the SQLITE_BUSY-safe mint path
- test/daemon.test.ts:1222-1360 — the existing decideServeLivenessWatchdog truth-table suite the new rows slot into

**Optional** (reference as needed):
- src/tmux-control-worker.ts:648-669 — the landed degrade-in-place mirror (hotfix precedent)
- src/daemon.ts:4527+ — per-socket probe arming (bus arms independently — keep armed while degraded)
- src/dispatch-failure-key.ts, src/daemon.ts:494-496 — key vocabulary + producer-owned clear exemption
- docs/adr/0059-bus-only-serve-stall-degrades-in-place.md — the recorded decision this implements

### Risks

- The degrade path re-evaluates every tick while the bus stays down — the mint must be idempotent (in-memory latch or open-row suppression) or the distress table churns.
- An internal bus-worker deadlock now degrades permanently instead of restart-clearing — accepted in ADR 0059; the distress row pages so an operator can bounce keeperd deliberately.
- CLAUDE.md edit is lint-gated (`bun scripts/lint-claude-md.ts`) — one tight line, no narration.

### Test notes

Extend the existing truth-table: bus-streak-at-cap with green server → degrade (not escalate); server-streak-at-cap → escalate regardless of bus; both-at-cap → escalate (server first); bus recovery after degrade → ok + level-clear evidence. Pure seam only — no real sockets. Register new suites with the fn-1281 gate manifest if any new file is added.

## Acceptance

- [ ] A sustained bus-probe failure with a green READ-server probe never exits the daemon: the verdict is degrade, one distress row exists, and the board keeps serving.
- [ ] A sustained READ-server-probe failure still fatalExits, including when the bus is also failing.
- [ ] The bus-degraded distress row is minted idempotently, pages the operator, and level-clears when the bus probe recovers.
- [ ] CLAUDE.md's serve-liveness guardrail line reflects the scoped fatal triggers; the CLAUDE.md lint and the touched suites pass.

## Done summary
Serve-liveness watchdog gains a degrade verdict for accept-stall-bus: a sustained bus-only stall no longer fatalExits the daemon, instead minting one idempotent, paged, level-cleared bus-degraded distress row while the READ server keeps serving; server-stall triggers (including both-dead) still fatalExit unchanged. CLAUDE.md's serve-liveness bullet and docs/problem-codes.md carry the correction.
## Evidence
