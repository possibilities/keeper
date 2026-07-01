## Description

**Size:** S
**Files:** src/board-render.ts, cli/jobs.ts, cli/board.ts, README.md, CLAUDE.md, keeper/api.py

Render the three new fields on the jobs board and land the documentation the new event, worker,
columns, CLI, and launch flag require.

### Approach

Render current model, effort, and context% as jobs pills in `src/board-render.ts` (~`:98`,
following the `last_api_error_kind` pill precedent): show `context_used_percentage` rounded (and
optionally `Ntok/Mtok` from `context_input_tokens`/`context_window_size`); render the effort
tri-state as a blank/`—` pill when NULL, NEVER defaulted to "low"; truncate long model names to
fit board width. Surface the fields wherever `cli/jobs.ts` / `cli/board.ts` present job rows.

Docs: README `## Architecture` — add the statusline worker to the roster (next ordinal + renumber
cross-refs), a `SessionTelemetry` event/projection paragraph, a v100 jobs column-history entry,
the `statusline-sink` subcommand in the CLI catalog, and a `keeper agent --settings` launch-config
note. CLAUDE.md — one sole-writer line for the sink's per-session leaf-file write surface. keeper/api.py
— the `# v100` comment if `.1` did not already add it. Keep README/CLAUDE.md prose forward-facing
(no fn-ids/history per rule #0); api.py's comment block follows its own fn-id convention.

### Investigation targets

**Required** (read before coding):
- src/board-render.ts:98 — the jobs pill rendering (last_api_error_kind precedent)
- cli/jobs.ts, cli/board.ts — the job-row presentation consumers
- README.md `## Architecture` — worker roster, event/projection catalog, jobs column-history block, CLI catalog, keeper agent launch-config
- CLAUDE.md — the sole-writer rules bullet

### Risks

Board width is finite — three new fields need truncation/omission rules. Effort NULL must never
render as "low". README/CLAUDE.md prose must stay forward-facing.

### Test notes

A board-render unit test over a jobs row carrying telemetry columns asserts the pills and the
NULL-effort rendering. Docs are prose (no test).

## Acceptance

- [ ] The jobs board shows current model, effort (`—` for unknown), and context%, with long names truncated
- [ ] README `## Architecture` and CLAUDE.md updated per the docs-gap findings; `# v100` comment present in api.py
- [ ] `bun test` green

## Done summary

## Evidence
