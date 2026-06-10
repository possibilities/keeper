## Description

**Size:** M
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts, CLAUDE.md, README.md, docs/exec-backend.md

### Approach

Make the close-row completion reap reachable while staying level-triggered:
loadReconcileSnapshot (src/autopilot-worker.ts:1771-1841) gains a SECOND epics
read with an explicit wire filter — `filter: {status: "done"}`, sorted
updated_at DESC, limit ~32 — merged (dedup by epic_id, open rows win) into
snapshot.epics. An explicit filter drops the descriptor defaultClause
(server-worker resolveFilter gate; status is an allowlisted filter key in
EPICS_DESCRIPTOR src/collections.ts:313-317). Verify updated_at is an allowlisted
sort column for epics; if not, add it to the descriptor's sort allowlist
(read-surface-only change, no schema bump). The bound keeps the snapshot
O(limit), never O(890 done epics) — the fn-748 anti-pattern. The limit must
comfortably exceed fold-lag + reconcile cadence so a done epic is observed at
least once post-flip; reapSurfaces is already idempotent, so repeated observation
within the window is safe.

Semantics guard: done epics entering the snapshot must produce ONLY completed
verdicts — evaluateCloseRow's status==="done" arm (src/readiness.ts:1033, file
stays read-only) and completed tasks — feeding completedRowIds (autopilot-worker
:1155-1165) and the reap (:2299-2307, isCompletionReapCandidate :543 with its
exited===false live-veto). Pin with a test that a snapshot containing done epics
yields zero dispatches and no mutex occupancy. If any dispatch verdict perturbs:
FALLBACK — a dedicated reap-only done-epics read consumed solely by the
completedRowIds derivation, never by reconcile's dispatch arms.

The honest test: drive the REAL query path against a seeded sandbox DB (the
test/collections.test.ts shape — openDb + INSERT INTO epics + runQuery from
../src/server-worker): seed a status='done' epic (+ its close-verb job row),
build the snapshot via the real loadReconcileSnapshot (export it for tests — it
is currently private at :1832 — or drive through runReconcileCycle with fake
deps), assert the epic's id lands in completedRowIds and the reap candidate set.
Update the stale doc comment at :1814-1818 ("NO wire filter, so each descriptor's
DEFAULT scope applies") which currently encodes the bug as intended.

Docs in the same commit: CLAUDE.md completion-reap paragraph (~270-279) — drop
the stale approve::<id> pair mention (fn-756), note the done-epics window; README
completion-reap paragraph (~2092-2107) likewise; docs/exec-backend.md (~192-238)
remove approve::<id> reap references and the "pair" framing.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:1771-1841 — loadReconcileSnapshot + the :1814-1818 doc comment; :1155-1165 completedRowIds; :2299-2307 + :543 reap path; :2234-2243 pause-reap (UNCHANGED — reads pending_dispatches directly)
- src/server-worker.ts:929-1008 — resolveFilter (explicit filter drops defaultClause; :1006 gate); sort allowlist handling (~:1082-1091)
- src/collections.ts:227-341 — EPICS_DESCRIPTOR filters/defaultClause/sort
- src/readiness.ts:1033 — evaluateCloseRow done arm (read-only)
- test/collections.test.ts:34-196 — real-DB runQuery test shape; test/autopilot-worker.test.ts:2241-2258, 2385-2399 — the hand-rolled snapshots that masked this

### Risks

- Done epics in the snapshot perturbing dispatch/mutex arms — pinned by the
  zero-dispatch test; fallback path named above.
- Unbounded done read = fn-748 class; the sort+limit bound is load-bearing.

### Test notes

(a) real-path test above; (b) zero-dispatch/no-occupancy pin with done epics
present; (c) existing fn-727 hand-rolled tests stay green; (d) bound test: with
>limit done epics seeded, snapshot carries exactly limit and the most recently
updated ones.

## Acceptance

- [ ] a seeded done epic's close row reaches completedRowIds through the REAL loadReconcileSnapshot path (no hand-rolled snapshot)
- [ ] done-epics read is bounded (sort updated_at desc + limit); done epics yield only completed verdicts (zero dispatches — test-pinned)
- [ ] :1814-1818 comment + CLAUDE.md/README/exec-backend.md reap prose corrected (approve:: references gone)
- [ ] full bun test green; readiness.ts untouched; no schema bump

## Done summary
loadReconcileSnapshot merges a bounded done-epics window (filter:{status:done}, updated_at DESC, limit 32) into the snapshot so the fn-727 close-row completion reap is reachable post-fn-756; real-DB tests prove a done epic reaches completedRowIds with zero dispatches and the read stays O(limit). Stale approve::<id> reap prose corrected in CLAUDE.md/README/exec-backend.md. No schema bump.
## Evidence
