## Description

**Size:** M
**Files:** cli/await.ts, src/await-conditions.ts, test/await.test.ts, test/await-conditions.test.ts, README.md, skills/await/SKILL.md, src/readiness-client.ts (JSDoc only)

### Approach

Two CLI changes on top of task 1's give-up option. (A) **Give-up wiring:**
pass the give-up policy + injected clock to `keeper await`'s subscribe
handles, and branch `onFatal` on `err.code === "unreachable"` to emit a
distinct terminal `failed reason=unreachable ... advice=<wait with 'keeper
await server-up' then re-arm this command>` (exit 1) through the existing
`emitTerminal` funnel — deduped across the up-to-three handles by the
`terminating` latch, and preempting the reconnect-blip / `deleted` swallow
logic. (B) **server-up condition:** add a `server-up` nullary condition
following the `git-clean` / `agents-idle` template across every wiring
site, BUT give it its own minimal subscribe path that opts OUT of give-up
(reconnect-forever) and fires `met` the instant the first snapshot lands
(first-paint). Reject `server-up` combined with `and` (either order) at
parse time with a clear usage error — net-new exclusivity logic, since the
current dup-guard only blocks identical conditions. Update HELP, README,
SKILL.md, and the `src/readiness-client.ts` module JSDoc to add server-up +
`reason=unreachable` and drop the "reconnects forever" language.

### Investigation targets

**Required** (read before coding):
- cli/await.ts:1327-1335 `onFatal` — add the `unreachable` branch with `advice=`
- cli/await.ts:728-742 `emitTerminal` — the single terminal funnel + `terminating` latch; reuse, don't hand-roll
- cli/await.ts:209-212 `NULLARY_CONDITIONS`, :186-190 `ConditionSegment`, :374-395 parse arity branch, :424 enumerated-conditions error string
- cli/await.ts:548-571 `SlotState` union, :624-652 segment→slot builder
- cli/await.ts:601-621 `openReadiness`/`needsRoot`/`needsJobs` stream selection — server-up needs a connection but NO git root / planctl / jobs; add a dedicated minimal subscribe branch + a `paintGate.serverUp` flag rather than bolting onto `openReadiness=hasPlanctl`
- cli/await.ts:744-834 `slotLabel` / `emitArmed` / `emitAggregateMet` — every render site switches on slot kind
- cli/await.ts:1098-1145 `evaluate()` / `allPainted()` first-paint gate — server-up = met when the gate first clears
- cli/await.ts:888-929 `reQueryHit` — the one-shot dispose pattern to mirror for server-up's clean teardown
- cli/await.ts:16-21 exit-code docblock + :88-127 HELP text
- skills/await/SKILL.md — Conditions + Reasons/exit-code tables, trigger words, no-planctl-pre-check note
- README.md ~571 (condition enum), ~938 (exit-code inline), ~580 (readiness-client description)

**Optional** (reference as needed):
- src/await-conditions.ts:591-668 `gitCleanState`/`agentsIdleState` — the nullary pattern; server-up likely needs NO pure evaluator (it's "first snapshot landed"), so don't force-fit one
- test/await.test.ts:322-379 `makeHarness`, :131 `deliverFiveEmpty` (clears first-paint = the server-up trigger), :389 arg builders

### Risks

- server-up doesn't fit the `openReadiness`/`openGit`/`openJobs` selection cleanly; bolting it onto `openReadiness=hasPlanctl` would wrongly drag in the planctl re-query machinery. Use a dedicated branch + `paintGate.serverUp`.
- The reason/exit-code contract lives in 3+ synced places (docblock, HELP, README, SKILL.md) — update all or the Monitor agent's parser and the human's mental model diverge.
- The `unreachable` give-up must preempt the reconnect-blip/`deleted` swallow and dedup across the three handles — route everything through `emitTerminal`'s `terminating` latch.

### Test notes

- server-up: `met` fires on the first `deliverFiveEmpty`; the not-ANDable rejection has a deterministic error string; `--timeout` still yields `failed reason=timeout` exit 3.
- unreachable: `onFatal(code:"unreachable")` → terminal line carries `reason=unreachable` + `advice=`, exit 1, emitted once across the handles.
- All existing await tests stay green.

## Acceptance

- [ ] `keeper await complete <id>` against a down daemon exits `failed reason=unreachable` (with `advice=`) exit 1 within ~the deadline — not a hang
- [ ] `reason=unreachable` is distinct from `connect` / `not-found` / `deleted` / `stuck`
- [ ] `keeper await server-up` blocks reconnect-forever and fires `met` on the first snapshot
- [ ] `server-up and <cond>` (either order) is rejected with a usage error at parse time
- [ ] HELP, README, SKILL.md, and readiness-client JSDoc updated and in sync
- [ ] existing await tests still pass; new server-up + unreachable tests added

## Done summary

## Evidence
