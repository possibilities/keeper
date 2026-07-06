## Description

**Size:** S
**Files:** cli/agent.ts, src/agent/main.ts, cli/dispatch.ts, cli/query.ts, test/dispatch-cli.test.ts

### Approach

Three truth fixes. (1) Defect 2: `keeper agent --help`/`--version` runs realDeps() → migrateLegacyAgentStateDir() before routing — route help/version from argv before any dependency construction; the help/version text must render without touching the state dir, db, or daemon (keep the lazy-import discipline that keeps src/db.ts off this path). Migration stays where the real launch path builds deps. (2) `keeper dispatch --help`/`--agent-help` document only `<work|close>::` while the parser accepts `unblock::`/`deconflict::` — document all four plan-form verbs with their scoping (task-scoped like work / epic-scoped like close). (3) `keeper query --help` claims `--json` exists "for symmetry with the viewers" — the viewers take no `--json`; reword to name the JSON-reader family. Update the ordinal-1 descriptors where these leaves' metadata changed.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/agent.ts:44-48,68-69 — lazy-import note + the realDeps()-before-routing defect site
- src/agent/main.ts:245 — migrateLegacyAgentStateDir (must be unreachable from help/version)
- cli/dispatch.ts:302-308 — the escalation-verb acceptance the help text omits; :146,184 — the usage lines to extend

**Optional** (reference as needed):
- cli/query.ts:82 — the false symmetry claim

### Risks

- `--version` semantics: keep it keeper's own version (current behavior) — do not conflate with a launched harness's version.

### Test notes

Under throwing stub deps, `agent --help` and `agent --version` exit 0 with output and never construct deps; dispatch help text names all four verbs.

## Acceptance

- [ ] `keeper agent --help` and `--version` print and exit 0 without state-dir migration, db, or daemon access
- [ ] `keeper dispatch --help` and `--agent-help` document work/close/unblock/deconflict with their id shapes
- [ ] `keeper query --help` makes no false symmetry claim

## Done summary

## Evidence
