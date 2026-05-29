## Description

**Size:** S
**Files:** README.md, CLAUDE.md (AGENTS.md is a symlink — edit CLAUDE.md in place), full `bun test` sweep

Land the cross-cutting doc + invariant updates and verify the whole feature
end to end.

### Approach

- README.md: collections enumeration count + add `dead_letters` (operational
  sidecar, one row per unrecoverable hook INSERT failure); add an "As of
  schema v36, …" paragraph in the schema-version narrative (hook retry,
  per-pid NDJSON, import path, replay-via-RPC route, v35→v36 bump); add the
  `replay_dead_letter` RPC to the RPC list; update the worker count (now
  seven, the dead-letter watcher) in the Architecture section; revise the
  board.ts example bullet (warn count + replay keypress).
- CLAUDE.md: in the event-sourcing invariants, add the import arm (hook
  failure → NDJSON → daemon imports to `dead_letters` operational table, NOT
  folded) and the replay arm (main appends the real event + flips the row in
  one transaction); add a clause to the hook-writer bullet re the per-pid
  NDJSON dead-letter sidecar; update the migrations bullet to v36; add
  `replay_dead_letter` to the DO-NOT RPC enumeration; revise the "approval
  is the only RPC-writable thing" + "main is the sole writer of synthetic
  events" bullets to cover the delayed-real-event replay path (replay writes
  the events log via main, triggered by an RPC). Note `dead_letters` is
  excluded from the re-fold reset.
- Final sweep: `bun test` green; manually drop a dead-letter file, watch the
  board count, press replay, confirm the session reappears.

### Investigation targets

**Required:**
- README.md: collections enumeration, the schema-version narrative tail, the RPC paragraph, the Architecture worker-count sentences, the board.ts example bullet.
- CLAUDE.md: the event-sourcing invariants block, the hook-scoping bullets, the migrations bullet, the DO-NOT RPC + "approval is RPC-writable" bullets.

### Risks

- The CLAUDE.md invariant paragraph is dense run-on prose; insert clauses into the existing paragraphs, don't bolt on new top-level bullets. Keep the AGENTS.md symlink intact (never rm+recreate).
- Worker-count edit is only correct if .3 added a 7th worker — confirm against the final implementation.

### Test notes

- `bun test` full suite green. End-to-end manual: drop file → board shows count → press replay → session reappears → count drops.

## Acceptance

- [ ] README updated: collections count + dead_letters, schema v36 narrative, replay RPC, worker count, board example.
- [ ] CLAUDE.md updated: import + replay invariant arms, hook NDJSON clause, migrations v36, RPC enumeration + revised "approval is the only RPC-writable / main sole synthetic writer" bullets, dead_letters re-fold exclusion.
- [ ] `bun test` green; end-to-end replay manually verified.

## Done summary
Cross-cutting docs land: README adds dead_letters as 7th collection, replay_dead_letter RPC, schema-v37 narrative, seventh-worker block, board pill + replay keypress, and sqlite inspect queries. CLAUDE.md adds dead-letter import/replay arms to the event-sourcing invariants, the hook NDJSON sidecar + main-sole-writer-of-dead_letters clauses, migrations bumped to v37, replay_dead_letter added to the DO-NOT RPC enumeration, and the 'approval is RPC-writable' bullet revised to cover the delayed-real-event surface with the dead_letters re-fold exclusion. AGENTS.md symlink intact. bun test green (6 pre-existing live-shell.test.ts failures unrelated to this task — confirmed identical on clean main).
## Evidence
