## Description

**Size:** M
**Files:** src/plan-worker.ts, src/rpc-handlers.ts, test/plan-classifier.test.ts, test/plan-worker.test.ts, CLAUDE.md, README.md

**EXPAND READER (Phase 1) — lands FIRST (deps: none).** Teach keeper to fold
`approval` from the gitignored sidecars with a PERMANENT resolution ladder
(sidecar → committed def → pending). No sidecars yet → falls through to def
→ behavior unchanged → safe to deploy before planctl changes.

### Approach

- **classifyPlanPath:** add `epic-state` kind for
  `.planctl/state/epics/<id>.state.json` (mirror the 4-segment `task-state`
  arm); add epic id/def-path helpers.
- **Fold arms + ladder:** epic-approval + task-approval caches; `task-state`
  arm caches approval; new `epic-state` arm caches approval +
  `reemitEpicFromDef` (fn-629 in-HEAD gate STILL applies to the DEF read).
  `buildTaskMessage`/`buildEpicMessage` source approval from cache,
  **def-fallback on cache miss**, default pending — PRESERVE object-literal
  key order (re-fold byte compare). Route via `coerceApproval` (never throw).
- **Boot-prime (scanPlanctlDir):** prime both caches BEFORE def enumeration
  (Pass-1/1b before Pass-2); caches write-only in Pass-1/1b (re-fold determinism).
- **RPC retarget (rpc-handlers.ts):** `set_task_approval`/`set_epic_approval`
  write the sidecar (create-if-absent; task RMW preserves status;
  traversal-guarded). KEEP the approval kick for now (removed in `.4`).
- **DEPLOY:** restart keeperd and CONFIRM the fold arm is live (daemon picks
  up code only on restart) — acceptance gate.

### Investigation targets

**Required** (read before coding):
- src/plan-worker.ts:472-504 classifyPlanPath; :1290-1317 task-state arm (template); :1153-1215 reemitTaskFromDef; :1676-1749 buildEpic/TaskMessage (key order); :2097-2214 scanPlanctlDir boot-prime
- src/reducer.ts:802-826,:977,:1014 — confirm approval fold is source-agnostic (folds snapshot.approval from the event)
- src/rpc-handlers.ts:292-360 — approval handlers to retarget

### Risks

- Object-literal key-order drift → re-emit storm / re-fold diff. Keep approval in the identical slot.
- Boot-prime ordering wrong → first snapshot resets approval to pending.
- The def-fallback is PERMANENT and load-bearing — do not gate it away.

### Test notes

bun test: classifyPlanPath→epic-state; epic-state arm folds gate-free; task
approval from sidecar; **def-fallback on cache miss**; boot-prime order;
malformed sidecar coerces to pending; re-fold byte-identity. Sandbox all five state paths.

## Acceptance

- [ ] keeper folds approval from sidecar gate-free AND falls back to committed def on cache miss (PERMANENT ladder)
- [ ] RPC approval handlers write the sidecar (create-if-absent, RMW preserves status, traversal-guarded)
- [ ] boot-prime primes caches before def enumeration; re-fold byte-identical (key order)
- [ ] keeperd restarted and fold arm confirmed live
- [ ] bun test green incl. fallback + boot-prime + malformed-sidecar cases

## Done summary
Keeper expand-reader: folds approval from gitignored runtime sidecars (.planctl/state/{epics,tasks}/<id>.state.json) GATE-FREE via a PERMANENT ladder (sidecar -> committed def -> pending). classifyPlanPath gains epic-state; PlanScanner caches epic/task approval and re-emits the def-composed snapshot (fn-629 gate stays on the DEF read); buildEpic/TaskMessage thread an approvalOverride with def-fallback preserving key order for re-fold byte-identity; boot-prime seeds both caches before def enumeration. set_{task,epic}_approval RPC retargeted to write the sidecar (create-if-absent, task RMW preserves status, traversal-guarded), committed def untouched. keeperd restarted (pid 35546) on committed c1c3fc4, fold arm confirmed live. bun test green (197 keeper unit + e2e approval integration).
## Evidence
