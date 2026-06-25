## Description

**Size:** M
**Files:** src/restore-set.ts, scripts/restore-agents.ts, cli/setup-tmux.ts, test/restore-set.test.ts

### Approach

Add `deriveLastGenerationSetFromTopology(db, { currentGenerationId })` as the PRIMARY last-generation deriver, and demote the existing `deriveLastGenerationSet` (`BackendExecStart`-anchored killed-cohort model) to a clearly-labeled fallback invoked only when the primary finds no dying-generation snapshot. Probe `G_now` with the reused `probeServerGeneration` at restore time (in the consumer, NEVER a fold). Select the dying generation = the newest `TmuxTopologySnapshot` whose `generation_id != G_now`, read via a read-only `events` query `ORDER BY id DESC` following the `seedLastGenerationHash` daemon-down template (`JSON.parse`, never throw, degrade cleanly). `G_now == null` (no server up) ⇒ the newest snapshot overall is the dying generation. Multiple dead generations ⇒ the SINGLE newest non-`G_now` generation only (older crashes are manual escalation). A malformed newest snapshot ⇒ skip to the next-newest `!= G_now`, do not drop straight to fallback. Build candidates from the snapshot panes (filter by `session_name`, resume by latest job name, order by `window_index` via the existing `compareCandidates`), reading job identity from the payload `job_id` with the `(generation_id, pane_id)` projection join as the per-pane fallback. Reuse the `collectCrashCandidates` idempotence filters verbatim (require backend coords, exclude `plan_verb='work'`, exclude live `job_id`s). When the fallback fires, surface a labeled note (mirrors the `[paused]` banner convention) so a degraded restore is visible. Wire the three `restore-agents.ts` `--last-generation` call sites and `setup-tmux.ts`'s `defaultCandidateCount` to the new primary so the OFFER COUNT matches what `--apply` restores.

### Investigation targets

**Required** (read before coding):
- src/restore-set.ts:435-509 — `deriveLastGenerationSet` to demote; `:308-400` `collectCrashCandidates` + idempotence filters at `:355-374` to reuse in fallback
- src/restore-set.ts:129-183 — `RestoreCandidate`/`RestoreSetResult` shapes + `compareCandidates` to reuse verbatim
- src/restore-worker.ts:1076-1102 — `probeServerGeneration` (G_now), `:1161-1186` `seedLastGenerationHash` (read template)
- scripts/restore-agents.ts:486,516,539 — deriver call sites; `:612+` the `--apply` path
- cli/setup-tmux.ts:660-690 — `defaultCandidateCount`, the single deriver consumer for the offer

**Optional**:
- src/restore-set.ts:524+ — `deriveCurrentSet` (panes→ordered-candidates shape reference)
- test/restore-set.test.ts:558,656 — the real-incident regression scenarios to extend

### Risks

- Boot ordering: dead-generation `Killed` events are minted BEFORE the new server's first `BackendExecStart`/snapshot — the dying-gen snapshot legitimately has a lower rowid than `G_now`'s first post; the `!= G_now` scan must not re-introduce a `BackendExecStart`-id anchor.
- PID reuse: a fast restart can reuse the dead server's pid so `G_now == dying-gen pid`, excluding the right snapshot → fallback. Accepted (degrades to a miss, not a wrong restore); document it.
- `localeDefaultedEnv` must wrap the restore-time `G_now` probe (a C-locale client corrupts tmux output).

### Test notes

Add a topology-anchored sibling to the real-incident regression: seed a dying-generation snapshot + a day of older killed rows + a respawned `G_now`; assert ONLY the snapshot's panes are offered. Cover: `G_now == null`, multiple dead generations (single-newest wins), malformed-newest skip, and the no-snapshot → labeled fallback path. Pure-module tests via `freshDbFile`; inject the `spawnSync` seam for `G_now`.

## Acceptance

- [ ] `deriveLastGenerationSetFromTopology` is the primary `--last-generation` deriver; `deriveLastGenerationSet` is the labeled fallback
- [ ] Restore set = the dying generation's last snapshot panes (filtered by session, ordered by window_index), job identity from payload `job_id` with the projection join as per-pane fallback
- [ ] `G_now == null`, multiple-dead-generations (single newest), and malformed-newest-skip all handled per the approach
- [ ] No-snapshot case falls back to the killed-cohort model with a visible labeled note
- [ ] `restore-agents --last-generation` call sites + `setup-tmux` offer count switched to the primary
- [ ] Real-incident regression: respawned server + day-old killed rows offers only the live windows

## Done summary
Added deriveLastGenerationSetFromTopology as the primary --last-generation deriver (dying-gen TmuxTopologySnapshot anchored, selected by probing G_now), demoted the killed-cohort model to a labeled fallback, and wired restore-agents + setup-tmux to the primary.
## Evidence
