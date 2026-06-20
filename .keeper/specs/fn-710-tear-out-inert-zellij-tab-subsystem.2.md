## Description

**Size:** S
**Files:** src/db.ts, keeper/api.py, src/collections.ts, src/types.ts, cli/jobs.ts, test/schema-version.test.ts, test/db.test.ts, test/jobs.test.ts, README.md, CLAUDE.md

Drop the two dead `jobs.backend_exec_{tab_id,tab_name}` columns (sole writer
was the now-removed `foldBackendExecSnapshot`) via a forward-only migration,
and remove every reader of them. Depends on Task 1 (fold + reap gone) so the
columns are truly unwritten/unread before the drop.

### Approach

1. **db.ts** — add a new vNN→vNN+1 slot in `migrate()` (:2114) calling `dropColumnIfPresent(db, "jobs", "backend_exec_tab_id")` + `..._tab_name` (no indexes on them — verified, no rebuild needed). Remove the two literals from the `CREATE_JOBS` table literal (:763-764). Confirm the steady-state INSERT (:5399/:5408) lists only type/session_id/pane_id (it does — tab cols were only written by the fold UPDATE); leave it. Bump `SCHEMA_VERSION` (:61, 54→55).
2. **keeper/api.py** — add 55 to `SUPPORTED_SCHEMA_VERSIONS` (:203) IN THIS COMMIT (the hard whitelist gates every commit-work; test/schema-version.test.ts enforces max-coverage AND CLAUDE.md requires the explicit listing).
3. **collections.ts** — remove `backend_exec_tab_id`/`tab_name` from the `columns` array (:150-151) so the wire-projection SELECT stops naming dropped columns (else the daemon query throws at boot). Surgically edit the mixed live/dead comment (:134-146) — keep the type/session_id/pane_id COALESCE sentences, excise the tab/BackendExecSnapshot sentence.
4. **types.ts** — drop the `backend_exec_tab_id`/`tab_name` fields from the `Job` interface (:686/:693) or TS compile fails against the trimmed collections list; fix the doc-comments (:409/:650/:672).
5. **cli/jobs.ts** — update `backendCoordsSeg` (:258-261) to drop the tab slot (render pane-only); keep pane_id.
6. **Docs** — README: surgically trim the v48/fn-668 block (~1460-1499) and the `keeper jobs` coord-pill prose (~856-865) to remove ONLY the tab facts (session/pane STAY). CLAUDE.md: add the v55 schema bump to the migration/keeper-py bullet's running narrative if it enumerates versions.

### Investigation targets

**Required** (read before coding):
- src/db.ts:61 SCHEMA_VERSION, :763-764 CREATE_JOBS literal, :1773 dropColumnIfPresent, :2114 migrate slot, :5399/:5408 INSERT list
- keeper/api.py:203 SUPPORTED_SCHEMA_VERSIONS
- src/collections.ts:150-151 column list, :134-146 mixed comment
- src/types.ts:686/:693 Job fields
- cli/jobs.ts:258-261 backendCoordsSeg
- test/schema-version.test.ts:56-65 gate; test/db.test.ts:7071-7083 migration-shape assertion (+ :7087 v47→v48 test as the pattern for a new drop-migration test); test/jobs.test.ts ~136-230 backendCoordsSeg cases

### Risks

- **Forgetting keeper/api.py** → every commit-work on the host fails loudly until fixed. Co-commit + run test/schema-version.test.ts locally first.
- **Missed reader of the dropped columns** (collections wire SELECT, types.ts Job, backendCoordsSeg) → daemon query throws at boot OR tsc fails. The grep sweep from Task 1 plus a clean `tsc` is the guard.
- **Re-fold safety:** the migration is forward-only + version-guarded; the columns are gone from the projection, and Task 1 already made the fold a no-op, so a from-scratch re-fold reproduces the new (column-less) shape. Note the historical events still exist but fold to no-op.
- **Migration-shape test** (db.test.ts:7071-7083) currently asserts the columns EXIST — must flip to assert they're GONE for jobs while the three live coords remain; add a new test for the drop migration mirroring the v47→v48 test.

### Test notes

- test/schema-version.test.ts must pass with 55 listed.
- test/db.test.ts — update the table-shape assertion (jobs has type/session_id/pane_id, NOT tab_id/tab_name) + add a drop-migration test mirroring the v47→v48 pattern.
- test/jobs.test.ts — update the ~10 backendCoordsSeg cases that fed tab_name/tab_id to the pane-only contract.
- Full `bun test` + `tsc` green; boot the daemon against a pre-migration DB copy to confirm the migration runs clean and projections rebuild.

## Acceptance

- [ ] jobs.backend_exec_tab_id/tab_name dropped via a version-guarded dropColumnIfPresent migration; CREATE_JOBS literal trimmed; SCHEMA_VERSION 54→55
- [ ] keeper/api.py SUPPORTED_SCHEMA_VERSIONS gains 55 in the SAME commit; test/schema-version.test.ts green
- [ ] collections.ts column list + types.ts Job fields + backendCoordsSeg no longer reference the dropped columns; tsc green
- [ ] db.test.ts table-shape assertion flipped + drop-migration test added; jobs.test.ts pane-only cases updated; full bun test green
- [ ] README v48 block + coord-pill prose trimmed to session/pane only; daemon migrates a real DB copy clean and projections rebuild

## Done summary
Dropped the two dead jobs.backend_exec_{tab_id,tab_name} columns via a forward-only v54→v55 dropColumnIfPresent migration; removed every reader (collections wire SELECT, Job interface, pane-only backendCoordsSeg) and co-bumped keeper-py SUPPORTED_SCHEMA_VERSIONS to 55. Flipped the db.test.ts shape assertion, added a v54→v55 drop-migration test, pane-only jobs.test.ts cases, and retracked ~60 stale schema-version assertions to String(SCHEMA_VERSION). Real-DB copy migrates clean (2336 jobs rows preserved, three live coords remain).
## Evidence
