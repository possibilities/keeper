## Description

**Size:** M
**Files:** src/git-worker.ts, src/backstop-telemetry.ts, scripts/backstop-stats.ts, test/git-worker.test.ts, test/backstop-telemetry.test.ts, test/backstop-stats.test.ts

### Approach

Producer side of the missed-wake recalibration. (a) In the
git-heartbeat fire path (git-worker.ts:2771-2811), when a rescue
discharges a HEAD-oid delta, derive the rescued change's commit time
(committed_at_ms is already enumerated in emitSnapshot, :2243-2269) and
compute change-to-rescue latency = now − committed_at_ms, per root,
worst-case (oldest commit) when several discharge in one rescue;
dirty-tree-only rescues (no commit anchor) and negative values (clock
skew) yield null. (b) Add an OPTIONAL `change_to_rescue_ms?: number |
null` to BackstopRecord (:108-121) and buildMissedWakeRecord's args
(:178-223) — optional so the other backstop-emitting call sites are
untouched and non-git backstops never fabricate a latency; preserve the
existing lastFastPathAt===null → staleness_ms=null sentinel untouched.
Keep emitting raw staleness_ms alongside (shakeout comparison). (c)
Surface the new field through computeStats in scripts/backstop-stats.ts
(samples currently carry ts/staleness_ms); records without the field
parse as null — mixed-version ndjson is the steady state. (d) Re-arm:
on a missed-wake rescue for root R, flag R for re-subscribe and let the
existing level-triggered membership reconcile re-derive the
subscription (bounded by MAX_NEW_SUBSCRIBES_PER_CYCLE, :428-432). Do
NOT unsubscribe/resubscribe directly in the heartbeat; a subscribe
failure follows the existing reconcile error handling, never throws out
of the heartbeat. This is the reconcile mechanism with one extra
trigger — not worker respawn (no-self-heal rule untouched), no DB
write, no synthetic event.

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:2771-2811 — heartbeat fire site; buildMissedWakeRecord call at :2791-2798
- src/git-worker.ts:2195,2221-2269 — emitSnapshot HEAD-oid delta + committed_at_ms enumeration
- src/git-worker.ts:2378,2446,2529,2649 — markFastPath, subscribeRoot/unsubscribeRoot, reconcile re-subscribe path
- src/backstop-telemetry.ts:108-121,178-223 — BackstopRecord + buildMissedWakeRecord (null sentinel at :200-201)
- scripts/backstop-stats.ts — computeStats parse the sitter reads through

**Optional** (reference as needed):
- CLAUDE.md "No in-process self-heal" + "No kernel watchers" sections — the rule boundary this task must respect

### Risks

- buildMissedWakeRecord is shared by four wired workers — the new arg MUST be optional or every other call site breaks
- Clock skew can make committed_at_ms > now — clamp to null, never emit negative latency (poisons the histogram exactly like the bug being fixed)
- test:full is MANDATORY before landing (git/daemon process paths; fast tier does not cover them)

### Test notes

backstop-telemetry: builder emits change_to_rescue_ms when given, null when absent/negative, staleness_ms unchanged. backstop-stats: mixed-version ndjson (old lines without the field) parses with nulls. git-worker: heartbeat rescue with known commit time produces the expected latency; dirty-only rescue produces null; rescue flags the root and the next reconcile re-subscribes it exactly once.

## Acceptance

- [ ] Missed-wake records carry change_to_rescue_ms (null for dirty-only/negative/cold-boot); other backstop classes unchanged
- [ ] computeStats surfaces the field; old-format lines parse clean
- [ ] Missed-wake rescue triggers re-subscribe via reconcile only; no direct heartbeat resubscribe; subscribe failure cannot throw out of the heartbeat
- [ ] bun run test:full green

## Done summary
Producer side of missed-wake recalibration: git-heartbeat derives true change-to-rescue latency (now - oldest discharged commit, dirty-only/cold-boot/negative -> null) threaded through buildMissedWakeRecord's optional change_to_rescue_ms; computeStats surfaces it per-sample with mixed-version ndjson reading absent as null; a rescued root is flagged for re-subscribe via the existing level-triggered reconcile (no direct resubscribe, no respawn, no DB write).
## Evidence
