## Description
**Size:** M
**Files:** src/reaper-worker.ts, test/reaper-worker.test.ts
### Approach
Before `killWindow`, verify the live pane at `backend_exec_pane_id` still belongs to THIS job. Add `backend_exec_generation_id` to the jobsQuery and to `selectReapCandidates`; in `reaperCycle`'s pre-kill recheck cross-check the live `(generation_id, pane_id) -> job` mapping from the latest TmuxTopologySnapshot — skip the kill if the pane now maps to a different job, a different generation, or no live pane. Keep the reaper a pure external actuator (read-only `jobs`, writes only tmux); degrade to SKIP (never kill) if the live mapping is unavailable.
### Investigation targets
**Required** (read before coding):
- src/reaper-worker.ts:167 — selectReapCandidates predicate
- src/reaper-worker.ts:245 — reaperCycle pre-kill recheck (the CWE-367 TOCTOU mitigation; extend it with pane-identity, not just job-state)
- src/reaper-worker.ts:328 — jobsQuery (add backend_exec_generation_id)
- src/reducer.ts — the TmuxTopologySnapshot fold that keys `(generation_id, pane_id) -> job`; source of the live mapping
**Optional:**
- src/autopilot-worker.ts — loadReconcileSnapshot, how the reconciler reads the topology, if reusable by the reaper
### Risks
- The reaper must not throw or block on a topology read; degrade to skip when the mapping is unavailable.
- Don't regress the existing clean-stop + idle-grace + cooldown gates.
### Test notes
- Unit: recycled pane (generation mismatch) is SKIPPED; matching generation+pane is killed; absent live pane is skipped. Drive selectReapCandidates / reaperCycle directly with injected snapshot + fake backend.
## Acceptance
- [ ] reaper skips killWindow when the live pane's generation != the job's backend_exec_generation_id (or the pane maps elsewhere / is absent)
- [ ] a matching (generation, pane) for a cleanly-stopped keeper job is still reaped
- [ ] reaper stays read-only on jobs; no throw on missing topology (degrades to skip)
## Done summary
Window-reaper now cross-checks the latest TmuxTopologySnapshot before each kill (livePaneOwned guard): a kill fires only when the live pane still belongs to this job at its recorded generation; a recycled %N, reassigned pane, absent pane, or unavailable snapshot degrades to skip. Threaded backend_exec_generation_id through the jobs read and ReapCandidate.
## Evidence
