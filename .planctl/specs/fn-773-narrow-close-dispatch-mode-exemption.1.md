## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts, CLAUDE.md, README.md

### Approach

Add an armed-mode suppression condition to the close-row dispatch verdict in
`reconcile` (the `okToPlan` chain) — NOT to `readiness.ts` (fn-770's mutex
layer deliberately keeps close rows mode-exempt; that stays) and NOT to
completion-reap (stays fully mode-exempt). A close dispatch in armed mode is
eligible iff the epic is in-flight or chosen: `eligible.has(epic_id)` (the
per-cycle armed dep-closure already in scope, src/autopilot-worker.ts:1106-1112)
OR `isOccupyingJob(snapshot.jobs, "close", epicId)` / an occupying work job on
any of its tasks (:1035) OR a live `close::<epic>`/`work::<task>` surface in
`snapshot.liveTabKeys` (:564, :1282). A cold candidate (none of the signals)
is suppressed. Reuse the existing signals — no new snapshot fields, no schema
or RPC change, no wall-clock beyond the passed `now`; keep `reconcile` pure.
Place the suppression so it never consumes budget (mirror the work-gate's
above-budget placement, :1199-1200) and stamp it with an fn-NNN provenance
comment in the house style. Update the WORK-ONLY block comment (:1102-1105)
and the CLAUDE.md/README sentences claiming `close` finalizers are
mode-exempt unconditionally.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:1198-1212 — the WORK-ONLY gate (`armedMode && verb === "work" && !eligible?.has(...)`) whose shape the new close arm mirrors
- src/autopilot-worker.ts:1268-1315 — the close-row dispatch site (`okToPlan` chain) where the condition lands; verdict from `readiness.perCloseRow`
- src/autopilot-worker.ts:1035-1050 — `isOccupyingJob` (the live/recent-job signal; already used at :1278)
- src/armed-closure.ts:52-99 — `computeEligibleEpics` (armed ∪ transitive upstreams; the closure-membership signal)
- test/autopilot-worker.test.ts:2761-2784 — "close fires for a disarmed-but-in-flight epic": its fixture is actually a COLD candidate (no live job/tab); rework it into a genuinely in-flight fixture and add the new cold-candidate-suppressed test
- test/autopilot-worker.test.ts:662, :711-731, :1079-1109 — close-row suppression test patterns to mirror (liveTabKeys / cooldown / finalizer-guard)

**Optional** (reference as needed):
- src/autopilot-worker.ts:1140-1150 + :501 — completion-reap path (`completedRowIds`, `isCompletionReapCandidate`): must stay untouched and mode-exempt
- test/autopilot-worker.test.ts:158, :181, :108 — `makeSnapshot`/`makeState`/`makeEpic` fixtures (`mode:"armed"` + `armedIds` overrides)

## Acceptance

- [ ] Armed mode: a never-armed, no-live-job, no-live-surface close-ready epic yields no `close::` launch; each in-flight signal (eligible-closure, occupying job, live surface) independently keeps the close firing
- [ ] yolo mode byte-for-byte unchanged; completion-reap unchanged; readiness.ts untouched
- [ ] The :2761 test reworked to a real in-flight fixture + new cold-candidate suppression test; suppression consumes no budget
- [ ] WORK-ONLY comment, CLAUDE.md, and README updated to describe the narrowed exemption
- [ ] `bun run test:full` green

## Done summary

## Evidence
