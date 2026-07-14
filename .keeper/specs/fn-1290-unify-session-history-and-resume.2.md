## Description

**Size:** M
**Files:** src/history/index-db.ts, src/history/indexer.ts, src/history/fingerprint.ts, src/history/lock.ts, test/history-index.test.ts

### Approach

Add an independently versioned SQLite FTS5 sidecar beneath Keeper's private state directory. A single lock-serialized indexer fingerprints approved transcript artifacts, streams normalized textual entries into canonical content plus FTS rows, checkpoints active append-only files without consuming torn tails, and atomically publishes full rebuilds only after integrity validation.

The index is disposable and never enters `keeper.db`, the reducer, or Keeper's migration ladder. Protect the directory, database, WAL/SHM, lock, and temporary rebuild artifacts with owner-only permissions; diagnostics expose metadata but never transcript text or raw search queries.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/bus-db.ts:103 — separate SQLite lifecycle, user_version, WAL, and close discipline
- src/keeper-state-dir.ts:19 — canonical state root and test override
- src/transcript/reader.ts:12 — authoritative source discovery remains adapter-owned
- src/transcript/model.ts:1 — normalized entry units and tool fields
- CLAUDE.md:71 — worker/database ownership and cleanup invariants

**Optional** (reference as needed):
- https://www.sqlite.org/fts5.html — FTS content, rebuild, optimize, and query semantics
- src/db.ts:7338 — restrictive atomic-file publication precedent

### Risks

The local corpus is multi-gigabyte; first build, tool-output size, active writes, disk-full interruption, and concurrent refreshes can otherwise cause unbounded latency, stale text, or sensitive temporary files.

### Test notes

Exercise tiny file-backed databases only where WAL/atomic replacement requires persistence. Inject file metadata, lock, clock, and parser seams; do not scan real homes or sleep.

### Detailed phases

1. Define the private schema, independent version/rebuild contract, file modes, and closed-store purge helper.
2. Implement regular-file discovery manifests and source fingerprints for append, shrink, replacement, move, and deletion.
3. Stream entry-level canonical rows and FTS content transactionally, retaining role/source/branch/entry provenance and excluding binary/image payloads.
4. Add lock-serialized incremental refresh and close-then-validate atomic rebuild publication.
5. Add integrity/status metadata and bounded cleanup of abandoned temporary stores.

### Alternatives

Main-database FTS and per-query raw scans are rejected by ADR 0062. Contentless FTS is rejected unless it can provide the same transactional rebuild and snippet contract as canonical content plus FTS.

### Non-functional targets

No unbounded whole-corpus arrays, no transcript body in logs/errors, deterministic source ordering, bounded transactions, old-index availability after failed rebuild, owner-only filesystem state, and no dependency on a running daemon.

### Rollout

The first consumer may create the index lazily; `history index` can force status or rebuild later. An incompatible index version rebuilds rather than migrating authoritative data.

## Acceptance

- [ ] A private independently versioned FTS5 database is created under the Keeper state root without any `keeper.db` schema or reducer change.
- [ ] Owner-only permissions cover the directory, database family, lock, and temporary rebuild artifacts.
- [ ] Incremental ingestion handles complete appends, torn tails, shrink/replacement, moved or deleted artifacts, and source changes during a pass without permanently losing or retaining stale entries.
- [ ] Canonical entry content and FTS rows update atomically with stable session/source/branch/entry provenance.
- [ ] Concurrent refreshes serialize safely, readers retain a usable prior generation during failed rebuilds, and disk/permission/corruption failures return actionable metadata-only errors.
- [ ] Rebuild validates and publishes a closed replacement atomically; whole-store deletion is a supported purge/recovery path.
- [ ] Focused sidecar tests pass without touching host transcript roots or Keeper's live database.

## Done summary

## Evidence
