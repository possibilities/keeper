## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/autopilot-worker.ts, src/collections.ts, cli/autopilot.ts, keeper/api.py

### Approach

Add `worktree_mode` as a boolean `autopilot_state` column (in-memory default
OFF) riding fn-953's generic `set_autopilot_config` patch surface — a new
patch field + a column + a default constant, NO new RPC. Thread the value
onto `ReconcileSnapshot` and read it fresh each reconcile cycle exactly like
`mode`. Add a `keeper autopilot worktree <on|off> [--force]` CLI subcommand
that writes the value via the config patch and carries the mid-epic-toggle
guard, plus a banner segment. The guard: enabling/disabling `worktree_mode`
is rejected (loud) when ANY epic is mid-flight (live dispatched/running job
or an existing `keeper/epic/*` worktree); `--force` bypasses. Bump
`SCHEMA_VERSION` and add the new version to `SUPPORTED_SCHEMA_VERSIONS` in
`keeper/api.py` in the SAME commit. Fold must UPSERT preserving sibling
columns (paused/mode/cap).

### Investigation targets

**Required** (read before coding):
- fn-953 spec + its task `.1` "Generic autopilot config RPC" — the patch surface this rides; coordinate the column/patch-field shape with it.
- src/db.ts:1281 (autopilot_state CREATE), :4109 (addColumnIfMissing migration template), :49 (SCHEMA_VERSION) — add column + migration here.
- src/reducer.ts:4303-4366 (extract/fold AutopilotMode, sibling-preserving UPSERT) — mirror for the config fold field.
- src/autopilot-worker.ts:384-475 (ReconcileSnapshot carries `mode`), :1671-1684 (per-cycle projection-pull of autopilot_state) — read worktree_mode here.
- cli/autopilot.ts:817-832 (mode subcommand dispatch), :453-470 (buildSetModeFrame), :510-535 (banner) — clone for the worktree subcommand + banner; :854 subcommand error string.
- keeper/api.py:370 (SUPPORTED_SCHEMA_VERSIONS), test/schema-version.test.ts:59.

### Risks

- Naming collision: `worktree_mode` already means git file-mode in `file_attributions`/porcelain `mW` — different table, cosmetic only; do NOT touch those reducer.ts folds (~:899-2034, :6321-6358).
- The generic `set_autopilot_config` RPC (fn-953) is state-agnostic; the mid-epic guard needs epic-state visibility — place it where it can read in-flight epics (main/RPC layer or a CLI preflight that `--force` bypasses), and decide precisely what "mid-epic" means.
- This task hard-depends on fn-953's surface existing; specs are authored against fn-953's plan, execution is sequenced by the epic dep.

### Test notes

Fast-tier reducer/CLI unit tests (fold preserves siblings; fresh-DB default OFF; replay reproduces a set value; banner segment). schema-version test stays green.

## Acceptance

- [ ] `worktree_mode` durable column added with an in-memory default of OFF; fold UPSERT preserves paused/mode/cap.
- [ ] Set at runtime via fn-953's `set_autopilot_config` patch (no new RPC); reconciler reads it fresh each cycle; survives replay.
- [ ] `keeper autopilot worktree <on|off> [--force]` works; banner shows the live worktree state.
- [ ] Mid-epic toggle is rejected loudly with a clear message; `--force` overrides.
- [ ] SCHEMA_VERSION bumped + SUPPORTED_SCHEMA_VERSIONS updated in the same commit; schema-version test green.

## Done summary

## Evidence
