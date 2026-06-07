## Description

**Size:** M
**Files:** src/plan-worker.ts, test/plan-classifier.test.ts, test/plan-worker.test.ts, CLAUDE.md, README.md

Teach keeper's plan-worker to fold `approval` from the gitignored sidecars
(gate-free), symmetric across tasks and epics, per the epic's Sidecar
contract.

### Approach

- **Classify (`classifyPlanPath`):** add an `"epic-state"` kind for the
  4-segment tail `.planctl/state/epics/<id>.state.json` (mirror the
  existing `task-state` 4-segment arm). Add `epicIdFromStatePath` /
  `epicDefPathFromStatePath`.
- **Cache + arms:** add `RawEpicState { approval? }`; add an
  `epicApprovalCache` and a task-approval cache. Extend the `task-state`
  `onChange` arm to cache `approval` (alongside status); add a new
  `epic-state` arm → cache approval + `reemitEpicFromDef` (a near-clone of
  `reemitTaskFromDef`; the fn-629 in-HEAD gate STILL applies to the DEF
  read — correct, do not bypass it).
- **Message build:** `buildTaskMessage` / `buildEpicMessage` source
  `approval` from the cache (NOT `raw.approval`), with a def-fallback when
  the cache has no entry for that id (read `raw.approval`), default
  `pending`. PRESERVE the exact object-literal key order (change-gate is a
  byte compare; re-fold determinism depends on it). Route every approval
  read through `coerceApproval` (never throw on malformed sidecar).
- **Boot prime (`scanPlanctlDir`):** Pass-1 (state/tasks) must ALSO prime
  the task-approval cache; add a Pass-1b enumerating `state/epics/` to
  prime the epic-approval cache, ordered BEFORE Pass-2 reads `epics/` —
  else the first boot snapshot emits stale `pending`. Emission stays
  exclusively in the sorted Pass-2 def enumeration (caches are write-only
  in Pass-1/1b), preserving re-fold determinism.
- **Reducer:** confirm `src/reducer.ts` needs NO change (it folds
  `snapshot.approval` from the event blob). Add a regression test if
  helpful but do not alter the fold.
- **Docs:** keeper `CLAUDE.md` — change "Plans are READ-ONLY except
  `approval`" → "Plans are READ-ONLY" (approval folded from gitignored
  sidecars); fix the "Writes are tightly scoped" item (1) and the
  Sole-writer approval carve-out. `README.md` — RPC description + the
  fn-629 plan-worker prose (approval no longer rides the def-file
  commit/in-HEAD path).

### Investigation targets

**Required:**
- src/plan-worker.ts:472-504 — `classifyPlanPath` (add epic-state kind)
- src/plan-worker.ts:1290-1317 — the `task-state` onChange arm (the template)
- src/plan-worker.ts:1153-1215 — `reemitTaskFromDef` (mirror for epics; note the :1198-1205 in-HEAD gate stays)
- src/plan-worker.ts:1676-1749 — `buildEpicMessage` / `buildTaskMessage` (approval source + key-order comment ~:1717)
- src/plan-worker.ts:2097-2214 — `scanPlanctlDir` boot-prime ordering (Pass-1 then Pass-2)
- src/reducer.ts:802-826, :977, :1014 — confirm approval fold is source-agnostic

**Optional:**
- test/plan-classifier.test.ts, test/plan-worker.test.ts — test homes; helpers are exported "for unit reach"

### Risks

- Object-literal key-order drift → every epic/task re-emits on each boot
  (silent until a re-fold diff). Keep `approval` in the identical slot.
- Boot-prime ordering wrong → first boot snapshot resets approval to
  pending. Pass-1/1b strictly before Pass-2.
- The def-fallback must apply ONLY on a cache miss; once a sidecar exists
  the cache wins (so a stale def value can't clobber the sidecar value).

### Test notes

bun test: `classifyPlanPath` returns `epic-state` for the new path;
epic-state arm folds approval gate-free (no commit needed); task approval
sourced from sidecar; def-fallback on cache miss; boot-prime order
(epic sidecar primed before epic def read); malformed sidecar coerces to
pending without throwing; re-fold byte-identity (key order). Sandbox all
five state paths per CLAUDE.md test-isolation.

## Acceptance

- [ ] `classifyPlanPath` recognizes `.planctl/state/epics/<id>.state.json` as `epic-state`; new arm folds epic approval gate-free.
- [ ] Task + epic `approval` source from the sidecar cache (def-fallback on cache miss); never throws on malformed sidecar.
- [ ] Boot-prime primes both caches before def enumeration; re-fold reproduces byte-identical rows (key order preserved).
- [ ] reducer.ts unchanged; keeper docs updated.
- [ ] bun test green incl. new epic-state + boot-prime + def-fallback cases.

## Done summary

## Evidence
