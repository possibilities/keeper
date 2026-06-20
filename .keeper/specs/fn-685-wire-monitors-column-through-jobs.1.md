## Description

Findings monitors-missing-from-descriptor and no-descriptor-wire-render-test both point to the same gap: `monitors` is absent from `JOBS_DESCRIPTOR.columns` in `src/collections.ts:90-144`. Because the server-worker builds its SELECT from `descriptor.columns.join(", ")` (server-worker.ts:695), the field is never sent over the wire, so `cli/jobs.ts:533`'s `monitorLinesFor(r.monitors, "  ")` always receives `undefined`. The fix is one line in the columns array. It does NOT go into `sortable`, `filters`, or `jsonColumns` (same pattern as `profile_name` and `backend_exec_*`). Companion test: a `toContain("monitors")` assertion in `test/collections.test.ts`, mirroring the `profile_name` test at line 203.

## Acceptance

- [ ] `"monitors"` added to `JOBS_DESCRIPTOR.columns` in `src/collections.ts`
- [ ] NOT added to `sortable`, `filters`, or `jsonColumns`
- [ ] `test/collections.test.ts` asserts `JOBS_DESCRIPTOR.columns` contains `"monitors"` and that it is absent from sortable/filters/jsonColumns

## Done summary
Added 'monitors' to JOBS_DESCRIPTOR.columns so the wire SELECT ships the field; companion test guards columns inclusion + absence from sortable/filters/jsonColumns. Display-only, matches profile_name / backend_exec_* pattern.
## Evidence
