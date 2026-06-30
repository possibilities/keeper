## Description

**Size:** M
**Files:** src/readiness-client.ts, cli/autopilot.ts (export projectors), test/readiness-client.test.ts

Un-drop the autopilot fields the readiness client already computes but
discards, so every downstream reader (board, dash, await, the new
`keeper status`/`watch`) sees mode / armed-set / caps / worktree_mode on
one snapshot. This is the keystone the rest of the epic builds on.

### Approach

Extend the `ReadinessClientSnapshot` interface (`src/readiness-client.ts:162-194`)
with `autopilot_mode` (`"yolo"|"armed"`), the armed/eligible epic-id set,
`max_concurrent_jobs`, `max_concurrent_per_root`, and `worktree_mode`. The
values are already in hand: `mode`/`eligibleEpicIds` are computed at
`:1655-1686`, `maxConcurrentPerRoot` is latched off the boot-status header
at `:1764-1768`, and `worktree_mode`/`max_concurrent_jobs` are a column read
off the `autopilot_state` singleton (`autopilotState.byId`, already pulled at
`:1655/:1664`) via the existing pure projectors in `cli/autopilot.ts:319-389`
(`projectAutopilotMode`/`projectMaxConcurrentJobs`/`projectMaxConcurrentPerRoot`/
`projectWorktreeMode`). Add the fields to the `onSnapshot({...})` construction
at `:1727-1739` (the current drop site). Mirror the target shape in
`cli/board.ts:486-501` (`apState`). Reuse the projectors — do not re-coerce
`autopilot_state` inline.

### Investigation targets

**Required** (read before coding):
- src/readiness-client.ts:162-194 — `ReadinessClientSnapshot` interface (add fields here)
- src/readiness-client.ts:1655-1686 — mode/armed/eligible computation
- src/readiness-client.ts:1727-1739 — the `onSnapshot({...})` drop site (widen here)
- src/readiness-client.ts:1764-1768 — `maxConcurrentPerRoot` boot-header latch
- cli/autopilot.ts:319-389 — pure projectors to reuse
- cli/board.ts:486-501 — target `apState` shape

**Optional:**
- cli/await.ts:1200-1210 — how await already reads `snap.autopilotPaused` (the existing precedent for a snapshot autopilot field)

### Risks

- subscribeReadiness is shared by board/dash/await/status/watch. These fields are ADDITIVE (no change to the `states` array or `emitSnapshotIfReady` gate), so the risk is low — but board/dash must render byte-identically. Prove that.
- Boot-status latch timing: `maxConcurrentPerRoot` rides `onBootStatus` and is read on the NEXT emit. Default to the safe value (the projector default) until the header lands; never emit a stale `1x` as authoritative.

### Test notes

Extend test/readiness-client.test.ts: assert the new fields are populated from a fixture `autopilot_state` row and default safely when the row is missing/malformed (paused, yolo, caps default). Pure — no daemon.

## Acceptance

- [ ] `ReadinessClientSnapshot` carries `autopilot_mode`, the armed/eligible set, `max_concurrent_jobs`, `max_concurrent_per_root`, `worktree_mode`.
- [ ] Values come from the existing projectors / computed locals, not new inline coercion.
- [ ] Missing/malformed `autopilot_state` defaults to the safe side (paused/yolo/caps=1).
- [ ] board/dash snapshot output is byte-identical to before (additive-only proof).
- [ ] `bun test` green.

## Done summary
Extended ReadinessClientSnapshot with autopilotMode, the armed/eligible epic-id closure, maxConcurrentJobs, the boot-header-latched maxConcurrentPerRoot, and worktreeMode — additive only, reusing the shared cli/autopilot projectors and the locals that feed computeReadiness so board/dash render byte-identically.
## Evidence
