## Description

**Size:** M
**Files:** gitpolice/watch.ts (new), test/gitpolice.test.ts (new), package.json, tsconfig.json, test/build-pin.test.ts

### Approach

New scanner binary mirroring performance/watch.ts (SLUG='gitpolice';
--tick/--json/table modes; pure detectors with injected deps; seen-state
+ heartbeat machinery copied near-verbatim; schema-skew gate FIRST via
lib/schema-pin — on skew emit only that finding and skip DB detectors;
always exit 0). CENSUS: load cursor sidecar (versioned
`{version, watermark, dev, ino}` under babysitterStateDir('gitpolice'),
atomic writes, corrupt/version-bump/fresh → silently seed to current
MAX(events.id), watermark > MAX(id) → DB restore → re-seed); inside one
read transaction SELECT id, ts, session_id, cwd,
COALESCE(e.data, b.data) AS data FROM events e LEFT JOIN event_blobs b
ON b.event_id = e.id WHERE e.id > ? AND e.hook_event = 'PostToolUse'
AND e.tool_name = 'Bash' ORDER BY e.id ASC LIMIT 500 (backlog carries
to next tick); also read git_status rows + file_attributions +
jobs.git_* (job_id = session_id) for snapshots; close the DB BEFORE any
file I/O. Per row parse $.tool_input.command, run detectInvocations,
emit one census record per invocation: {v: 1, event_id, ts, session_id,
cwd, project_dir, kind: 'git'|'commit-work', subcommand, class, argv,
command: redacted, snapshot}. project_dir = longest-prefix match of cwd
against the git_status.project_dir keys (no match → project_dir null,
snapshot null with reason). Write-class records (class != read) embed
{file_attributions rows for (project_dir, session_id), git_status row,
jobs git_* counts, snapshot_last_event_id} — near-time, documented as
tick-time not command-time. Buffer ALL records for the batch, rotate-
then-append (at tick start if census.ndjson > 10MB rename to
census-<unixts>.ndjson, prune to 7 rotated segments), append in one
write, fsync, THEN advance the cursor (append failure → cursor stays,
duplicates accepted over gaps). State dir created 0700. FINDINGS:
`raw-git-write` per (session_id, project_dir) from the batch's
write-class git records (fingerprint on
`<session_id>::<project_dir>`, evidence carries counts + sample
commands); `orphan-files` per project_dir where git_status.orphaned_count
> 0 (standing condition, self-clears via seen-state TTL); both flow
through the standard applyHeldGate/selectNew/writeFollowup path (no
held categories) with the lib/followups.ts writer; census rows NEVER
route through seen-state. Wire scope: add gitpolice to package.json
lint glob + tsconfig include + build-pin SITTER_MODULES.

### Investigation targets

**Required** (read before coding):
- performance/watch.ts:2435-2564 — tick() flow to mirror (heartbeat-last, cold-start silent baseline, best-effort followup writes)
- performance/watch.ts:1161-1280 — backstop-baseline sidecar (version field, dev/ino guard, exclusive watermark, corrupt→empty seed) — the cursor template
- performance/watch.ts:2050-2197 — seen-state + heartbeat + path resolvers to copy
- performance/watch.ts:2388-2406 — liveWriteFollowup/FollowupConfig wiring
- test/helpers/fixture-db.ts — fixtureDbFile/openWritable/FIXTURE_SCHEMA_VERSION; test/watch.test.ts:116-137 (env sandbox) + :185 (quietDeps pattern)
- test/fixtures/schema-v66.sql:109-156 — events columns (data NULLABLE since v58 — the COALESCE is load-bearing); :157-218 — file_attributions/git_status/jobs columns

**Optional** (reference as needed):
- test/build-pin.test.ts:30 — SITTER_MODULES to extend
- ~/docs/babysitters/gitpolice/charter.md — the contract the output must match (key scheme, census path, categories)

### Risks

- Cursor/append ordering is the integrity core: a crash between append and cursor-advance must yield duplicates, never gaps — test it explicitly.
- LIMIT-bounded batches mean raw-git-write findings derive from a partial window under backlog; acceptable (the finding re-derives next tick) but assert the cursor only advances past processed rows.
- jobs.git_* counts may be zero/missing for ambient sessions — fold to nulls, never skip the census row.

### Test notes

test/gitpolice.test.ts over the fixture DB: seed PostToolUse/Bash events
(inline data AND blob-relocated via event_blobs with NULL inline data)
+ git_status/file_attributions/jobs rows; assert census records
(one per invocation, multi-invocation events all-or-nothing), cursor
seed/advance/re-seed-on-restore/corrupt-recovery, exactly-once across
two ticks, snapshot embedding + longest-prefix project_dir resolution +
missing-row folds, rotation at size cap, raw-git-write/orphan-files
findings + followup files, schema-skew gate skipping DB detectors,
missing-DB early return exit 0 with heartbeat, census rows absent from
seen.json.

## Acceptance

- [ ] Two consecutive ticks over the same fixture produce no duplicate census records; a simulated append failure leaves the cursor unmoved
- [ ] Blob-relocated events (NULL inline data) still yield census records via the COALESCE join
- [ ] Write-class records carry projection snapshots; read-class records carry none and produce no finding
- [ ] raw-git-write keys as `raw-git-write:<session_id>::<project_dir>`; orphan-files fires per project_dir with orphaned_count > 0; followup files conform to FINDINGS-LEDGER.md frontmatter
- [ ] --tick exits 0 on missing DB, schema skew, corrupt cursor, and append failure; heartbeat stamped in all cases
- [ ] bun test, lint, and the build-pin fence pass with gitpolice in scope

## Done summary

## Evidence
