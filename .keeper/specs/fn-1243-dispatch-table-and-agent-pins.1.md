## Description

**Size:** M
**Files:** src/agent/config.ts, src/dispatch-launch-config.ts, test/agent-config.test.ts, test/dispatch-launch-config.test.ts

### Approach

`presets.yaml` gains a nested `dispatch:` mapping — keys `work`, `close`, `resolve`, `unblock`, `deconflict`, `repair`, `handoff`, each value a launch triple parsed with the existing machine-triple parse (harness-unchecked, harness carried through). Strict unknown-key rejection inside the block via the same reject-unknown-keys discipline as the catalog. This task is ADDITIVE: the `worker`/`escalation` keys keep parsing unchanged (task 2 performs the cutover and adds the migration-hint rejection). New dep-free leaf module `src/dispatch-launch-config.ts` exports `resolveDispatchLaunchConfig(verb)`: loads the catalog fresh per call; swallows any ConfigError to a compile-time-total `Record<DispatchVerb, floor>` — work/close/resolve floor to the worker constants, unblock/deconflict/repair to the escalation constants, handoff floors to absent (no flags → harness default); returns a shared `{harness?, model?, effort?}` type; `approve` resolves through the `work` row. Non-claude harness in a triple: warn-once keyed (verb, harness) via an injectable memo, still resolve claude behavior (drop model/effort to floor exactly as the twins do today). Missing row vs malformed catalog both floor, logged distinctly. Whole-file semantics: one malformed entry floors every verb (human-confirmed; no per-verb salvage). Imports stay in the config island: node:* + agent/config + reconcile-core constants, never db.ts.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves (fn-1237 merged mid-planning; fn-1240/fn-1241 land before this dispatches).*

**Required** (read before coding):
- src/agent/config.ts:378-385 — ALLOWED_CATALOG_KEYS strict-reject set to extend with `dispatch`
- src/agent/config.ts:421-428 — the retired-`presets:` fail-loud migration-hint pattern (task 2 clones it; understand it now so the parse composes)
- src/agent/config.ts:496 — parseMachineTriple, the harness-unchecked triple parse to reuse per verb value
- src/escalation-config.ts:9-13 — the leaf-module rationale the new module inherits (daemon + CLI import it without the autopilot-worker graph)
- src/autopilot-worker.ts:431-471 — resolveWorkerLaunchConfig's swallow-to-floor + injectable warn-once Set, the posture to preserve
**Optional** (reference as needed):
- src/dispatch-command.ts:50-77 — the verb unions (EscalationVerb; DispatchableVerb includes approve)
- src/reconcile-core.ts:277-290 — the four floor constants (unchanged, imported)

### Risks

- The optional-field return shape (handoff) ripples into every consumer signature — export ONE shared type from the leaf module so task 2 consumes it unchanged.
- Keep the twins compiling: this task must not remove the catalog's worker/escalation fields.

### Test notes

Unit-test the resolver floors per verb (absent file, malformed file, absent row, non-claude harness, approve→work), the warn-once memo key, and the dispatch-block parse (valid table, unknown verb key, malformed triple value). Sandbox via KEEPER_CONFIG_DIR fixtures; never read the live ~/.config.

## Acceptance

- [ ] A `dispatch:` table in presets.yaml parses with strict unknown-key rejection and per-value triple validation; existing worker/escalation keys still parse unchanged
- [ ] resolveDispatchLaunchConfig returns the configured triple's fields per verb, floors to the correct per-verb-class constants on absent row / absent file / malformed file, and returns all-absent for an unpinned handoff
- [ ] approve resolves identically to work; a non-claude triple warns once per (verb, harness) and resolves floor behavior
- [ ] The new module imports only within the config island (no db.ts, no autopilot-worker graph)

## Done summary

## Evidence
