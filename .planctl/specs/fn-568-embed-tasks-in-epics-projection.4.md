## Description

**Size:** S
**Files:** scripts/keeper-frames.ts, CLAUDE.md, README.md

Land the consumer + documentation changes once the embedded shape and delete
sync are settled, so docs are written once against final behavior.

### Approach

- **keeper-frames** (`scripts/keeper-frames.ts`): remove `tasks` from
  `PK_BY_COLLECTION`, drop the `tasks` branch in `projectRow`, and remove
  `--collection tasks` from help/usage — a post-migration `--collection tasks`
  would hit `unknown_collection`. The `epics` page already renders the nested
  `tasks` array via `yamlScalar`'s existing flow-sequence rendering (no new
  render code).
- **CLAUDE.md** (symlinked AGENTS.md): update per the epic's `## Docs gaps` —
  `src/db.ts` entry (v7, drop table + add column), `src/collections.ts` entry
  (two descriptors, `epics` jsonColumn), `src/reducer.ts` entry + State
  machine (array fold + new TaskDeleted/EpicDeleted tombstones), schema
  version-history, event-sourcing invariants, plan-worker entry +
  Producer-worker archetype (onDelete retractions + boot reconciliation), DO
  NOT section.
- **README.md**: architecture + no-plan-write-path mentions; rewrite the
  Inspect section's `SELECT … FROM tasks` query (use `json_each(epics.tasks)`
  or drop it) and show the embedded `tasks` column on the epics query.

### Investigation targets

**Required** (read before coding):
- scripts/keeper-frames.ts:61,102,107,114 (help/usage), :130 (PK_BY_COLLECTION), :146-151 (yamlScalar flow rendering), :259-261 (projectRow tasks branch)
- CLAUDE.md — the src/db.ts / src/collections.ts / src/reducer.ts entries, State machine, schema version-history block, event-sourcing invariants, plan-worker entry, Producer-worker archetype, DO NOT section
- README.md — architecture section, Inspect section (`SELECT … FROM tasks`)

### Risks

- CLAUDE.md is the in-codebase map; leaving stale two-table prose misleads future agents. Cross-check every `tasks`-collection / `tasks`-table mention.

### Test notes

- `bun test --isolate` stays green (no behavior change here); manually run keeper-frames against the `epics` collection and confirm the nested `tasks` array renders.

## Acceptance

- [ ] keeper-frames no longer references the `tasks` collection; `epics` output renders the nested `tasks` array
- [ ] CLAUDE.md + README reflect v7, the single embedded collection, tombstone deletes, and boot reconciliation
- [ ] no stale `tasks`-table / `tasks`-collection prose remains; suite green

## Done summary

## Evidence
