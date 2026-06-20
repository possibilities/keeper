## Description

**Size:** M
**Files:** src/derivers.ts, src/db.ts, src/reducer.ts, keeper/api.py, test/derivers.test.ts, test/reducer.test.ts, CLAUDE.md, README.md

### Approach

Lift the planctl envelope's repo-relative `files` array into a new nullable
`events.planctl_files` (TEXT JSON array) column via `extractPlanctlInvocation`
(`src/derivers.ts:392`), mirroring the `bash_mutation_targets` shape
(Array.isArray + per-element string filter; never throw — exit-0 contract;
cap defensively). In the reducer, on the `planctl_op != null` fold (the seam
at `src/reducer.ts:5621` that already fires `syncPlanctlLinks`), mint one
`file_attributions` row per path via the pass-1 upsert shape
(`src/reducer.ts:1758`): `project_dir = state_repo` (from the envelope, NOT
repo_root), `session_id = event.session_id`, `file_path = the repo-relative
path`, `last_mutation_at = event.ts`, `source = 'planctl'`. Guard
`Array.isArray && length>0` (read-only ops carry null/[]); skip/normalize
non-relative paths so the tuple matches the dirty + commit tuples.

Widen `source` to allow `'planctl'`: the `file_attributions.source` CHECK
(`src/db.ts:~1147`) needs a version-guarded TABLE REBUILD (CREATE new +
INSERT…SELECT copy + DROP + rename) — preserve rows byte-identical (same
column order/values) so a migrated DB and a from-scratch re-fold converge.
Add `'planctl'` to: the pass-2 inferred-guard enum (`src/reducer.ts:~1807`
`source IN ('tool','bash')`) so a planctl file doesn't ALSO get a spurious
inferred attribution; the pass-3 render whitelist (`~:1903`) so it doesn't
downgrade to `'inferred'`; and the `RenderedAttribution`/`SessionMutation`
source unions (`~:1151`, `~:1196`). Bump `SCHEMA_VERSION` (next free int
after 43) for BOTH the additive `planctl_files` column and the CHECK
rebuild, and add the version to keeper-py `SUPPORTED_SCHEMA_VERSIONS`
(`keeper/api.py:~84`) in the SAME change (test/schema-version.test.ts
enforces). Backfill: re-derive `planctl_files` over historical
`PostToolUse:Bash` planctl events from the stored envelope, then
version-guarded rewind (`last_event_id=0`) + clear projections so the next
boot re-folds the healed log (mirror fn-648's git-rm/mv backfill).

Coordinate with fn-664 (hard dep): it rewrites the same `foldCommit`
discharge predicate + bumps schema. Land on top of it; rebase the migration
onto the next free int and adopt its (oid-aware) discharge predicate for
the planctl rows.

### Investigation targets

**Required** (read before coding):
- src/derivers.ts:392 `extractPlanctlInvocation` (add the `files` lift; new return field + new column write); test/derivers.test.ts:178 envelope helper + :400 the scaffold-folds-epic_id-null test
- src/db.ts:~60 `SCHEMA_VERSION`, ~:375 planctl envelope columns (add `planctl_files` nearby), ~:1139 `CREATE_FILE_ATTRIBUTIONS` + ~:1147 the `source` CHECK (table rebuild), the migrate() ALTER slot
- src/reducer.ts:5621 the `planctl_op != null` fold seam, :1758 pass-1 upsert, :1807 inferred-guard enum (MUST widen), :1903 render whitelist (MUST widen), :1151/:1196 source unions, :2248 foldCommit discharge
- keeper/api.py:~84 SUPPORTED_SCHEMA_VERSIONS; test/schema-version.test.ts
- fn-648's git-rm/mv backfill (the version-guarded re-derive + rewind+re-fold precedent)

**Optional**:
- src/git-worker.ts:~553 `commitFiles` + ~:770 `dirty_files[].path` (confirm repo-relative tuple alignment)
- ~/docs/keeper-reliability/findings.md (the 559-orphan capture + root cause)

### Risks

- **Path tuple mismatch:** the minted `file_path` must byte-match `dirty_files[].path` and the Commit event's path (all git repo-relative). A `./`-prefix or absolute path would never render OR never discharge — normalize-or-skip.
- **CHECK rebuild determinism:** the table rebuild must preserve every existing row byte-identical; a re-fold rebuilds the table from scratch and must converge.
- **state_repo vs repo_root:** attribute under `state_repo` (where the .planctl files are dirty); fall back safely if absent.
- **Cross-session commit:** the `chore(planctl)` commit is often a DIFFERENT session than the scaffolder — per-session discharge won't clear the scaffolder's row, but the file leaves dirty_files on commit so it never re-renders (inert row; acceptable, pre-existing behavior for all sources).
- **Backfill + re-fold cost:** a full re-fold replays the whole log; bounded by fn-659's paced boot. Verify the re-fold time is acceptable on a copy.
- **fn-664 conflict:** same discharge pass + schema int — hard dep + rebase.

### Test notes

Deriver test: a planctl envelope with a `files` array → `events.planctl_files`
populated; null/empty `files` → null column, no throw. Reducer test: a
planctl_op event mints `source='planctl'` attributions for each file keyed
by state_repo + session + path + event.ts; the next GitSnapshot renders them
(not orphaned); a following Commit discharges them. Negative: a planctl file
does NOT also get an `inferred` attribution (guard widened). Re-fold
determinism: drive a planctl-op + snapshot + commit sequence, rewind to
cursor 0, clear projections + the rebuilt table, re-fold, assert
byte-identical jobs/epics/file_attributions/git_status. Verify on a copy of
the live DB that re-fold drops `.planctl` orphaned_count to ~0.

### Detailed phases

1. Deriver + column (additive `events.planctl_files`) + the mint fold path + guard/whitelist/union widenings; prove orphan-drop + re-fold on a DB copy BEFORE the CHECK rebuild.
2. `source`-CHECK table rebuild (version-guarded, row-preserving) + SCHEMA_VERSION bump + keeper-py whitelist; rebase onto fn-664's schema int.
3. Backfill historical `planctl_files` + version-guarded rewind/re-fold; docs (CLAUDE.md + README + the drifted schema-version number).

### Alternatives

- Derive paths from (op, epic_id, task_id): rejected (incomplete — misses task JSONs + specs).
- Reuse `source='bash'`: rejected (audit-dishonest; design stance favors the honest native value).

### Non-functional targets

- Re-fold (with backfill) catches up to head in bounded time (fn-659 paced boot).
- Mint adds O(files-per-op) SQL per planctl fold (small — a handful of paths); no per-dirty-file rescan.
- `.planctl` orphaned_count holds at 0 through scaffold/close/approve/sort_path bursts.

### Rollout

Verify mint + orphan-drop + byte-identical re-fold on a DB copy first.
Deploy via a keeperd bounce. Rollback: revert the fold path (additive mint;
existing rows inert).

## Acceptance

- [ ] `events.planctl_files` populated by the deriver from the envelope `files` (null/empty safe, never throws)
- [ ] planctl_op fold mints `source='planctl'` file_attributions (project_dir=state_repo, session, path, event.ts) for each named file
- [ ] pass-2 inferred-guard + pass-3 render-whitelist + source unions include `'planctl'`
- [ ] `source`-CHECK table rebuild is version-guarded + row-preserving; SCHEMA_VERSION bumped + keeper-py SUPPORTED_SCHEMA_VERSIONS updated same change; schema-version test green
- [ ] backfill + version-guarded re-fold heals historical .planctl orphans
- [ ] from-scratch re-fold byte-identical (determinism across the rebuild); verified on a DB copy that .planctl orphaned_count → ~0
- [ ] discharge on the chore(planctl) commit confirmed; CLAUDE.md + README updated; committed to main staging only touched files

## Done summary
Lifted planctl envelope's files[] into events.planctl_files, minted source='planctl' file_attributions in the reducer's planctl_op fold seam keyed on state_repo+session+path so .planctl/ JSONs and specs no longer orphan; widened source CHECK enum via row-preserving rebuild, bumped SCHEMA_VERSION to 46 with keeper-py whitelist, backfilled historical events.planctl_files + rewound cursor for from-scratch re-fold healing.
## Evidence
