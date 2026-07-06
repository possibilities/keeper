## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/daemon.ts, src/types.ts, src/collections.ts, keeper/api.py, test/schema-version.test.ts, test/reducer-jobs.test.ts

### Approach

One forward-only migration adds BOTH new nullable columns (no DEFAULT — a default poisons re-fold byte-identity): `jobs.adopted` (the harness-agnostic non-launcher-owned marker) and the autopilot_state codex-adoption knob column (boolean semantics, absent resolves OFF producer-side so no fold reads it). `adopted` is an explicit event field, never derived: add it to the event surface (types + ingester bind list) so the hermes self-seed line and the codex synthetic mint both carry it, and the SessionStart fold arm binds it into the INSERT and COALESCE-preserves it in the ON-CONFLICT set (like worktree/config_dir) so a later resume or launcher re-mint never clobbers it. Walk the full per-column lockstep: migration, reducer INSERT + ON-CONFLICT, the birth mint and its killed-event sibling (bind NULL — births are launcher-owned by definition), collections allow-lists, and the Python schema whitelist in the same commit. Register the knob in the autopilot-config column list with a strict-boolean parse clause and RPC validation (mirror the multi-repo flag) — no new RPC. The derived-marker alternative is rejected because launcher-started pi pins native id as both job id and resume target, which would false-positive.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- src/db.ts:5384, :5801, :5845, :5976 — addColumnIfMissing shape, version-guard pattern, the no-DEFAULT rule, and the documented five-place per-column lockstep precedent
- src/reducer.ts:7772-7916 — projectJobsRow SessionStart arm: INSERT :7825-7827, ON-CONFLICT COALESCE set :7828-7851, terminal-revive :7857, resume_target routing warning :7847-7852
- src/daemon.ts:2960-2964 — insertBirthSessionStart 36-column positional INSERT + the module doc naming its seed-sweep insertKilledEvent sibling
- src/reducer.ts:4867 AUTOPILOT_CONFIG_COLUMNS + :4961 worktree_multi_repo parse clause; src/rpc-handlers.ts:365-430 validator known-set + strict-boolean clause
- src/collections.ts:135, :679 — column allow-lists
- keeper/api.py:423 SUPPORTED_SCHEMA_VERSIONS + test/schema-version.test.ts — same-commit whitelist rule

**Optional** (reference as needed):
- src/types.ts:259-265 — event-field shape precedent (backend_exec_pane_id)
- test/codex-resume.test.ts:96 — seeded raw event row test pattern

### Risks

- The lockstep is wider than the jobs side: missing the events/ingester bind surface leaves the shim's adopted field silently dropped — grep every harness/resume_target binding site as the template
- Concurrent SCHEMA_VERSION bumps on the open board collide on the version counter — the epic-level fn-1129 dep edge is the guard; verify the counter at implementation time

### Test notes

Extend the reducer jobs suite: adopted binds on SessionStart, COALESCE survives a resume conflict and a launcher re-mint, NULL for birth-minted rows. schema-version test green same commit. Knob: config patch round-trip accepts strict boolean, rejects non-boolean, absent column reads OFF.

## Acceptance

- [ ] A SessionStart event carrying the adopted field folds into a jobs row whose adopted marker survives subsequent resume and re-mint conflicts, while birth-minted and killed-event rows carry no marker
- [ ] The codex-adoption knob exists as a durable autopilot config setting: patchable via the generic config RPC with strict boolean validation, defaulting OFF when absent, never read by any fold
- [ ] One schema bump covers both columns, the Python whitelist admits the new version in the same commit, and the full fast suite passes
- [ ] Both new columns are nullable with no DEFAULT, and re-fold over pre-existing history is byte-identical for untouched rows

## Done summary

## Evidence
