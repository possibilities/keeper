## Description

**Size:** M
**Files:** scripts/migrate_approval_to_sidecar.py, planctl/run_approve.py, planctl/models.py, planctl/CLAUDE.md, planctl/README.md, planctl/docs/reference/commit-at-mutation-boundary.md, tests/test_migrate_approval_to_sidecar.py, tests/test_run_approve.py

**BACKFILL + CONTRACT (Phase 3) — deps: `.1`. The only irreversible step, LAST.**
Idempotent backfill seeds sidecars; THEN, gated on a positive end-to-end
verify, planctl stops writing/committing def approval and strips it.

### Approach

- **Backfill (idempotent):** mirror `scripts/migrate_acks_to_state.py` —
  enumerate roots, glob `.planctl/` projects, seed each def `approval` into
  the sidecar via the `.1` store API. `--dry-run`. Safe to re-run. SEED ONLY
  here; do NOT strip yet.
- **VERIFY GATE (before contract):** confirm keeper folds approval from the
  sidecar end-to-end — approve a done task, confirm the projection flips
  `approval=approved` within ~1s via the sidecar path (keeper `.3` deployed +
  restarted). Run during a quiesced / no-epic-in-flight window.
- **Contract (only after verify):** reclassify approve as runtime-state-only
  (stop writing/committing def `approval`, mirror claim/block); run the
  backfill's STRIP pass (pop `approval` from def files). Update docs
  (commit-at-mutation-boundary: approve → runtime-state-only no-commit row).

### Investigation targets

**Required** (read before coding):
- planctl/scripts/migrate_acks_to_state.py — backfill template (idempotent pop+rewrite)
- planctl/store.py — the `.1` sidecar write API to call
- planctl/run_approve.py — the def-write to remove (contract); planctl/docs/reference/commit-at-mutation-boundary.md — verb classification

### Risks

- The contract (stop def-write + strip) is irreversible-ish — MUST be gated on the positive verify, never on backfill success or "we restarted keeper."
- keeper's permanent def-fallback covers any keeper-boots-first race after the strip.

### Test notes

pytest on a tmp tree: backfill seeds sidecars + idempotent + `--dry-run`
no-ops; after contract, approve writes sidecar only and does not auto-commit;
strip pops def approval clean.

## Acceptance

- [ ] Idempotent backfill seeds sidecars; `--dry-run` mutates nothing
- [ ] Contract happens ONLY after a positive end-to-end sidecar-fold verify in a quiesced window
- [ ] After contract, approve is runtime-state-only (no def write, no auto-commit); docs updated
- [ ] pytest green

## Done summary

## Evidence
