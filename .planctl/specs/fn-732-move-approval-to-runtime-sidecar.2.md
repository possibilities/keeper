## Description

**Size:** S
**Files:** scripts/migrate_approval_to_sidecar.py, tests/test_migrate_approval_to_sidecar.py

One-shot idempotent migration that seeds approval sidecars from existing
def-file approvals AND strips `approval` from the def files — the "out of
git" step itself. Run per repo at cutover.

### Approach

Mirror `scripts/migrate_acks_to_state.py` closely: enumerate parent roots
(`devctl list-roots`, loud-WARN fallback to `[/Users/mike/code]`), glob
`<root>/*/.planctl/` projects. For each project, walk `epics/*.json` and
`tasks/*.json`; for each def carrying a non-default `approval`, write it
into the sidecar via the task-1 `LocalFileStateStore` API (task RMW under
lock; epic sidecar), then pop `approval` from the def and atomic-rewrite.
Idempotent: pop-only-on-present + sidecar upsert, safe to re-run. Pop a
present-but-null/`pending` def value too so def JSON ends clean. Provide a
`--dry-run` that reports counts without writing.

### Investigation targets

**Required:**
- planctl/scripts/migrate_acks_to_state.py — the structural template (root enumeration, glob, idempotent pop+rewrite)
- planctl/store.py — the task-1 sidecar write API to call (do not hand-roll JSON writes)

### Risks

- Must run AFTER task 1 ships the store API. Ordering across many live
  repos is the operator's at cutover; keeper's def-fallback covers a
  keeper-boots-first race.
- Don't strip approval before writing the sidecar (write-then-pop order).

### Test notes

pytest on a tmp project tree: def-with-approval → sidecar carries it + def
stripped; re-run is a no-op; `--dry-run` writes nothing; pending/null def
approvals popped clean.

## Acceptance

- [ ] Script seeds sidecars from def approvals and strips `approval` from def files, across all discovered projects.
- [ ] Idempotent on re-run; `--dry-run` mutates nothing.
- [ ] pytest green on a fixture project tree.

## Done summary

## Evidence
