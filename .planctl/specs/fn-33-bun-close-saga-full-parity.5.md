## Description

**Size:** M
**Files:** src/verbs/epic_close.ts, src/verbs/close_preflight.ts, src/verbs/close_finalize.ts (all new), src/verbs/scaffold.ts (created_by_close_of stamping), src/cli.ts, test/ additions

### Approach

The saga. epic close: the wave's only committing verb — status/updated_at/closer_done_at/close_reason stamps, plain emit_error wording exact, --force, restamp non-member, `chore(planctl): close <epic>` subject. close-preflight: tasks-all-done gate (TASKS_NOT_DONE with the typed set), commit-set assembly via commit_lookup (COMMIT_LOOKUP_FAILED), brief.json artifact via the spine writer, close session marker (fail-open), success envelope with commit_set_hash. close-finalize: position derived from observable state only; idempotent already-done re-run returns the prior outcome; verdict read or synthesized-empty when findings==0; fresh commit_set_hash check → STALE_ARTIFACTS; fatal_halt; closed_clean via in-process epic-close call; survivors → follow-up adoption by created_by_close_of provenance, completeness check (distinct non-null kept/merged ordinals vs follow-up task count) → partial_followup, or in-process scaffold call with the created_by_close_of internal arg (bun scaffold gains the stamp — no CLI flag) parsing the minted epic_id from the captured output while skipping the invocation line, then close → closed_with_followup; the CloseOutcome string enum exact; close marker cleared at the single outcome chokepoint; reversible checks strictly before the irreversible close. In-process delegation calls bun's own ported functions with captured stdout — never a subprocess of itself.

### Investigation targets

**Required** (read before coding):
- planctl/run_close_finalize.py — the saga source, phase by phase
- planctl/run_epic_close.py and run_close_preflight.py — the bookend verbs
- tests/test_close_finalize.py and test_close_preflight.py — the pins incl. outcome exhaustiveness and the followup-of-is-gone assertion
- src/verbs/scaffold.ts — where the provenance stamp lands

### Risks

The irreversible-step-last ordering and idempotent re-entry are the saga's whole safety story — any write reordering breaks crash-recoverability parity. The in-process delegation must capture output without leaking it to the real stdout mid-saga.

### Test notes

test_close_finalize.py + test_close_preflight.py + test_epic_close coverage green via dist/planctl-bun (--run-slow for real_git portions).

## Acceptance

- [ ] All saga outcomes reproduced exactly; idempotent re-run; STALE_ARTIFACTS and synthesis paths green
- [ ] created_by_close_of stamped through bun scaffold; followup adoption and completeness check exact
- [ ] epic followup-of remains nonexistent (conformance test green)

## Done summary
Ported the close saga to full bun CLI parity: epic close / close-preflight / close-finalize + gist verbs, scaffold's created_by_close_of provenance stamp, leaf --help + unknown-option rejection in the subgroup dispatch. Full-suite conformance (PLANCTL_BIN bun, --run-slow) is green: 888 passed, 31 skipped, all skips python_only. Docs collapsed to full-parity statements.
## Evidence
