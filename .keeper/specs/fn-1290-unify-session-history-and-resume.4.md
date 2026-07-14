## Description

**Size:** M
**Files:** cli/history.ts, cli/keeper.ts, cli/descriptor.ts, cli/envelope.ts, test/history-cli.test.ts, test/keeper-cli.test.ts, test/help-purity.test.ts

### Approach

Expose the new internals as `keeper history list|show|search|files|index`. The group is global across projects by default, accepts narrowing harness/project/session filters, uses the shared Session-reference resolver, and emits stable human or shared JSON-envelope output with actionable problem codes and pagination.

Keep `keeper transcript` as the specialist low-level surface and leave the old top-level history readers temporarily routable until the final atomic cutover task migrates every consumer. Descriptor, completion, and lazy-dispatch registration remain single-sourced.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/transcript.ts:37 — bounded list/show grammar, filtering, and human rendering
- cli/keeper.ts:35 — top-level command routing and lazy imports
- cli/descriptor.ts:1211 — current history-reader descriptors and completion metadata
- cli/envelope.ts:1 — converged success/error envelope helpers
- cli/show-job.ts:1 — pure resolver/impure glue command structure

**Optional** (reference as needed):
- test/keeper-cli.test.ts:94 — routing contract coverage
- test/help-purity.test.ts:1 — help paths must remain side-effect free

### Risks

Global defaults, first-index progress, TTY versus pipe rendering, partial warnings, and FTS syntax errors must not create silent hangs or divergent human/JSON behavior.

### Test notes

Drive the exported CLI runner with injected catalog/index/query dependencies. Cover every verb, omitted verb help, invalid flags, global defaults, filters, pagination, empty success, warnings, ambiguity, index status/rebuild, and no-state help purity.

### Detailed phases

1. Define descriptors and parse shared list/show/search/files/index options.
2. Add bounded human renders and versioned envelopes with stable problem codes.
3. Wire lazy routing and completions without importing SQLite/filesystem code on help paths.
4. Add integration tests against tiny catalog/index fixtures.

### Alternatives

Overloading `keeper session files` or replacing specialist transcript operations is rejected because runtime job state, file evidence, and harness-specific transcript controls are distinct contracts.

### Non-functional targets

Help is pure, JSON emits one envelope, non-TTY commands never prompt, defaults are bounded, and error output never includes transcript content.

### Rollout

This task adds the canonical group alongside the existing outliers. The final cutover task removes those names only after all consumers and guidance use the new group.

## Acceptance

- [ ] `keeper history list`, `show`, `search`, `files`, and `index` are registered in routing, machine-readable help, and completions from the canonical descriptor tree.
- [ ] List/search are cross-project and cross-supported-harness by default, while project, harness, time, role/source, and Session-reference filters narrow deterministically.
- [ ] Human and JSON modes expose bounded results, pagination, freshness/partial warnings, stable context commands, and actionable typed failures without leaking transcript bodies in diagnostics.
- [ ] `show` resolves titles and ids before delegating bounded rendering while retaining specialist transcript capabilities on `keeper transcript`.
- [ ] `files` labels every evidence grade and requires explicit mention inclusion.
- [ ] `index` reports status and safely requests refresh/rebuild/purge behavior through the sole indexer seam.
- [ ] Focused history CLI, routing, completion, and help-purity tests pass.

## Done summary

## Evidence
