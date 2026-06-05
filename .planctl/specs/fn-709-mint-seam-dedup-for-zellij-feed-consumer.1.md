## Description

**Size:** M
**Files:** src/backend-worker.ts, src/daemon.ts, test/zellij-events-worker.test.ts, README.md, src/zellij-events.ts

Add a consumer-side dedup gate to `scanZellijEventsDir` so a feed line
whose effective `(tab_id, tab_name)` already equals the live job's current
projection state is skipped before the INSERT — eliminating the no-op
`BackendExecSnapshot` mints that are 68% of the event log (53.6% pure
consecutive dupes). Server-only, schema-neutral.

### Approach

1. **Widen `readLiveJobsWithCoords`** (src/backend-worker.ts:71): add
   `backend_exec_tab_id, backend_exec_tab_name` to the SELECT and to the
   `LiveJobRow` interface (50-55) as `string | null` (both are nullable
   TEXT). The widened SELECT is additive; the only existing caller is
   `scanZellijEventsDir`.
2. **Carry tab state in the per-scan map** (src/daemon.ts:779-795): change
   the `liveJobs` map value from a bare `job_id` string to
   `{ job_id, tabId, tabName }` seeded from the new columns. The
   `Map<string, string>` type annotation at line 779 MUST change. Keep the
   key shape `${session}::${pane_id}` exactly. Normalize the seeded tabId
   with `String(... ?? "")`-style handling; treat a NULL seeded `tab_name`
   (job never folded a snapshot) as "no last-known" → always allow the
   first mint.
3. **Add the dedup gate** in the mint loop (src/daemon.ts ~1014-1067),
   AFTER the existing empty-`tab_name` skip (~1007) and no-live-job skip
   (~1015), BEFORE the INSERT. Predicate — skip iff
   `record.tab_name === lastKnown.tabName` AND
   `effectiveTabId === lastKnown.tabId` where
   `effectiveTabId = (String(record.tab_id ?? "") || lastKnown.tabId)`
   i.e. a null/empty line tab_id COALESCE-preserves the prior, mirroring
   `foldBackendExecSnapshot`'s `tab_id = COALESCE(?, ...)` / `tab_name = ?`
   asymmetry (reducer.ts:3804-3812). Compare is AND-of-both-axes — never
   name-only, never raw-tab_id-only.
4. **Update in-scan last-known after a successful mint:** mutate the map
   value's `{tabId, tabName}` to the just-minted effective values ONLY
   inside the `try`, AFTER `insertEvent.run()` returns (co-located with the
   `TRACE_ZELLIJ` tick at ~1072). A failed INSERT (catch ~1073) must leave
   last-known unchanged so the next equal line re-attempts rather than
   dedups against a never-folded tuple.
5. **Docs in the same commit:** revise README.md zellij `## Architecture`
   prose (~1756-1763, "mints one per joined line" → "...whose effective
   (tab_id,tab_name) differs from the job's projection") and the
   trace-zellij loop-signature guidance (~473-486); add a
   `Mint-seam dedup:` bold-label paragraph to the `scanZellijEventsDir`
   JSDoc; update `readLiveJobsWithCoords` JSDoc + `LiveJobRow`; revise the
   `src/zellij-events.ts` module JSDoc watermark/idempotency sentence
   (~32-41) to say "fewer no-op mints reach the reducer" — NOT "idempotency
   now lives at the consumer" (the fold stays idempotent; this is an
   optimization, not a replacement). Fix the stale `daemon.ts:~1914`
   cross-ref in the mint comment (now the DispatchCleared handler; the scan
   loop is the SOLE BackendExecSnapshot mint site).

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:779-795 — `liveJobs` map build (type annotation at 779)
- src/daemon.ts:1003-1085 — mint loop + the two precedent skip gates + the INSERT + the TRACE_ZELLIJ tick / catch placement
- src/backend-worker.ts:50-81 — `LiveJobRow` + `readLiveJobsWithCoords`
- src/reducer.ts:3795-3813 — `foldBackendExecSnapshot` COALESCE/hard-assign asymmetry (the compare must mirror this)
- src/zellij-events.ts:98-176 — `parseZellijEventLine` (tab_id String-coercion, tab_name never-null/""-filtered)
- test/zellij-events-worker.test.ts — harness (`seedJob` 70-86, `readBackendExecEvents` 94-107) + must-not-regress mint-count tests at ~120/197/259/440/727

**Optional** (reference as needed):
- README.md ~1740-1795 and ~464-492 — the prose to revise

### Risks

- **False-suppression via wrong predicate** — the single biggest risk. A
  name-only or raw-tab_id compare drops real tab_name changes that ride a
  null tab_id. Mitigated by the effective-tuple predicate + a dedicated
  test (tab_id=null + changed tab_name must mint).
- **Type mismatch `3` vs `"3"`** — under-dedups (harmless) or phantom-mints
  (wasteful). Mitigated by `String(... ?? "")` on both sides.
- **Fold-lag under-dedup (accepted)** — per-scan-rebuild seeds from the
  projection, which can lag a tight cross-scan burst, so some boundary-
  straddling dupes re-mint. This is a throughput nit, NEVER a correctness
  bug (no false-suppress, no wedge); the dominant in-scan dupe case is
  caught by the mutated map independent of the fold. Persistent
  boot-seeded cache is the follow-up if telemetry shows it matters.
- **Must-not-regress audit** — confirm each existing mint-count test's
  expected mints carry genuinely distinct `(tab_id, tab_name)` tuples; line
  ~440 (10 identical pads, asserts `>=1`) now collapses to ~1 via in-scan
  dedup — the loose assert survives but verify the asserted latest title.
  If any test relied on duplicate lines minting twice, update that assert
  to the new dedup contract (and say so).

### Test notes

The harness drives `scanZellijEventsDir` directly with NO reducer and NO
drain, so a mint in scan N does NOT update the `jobs` projection. Coverage
plan:
- **In-scan dedup:** one scan with a run of identical lines for one
  `(session,pane)` → assert `readBackendExecEvents(db).count` mints only on
  the first.
- **A→B→A flap (one scan):** asserts exactly 3 mints — proves the in-scan
  last-known update on real transitions.
- **Cross-scan projection-seeded skip:** add a `seedJob` tab-state variant
  that seeds `backend_exec_tab_id/_name`; a line equal to the seed mints 0,
  a differing line mints 1.
- **COALESCE/null-tab_id:** a line `{tab_id:null, tab_name:"changed"}`
  against a seed with a non-null tab_id + different name → mints 1 (NOT
  suppressed); a line `{tab_id:null, tab_name:<same>}` → mints 0.
- **Mint-then-fold-then-seed loop (recommended, at least once):** drive
  `foldBackendExecSnapshot`/a manual drain between two scans so the
  realistic cross-scan loop (mint → fold → seed next scan → skip) is proven
  end-to-end, not just via the hand-seeded proxy.
- Optionally add a `TRACE_ZELLIJ`-style counter for SKIPPED lines so the
  realized dedup rate is measurable post-ship against the predicted 53.6%
  (defer if it bloats the diff).

## Acceptance

- [ ] `readLiveJobsWithCoords` SELECT + `LiveJobRow` carry `backend_exec_tab_id`/`backend_exec_tab_name` (string|null); `liveJobs` map value is `{job_id, tabId, tabName}` and the line-779 type annotation is updated
- [ ] Dedup gate sits after the empty-name + no-live-job skips, before the INSERT; predicate is the effective-tuple AND-compare mirroring the fold's COALESCE/hard-assign asymmetry
- [ ] In-scan last-known updates only inside the `try` after a successful `insertEvent.run()`; a failed INSERT leaves it unchanged
- [ ] NULL seeded tab_name treated as "no last-known" (first mint allowed)
- [ ] Tests: in-scan dedup (0 re-mints), cross-scan projection-seeded skip, A→B→A flap = 3 mints, null-tab_id + changed name = 1 mint, and at least one mint→fold→seed end-to-end loop test
- [ ] All pre-existing mint-count tests pass (or are updated with a stated rationale where the dedup changes intended counts)
- [ ] Docs/JSDoc revised in the same commit (README prose + trace guidance, scanZellijEventsDir JSDoc, readLiveJobsWithCoords/LiveJobRow JSDoc, zellij-events.ts module JSDoc, stale ~1914 cross-ref fixed)
- [ ] No SCHEMA_VERSION bump and no keeper/api.py change (schema-neutral confirmed)

## Done summary

## Evidence
