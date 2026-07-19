## Description

**Size:** M
**Files:** src/daemon.ts, src/db.ts, src/reducer.ts, test/reducer-projections.test.ts, test/refold-equivalence.test.ts, test/db.test.ts

### Approach

Reproduce the wipe first, then fix the exact write. The durable `autopilot_state.fable_focus` column is nulled on keeperd boot with no clearing event — a deterministic-replayed projection column mutated outside a fold. Static tracing (operator + repo-scout) found the production fold + RPC writers clean and re-fold-safe; the only full-row rewrite is the v129 migration rebuild (`src/db.ts:4344-4368`, explicit 13-column copy-list omitting `fable_focus`), guarded on a `codex_adoption` column that the live repro DB does NOT have — so v129 does not fire, and the cursor resumes (no re-fold from 0). The exact runtime writer is therefore not statically pinnable and must be instrumented on a live boot: dump the repro DB's `autopilot_state` shape and cursor, confirm the `AutopilotConfigSet{fable_focus}` event is present and re-normalizes idempotently, and trace what actually touches the row between `serveBootDrain()` and `publishFableFocusProjection` (`src/daemon.ts:9741-9751`). Once pinned, correct it so column mutations stay fold-sourced (or a necessary rewrite preserves unowned columns via column-scoped UPDATE/UPSERT, never full-row REPLACE). Add the forward guard the scouts recommend: assert every column in `CREATE_AUTOPILOT_STATE` appears in every rebuild copy-list.

### Investigation targets

*Verify before relying — planner-verified at authoring time against the live repro, but the repo moves.*

**Required** (read before coding):
- `src/daemon.ts:8051-8075` — `publishFableFocusProjection`: reads `SELECT fable_focus` then writes the leaf; if the column is already NULL here, it was nulled upstream (matches the repro's leaf symptom).
- `src/daemon.ts:9741-9751` — boot call site: `serveBootDrain()` then `publishFableFocusProjection`. Instrument the row state on both sides.
- `src/daemon.ts:9992-9999` — boot autopilot re-arm (`SELECT paused` only today — confirm it stays read-only under the fix).
- `src/reducer.ts:6785-6794` — `AUTOPILOT_CONFIG_COLUMNS` allowlist (single source of truth; includes `fable_focus`).
- `src/reducer.ts:6990-7032` — `foldAutopilotConfigSet`: dynamic partial-patch UPSERT that preserves unpatched columns (the correct pattern to preserve/extend).
- `src/db.ts:4344-4368` — v129 rebuild: explicit copy-list omitting `fable_focus`, guarded on `codex_adoption`. The forward-guard target.
- `src/db.ts:7403-7404` — `migrate()` runs every `SCHEMA_STEPS.apply()` on every boot (each guarded); confirm no shape-guarded step unexpectedly fires on the repro DB.

**Optional** (reference as needed):
- `src/autopilot-projection.ts:109-121` — `projectFableFocus` pure coercion (reuse for read-back assertions).
- `src/fable-focus.ts` — `materializeFableFocusPolicy` (:148), `serializeFableFocusPolicy` (:219), `normalizeFableFocusInput` (:94); fold double-normalizes (reducer.ts:6958) — verify idempotency on the stored wire shape.

### Risks

- The root cause is DB-state-dependent and not statically pinned — the task MUST reproduce with live instrumentation before theorizing a fix; a fix shipped against the wrong hypothesis passes tests but not the operator post-deploy proof.
- If the cause is fold-side (an `AutopilotConfigSet{fable_focus}` that fails re-normalization → no-op on a fresh-INSERT row leaving the column at its NULL default), the fix is fold correctness, not a boot-write guard — the pure re-fold seam reproduces it. If the cause is a non-fold boot write, the pure seam may NOT reproduce it and live instrumentation is the only path — spec both branches.

### Test notes

- Seed a populated `fable_focus` policy whose value differs from BOTH the column default AND NULL, then drive the pure boot-cycle seam (reopen: `test/db.test.ts:905-915`; or re-fold: `test/refold-equivalence.test.ts:842-853`, `test/reducer-projections.test.ts:5510-5515`) and assert the column AND the leaf survive. The existing fable-focus fold test (`test/reducer-projections.test.ts:5468-5516`) captures its `before` snapshot AT NULL — it does not cover a populated survival, which is the gap to close.
- Charter-style guard test: introspect `autopilot_state` columns and assert every rebuild copy-list is a superset — deterministic, in-process, `sandboxEnv`/`freshDbFile`, no real daemon (docs/testing.md).

## Acceptance

- [ ] A red regression test reproduces the populated-policy wipe through a pure seam (or, if boot-path-only, a documented live-instrumentation repro pins the exact writer) before the fix lands.
- [ ] The identified write is corrected so `autopilot_state.fable_focus` (and every sibling column) survives a boot cycle; the regression test is green.
- [ ] `autopilot_state` column mutations remain fold-sourced, or any necessary rewrite preserves every column it does not explicitly own (column-scoped, never full-row REPLACE).
- [ ] A guard test fails if any `autopilot_state` rebuild copy-list omits a schema column.
- [ ] The named gates are green: `bun test ./test/reducer-projections.test.ts ./test/refold-equivalence.test.ts ./test/db.test.ts` + `bun run typecheck`.

## Done summary
Fixed the boot-cycle wipe of autopilot_state.fable_focus: the codex_adoption column was re-added by an older additive migration step and immediately dropped again by the v129 rebuild every boot (all SCHEMA_STEPS run every boot), and the v129 copy-list omitted fable_focus, silently nulling it each cycle. Made the rebuild copy-list an exhaustive, presence-filtered superset of the current schema (including fable_focus), added a regression test proving a populated policy survives an openDb reopen boot cycle (column + published leaf), and added a forward guard test asserting every autopilot_state rebuild copy-list covers every current schema column.
## Evidence
