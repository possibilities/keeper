## Description

**Size:** M
**Files:** test/integration.test.ts, CLAUDE.md, README.md

The capstone: an end-to-end integration test for the full plans path and
the documentation updates that the feature requires.

### Approach

Add a plans end-to-end test to `test/integration.test.ts` mirroring the
existing transcript→title and UDS query→result→patch tests: point the
plan-worker at a hermetic tmp root, write a `.planctl/epics/<id>.json` (and
a task file), assert the synthetic event lands, folds into `epics`/`tasks`,
and a UDS `query`/subscribe over those collections returns `result` + a
live `patch` when the file changes.

Documentation (from docs-gap-scout): in **CLAUDE.md** (AGENTS.md symlink) —
add `src/plan-worker.ts` to the directory layout + module-entry table;
update the `collections.ts` entry (now registers epics/tasks); document
`EpicSnapshot`/`TaskSnapshot` in the State machine; bump `SCHEMA_VERSION`
references 5→6 in Event-sourcing invariants; **remove/rewrite the DO NOT
bullet that forbids plans/planctl_mutations**; note boot spawns four
workers; add plan-worker as a second Producer-worker instance in the Worker
contract. In **README.md** — fix worker count + "jobs is the only
collection" prose; **remove the "No plans / planctl_mutations" non-goal
bullet**; add a `~/.config/keeper/config.yaml` install note; add epics/tasks
inspect examples.

### Investigation targets

**Required:**
- test/integration.test.ts (the transcript→title e2e ~line 466, UDS query→result→patch ~line 313) — the end-to-end test shape to mirror
- CLAUDE.md — directory layout, module entry table, State machine, Event-sourcing invariants, the DO NOT bullet, Worker contract (all need edits)
- README.md — worker-count prose, the "No plans / planctl_mutations" non-goal bullet, install, inspect examples

### Risks

- The DO NOT / non-goal removal is the highest-signal doc change — leaving
  the stale "keeper does not track planctl state" invariant in place would
  actively mislead future agents. Don't miss it in either file.
- Keep the integration test hermetic (tmp root + `KEEPER_*` overrides) so
  it can't watch the real `~/code`.

### Test notes

`bun test test/integration.test.ts` green including the new plans case;
full `bun test` + `bun run typecheck` + `bun run lint` clean.

## Acceptance

- [ ] An integration test exercises write `.planctl` file → worker → synthetic event → fold → projection → UDS query/patch, hermetically
- [ ] CLAUDE.md updated: plan-worker in layout + module table, State machine entries, SCHEMA_VERSION 5→6, DO NOT bullet removed/rewritten, four workers, Worker-contract second Producer
- [ ] README.md updated: worker count, collections prose, the plans non-goal bullet removed, config install note, epics/tasks inspect examples
- [ ] `bun test` + `bun run typecheck` + `bun run lint` all green

## Done summary
Added a hermetic plan-worker end-to-end integration test (.planctl write → synthetic event → fold → epics/tasks projection → UDS query/result + live patch) and updated CLAUDE.md/README.md for the read-only plans surface (four workers, epics/tasks collections, SCHEMA_VERSION v6, read-only plans fence replacing the old plans/planctl_mutations ban).
## Evidence
