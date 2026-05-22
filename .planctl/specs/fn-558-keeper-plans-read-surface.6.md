## Description

**Size:** S
**Files:** scripts/keeper-frames.ts, scripts/keeper-subscribe.ts

Make both client scripts drive any collection, defaulting to `jobs` for
back-compat.

### Approach

`keeper-subscribe.ts` already has `--collection` (default `jobs`) — update
its `--help`/option docs to mention `epics`/`tasks` and their filter/sort
columns; verify it works against the new collections unchanged otherwise.
`keeper-frames.ts` is hardcoded to jobs: add a `--collection` flag (default
`jobs`), replace the hardcoded `row.job_id` index key with the collection's
pk (resolve via a small per-collection map: jobs→job_id, epics→epic_id,
tasks→task_id), and make `projectRow` collection-aware — jobs keep
`{basename(cwd)} · {title} · {state}`; epics →
`{basename(project_dir)} · #{number} · {title} · {status}`; tasks →
`{epic_id} · #{number} · {title} · {status}`. Keep the existing
`--state`/`--state-ne` jobs filter working; add nothing collection-specific
beyond the render + pk.

### Investigation targets

**Required:**
- scripts/keeper-frames.ts:195-214 — `projectRow`/`renderBody` (jobs-specific render to generalize) and the `row.job_id` index sites (e.g. lines 284-288, 317-327)
- scripts/keeper-subscribe.ts:22-36,112-161 — the existing `--collection` plumbing + help text to extend

### Risks

- Don't break the existing jobs default — both scripts must behave
  identically for jobs invocations (back-compat is an acceptance criterion).

### Test notes

Manual: `bun scripts/keeper-subscribe.ts --collection epics --once` and
`bun scripts/keeper-frames.ts --collection tasks` against a running keeperd
with seeded plan rows; `--collection jobs` (and the bare default) unchanged.
Capture output as evidence.

## Acceptance

- [ ] `keeper-frames.ts` takes `--collection` (default `jobs`), uses the collection pk, and renders a collection-appropriate row line for jobs/epics/tasks
- [ ] `keeper-subscribe.ts` help documents epics/tasks; both scripts work against the new collections
- [ ] Jobs behavior (default + `--state` filters) is byte-identical to before
- [ ] Read-only fence preserved: scripts send only `query`/`unsubscribe`

## Done summary

## Evidence
