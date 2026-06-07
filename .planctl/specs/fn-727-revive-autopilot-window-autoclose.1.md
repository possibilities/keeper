## Description

**Size:** M
**Files:** src/db.ts, src/daemon.ts, src/autopilot-worker.ts, test/autopilot-worker.test.ts, README.md, CLAUDE.md, docs/exec-backend.md

### Approach

Revive completion-reap on the surviving live-probe path. Four code moves
plus tests and docs, all one cohesive slice:

1. **Consume the config flag.** `autoclose_windows` is parsed in
   `src/db.ts` (default `true`) but read nowhere. Thread it to the
   autopilot worker the way `zellijSession` / `maxConcurrentJobs` are:
   add `autocloseWindows` to `AutopilotWorkerData`, pass
   `resolveConfig().autocloseWindows` from `daemon.ts` at worker spawn,
   and expose it on the worker like `paused`/`pollMs` so hermetic tests
   can override it. Restart-to-apply contract (config flips need a
   daemon restart) — same as every keeper config key.

2. **Surface the completed-row-id set out of `reconcile`.** `reconcile`
   currently returns `ReconcileDecision { launches }` only, but it
   already computes `computeReadiness` internally. Widen
   `ReconcileDecision` to also carry the set of row ids whose verdict is
   `{tag:"completed"}` this cycle (from `readiness.perTask` and
   `readiness.perCloseRow`). Do NOT re-run `computeReadiness` a second
   time in `driveCycle` — reuse the one pass reconcile already makes
   (single source of truth, no double cost).

3. **New sibling reap predicate.** Add a pure predicate distinct from
   `isReapCandidate` (do NOT overload it — `isReapCandidate` gates on
   the open-`pending_dispatches` intersect for the pause path, the
   OPPOSITE gate). The new predicate accepts a pane iff
   `dispatchKeyForPane(pane)` resolves to `{work|close|approve}::<id>`
   where `<id>` is in the completed-row-id set. The verdict is the sole
   authorization; `is_exited` is intentionally NOT checked (see Risks).
   Export it for the test suite, mirroring the `isReapCandidate`
   export. Reuse `dispatchKey` for key composition.

4. **Reap pass in the reconcile cycle.** Fire a completion-reap per
   cycle inside/after `driveCycle` (the trigger is recomputed every
   cycle), structurally mirroring `reapLaunchWindowSurfaces`
   (autopilot-worker.ts:1705-1743): early-return (skip the `list-panes`
   spawn) when `autocloseWindows` is false OR the completed set is
   empty; else call `backend.reapSurfaces(predicate)` with the new
   predicate; log `examined/reaped/failed`; wrap the whole body in
   try/catch so it never propagates. Reuse `reapSurfaces` as-is — no
   changes to the exec-backend close plumbing.

5. **Docs.** Apply the four doc edits from the epic `## Docs gaps`.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:333-340 — `isReapCandidate`: the pure-predicate shape to MIRROR (not overload) for the new completion predicate.
- src/autopilot-worker.ts:1705-1743 — `reapLaunchWindowSurfaces`: the canonical never-throw reap wiring (early-return-empty, `reapSurfaces` call, log shape) to template the completion-reap pass.
- src/autopilot-worker.ts:1753-1789 — `driveCycle`: where per-cycle work runs; where the reap pass hooks in.
- src/autopilot-worker.ts:459-461 — `ReconcileDecision` (launches only today); the shape to widen with the completed-row-id set.
- src/autopilot-worker.ts:813-847 — `reconcile` walking `readiness.perTask`/`perCloseRow`; the lookup pattern + where to harvest the completed set.
- src/readiness.ts:757 — `perTask` `{tag:"completed"}` emit; the trigger. `perCloseRow` completed path (`evaluateCloseRow`) likewise.
- src/exec-backend.ts:1096-1149 — `reapSurfaces(predicate)`: reuse as-is. Note `collectPanesFromListJson` reads `exited` (not `is_exited`).
- src/exec-backend.ts:693-706 — `dispatchKeyForPane`: name-only lift of `{work|approve|close}::<id>`.
- src/db.ts (autoclose_windows parse + DEFAULT_AUTOCLOSE_WINDOWS) — the flag to consume.

**Optional** (reference as needed):
- daemon.ts autopilot-worker spawn (threads `zellijSession`/`maxConcurrentJobs` via workerData) — the precedent for threading `autocloseWindows`.
- src/autopilot-worker.ts:1205 — `AutopilotWorkerData` (add the flag here).
- test/exec-backend.test.ts:1443-1588 — `reapSurfaces` test pattern (`makeReapSpawnStub`) if a backend-level test is wanted.
- Blueprint commit `4860ab4` — approved-complete GATING semantics to adapt (NOT its torn-out close mechanism).

### Risks

- **Killing a live pane via lagging `list-panes`.** Mitigated by design: the durable `{tag:"completed"}` verdict authorizes the reap; an `approve::<id>` surface implies a completed corresponding job (human's design call). A completed+approved row cannot have a concurrent live worker for the same id — a re-dispatch flips the row off `completed`. `is_exited` is therefore deliberately NOT gated (it would never reap the live approver anyway). Document this divergence inline so a future reader doesn't "fix" it back to the practice-scout default.
- **Double readiness pass.** Avoid by widening `ReconcileDecision` rather than recomputing in `driveCycle`.
- **Overloading `isReapCandidate`** would conflate the pause gate (pending-open) with the completion gate (approved-completed) — keep them separate predicates.
- **Restart-to-apply** — a config flip silently lags until daemon restart; documented, matches every keeper key.

### Test notes

- Mirror the `isReapCandidate` pure-predicate block (test/autopilot-worker.test.ts:1530-1607): completed id → matches `work::`/`close::`/`approve::`; non-completed id → no match; human ad-hoc tab (no dispatch key) → never matched; empty completed set → no match.
- Reap-pass behavior: reaps the pair on approval; leaves pending/rejected/worker-ended-unapproved open; `autocloseWindows:false` → no-op AND no `list-panes` spawn; empty completed set → early-return; predicate/probe throw → swallowed.
- If fn-722.2's `test/helpers/sandbox-env.ts` has landed, import it; else follow the existing sandbox pattern (all five KEEPER_* state paths under tmpdir per CLAUDE.md test-isolation rule).

## Acceptance

- [ ] `autocloseWindows` is threaded db.ts → daemon.ts workerData → autopilot worker, and overridable for hermetic tests
- [ ] `ReconcileDecision` carries the completed-row-id set; no second `computeReadiness` pass added to `driveCycle`
- [ ] New pure reap predicate (exported, separate from `isReapCandidate`) matches `{work|close|approve}::<id>` for completed ids only
- [ ] Completion-reap pass mirrors `reapLaunchWindowSurfaces`: early-returns when flag off or completed set empty, calls `reapSurfaces`, logs examined/reaped/failed, never throws
- [ ] Approving a completed task reaps `work::<id>` + `approve::<id>`; approving a completed close-row reaps `close::<id>` + `approve::<id>`
- [ ] Pending / rejected / worker-ended-unapproved surfaces are NOT reaped
- [ ] `autoclose_windows: false` → no-op, no `list-panes` spawn
- [ ] Reap keys off the live-probe path (survives daemon restart; no reliance on cold-boot `liveDispatches`)
- [ ] Tests cover predicate + reap-pass behavior incl. the never-throw and flag-off paths
- [ ] README + CLAUDE.md + docs/exec-backend.md updated per the epic Docs gaps

## Done summary

## Evidence
