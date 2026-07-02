## Description

**Size:** M
**Files:** src/reducer.ts, test/reducer-links.test.ts, test/refold-equivalence.test.ts, README.md

### Approach

MEASURE FIRST, then bound. The 437s orphan fold's cost lives either in the input loads (loadAllCommitTrailerFacts at reducer.ts:7112 — whole-table; the cross-session events sweep at :7214/:7249 — instrumented via factsLoadMs and the [pretufold-breakdown] accumulators) or in deriveJobLinks re-derivation CPU across swept sessions (NOT separately instrumented). Step one: add the missing deriveJobLinks-segment timing to the existing breakdown accumulators, and count orphan-path firing frequency from the live DB read-only (commit-channel sessions with no jobs row — if autopilot commits routinely hit the orphan path, this is hot-path work, not incident-response, and the boot-seed warmer becomes mandatory). Step two, choose by the numbers:
- I/O-dominated → id-watermark memos over the inputs: commit_trailer_facts is append-only (INSERT OR IGNORE on event_id PK, no UPDATE/DELETE — no invalidation story needed), so a whole-table memo with the watermark clamped INCLUSIVE of currentEventId (deliberate departure from MonitorProvenanceMemo's -1 clamp: foldCommit INSERTs the current event's own fact at :2381 then calls syncPlanLinks at :2550 — an exclusive clamp would drop the commit's own creator/refiner edge; document and test this); plus a bounded reverse index for "sessions touching epic E" serving BOTH channels (the scrape-channel events UNION at :7214 and commitTrailerSessionsForEpics at :7236 — an input memo that serves only one channel undercounts).
- CPU-dominated → eliminate the sweep: extend the normal path's per-key replace-merge (mergeJobLinkSlice :7316-7333) to the orphan case — the merge reads epics.job_links which exists regardless of orphan-ness; what orphan lacks is only the jobs.epic_links pre-state. If the sweep proves to be pre-merge-era conservatism, removing it must re-prove last-touch reconciliation for orphan sessions explicitly.

Either way: every read gains the event-id ceiling (live-fold semantics — today the unbounded reads see future rows on re-fold; safe only because a LATER touch reconciles, which fails exactly when the orphan event is the LAST touch of an epic); the orphan-vs-normal strategy split stays a pure function of event position (:7093-7101); guard against the fact-write-gate mismatch (facts are written on a WIDER gate at :2375 than the syncPlanLinks trigger at :2548 — untouched facts must still surface identically under the bound); no fold may throw; retention never NULLs the scanned plan columns (the gitAttribMemos correctness premise at :1226-1229 — verify it extends to plan_op/plan_target/plan_epic_id before trusting a watermark memo over events plan rows).

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:7087-7360 — the full syncPlanLinks, both strategies, the orphan sweep
- src/reducer.ts:2361-2568 — foldCommit: fact INSERT, the trigger-gate mismatch, the call site
- src/reducer.ts:6971-7038 — both fact loaders; :7316-7333 mergeJobLinkSlice
- src/reducer.ts:9099-9146 — the incident comment and PreToolUse breakdown retrofit
- test/reducer-links.test.ts:1890,2435-2465 — the re-fold determinism pin and the existing orphan-path tests

**Optional** (reference as needed):
- src/reducer.ts:1215-1456,8722-8809 — the two memo templates
- test/reducer-lifecycle.test.ts:2040-2119 — the warm-vs-cold shape

### Risks

- The orphan-last-touch case is where the current future-read is load-bearing: a bound that changes intermediate state MUST still land identical final bytes, and the one scenario with no downstream reconciliation gets its own red-first test
- A session flipping orphan→normal mid-history (late SessionStart) is untested today — the chosen mechanism must cover the transition
- Memory: memoizing the whole plan history on the main connection — measure footprint against the gitAttribMemos precedent before accepting

### Test notes

New equivalence cases: orphan event as last touch of an epic a future event also touches (the divergence scenario); orphan→normal transition; warm-vs-cold byte-equal for any memo built; inclusive-clamp test proving the current commit's own fact lands. Keep :1890 and :2435-2465 green. Record the measured before/after fold timings in Evidence.

## Acceptance

- [ ] deriveJobLinks segment timing + orphan frequency measured and recorded before the mechanism was chosen
- [ ] The orphan path is structurally bounded by the measured-appropriate mechanism; strategy split remains a pure function of event position
- [ ] id ceilings added with live-fold byte-identity; orphan-last-touch and transition tests red-first then green
- [ ] README orphan prose revised + incident paragraph; full fast suite green

## Done summary

## Evidence
