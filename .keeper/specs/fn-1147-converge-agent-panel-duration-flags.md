## Overview

The CLI-grammar-convergence epic made every duration flag unit-required
through the shared `cli/duration.ts` grammar, but deliberately scoped out
`keeper agent panel`. Its `start --timeout <s>` and `wait --chunk <s>` still
parse bare seconds via `Number(...)`, so a user who learned `--timeout 5m`
everywhere else hits a hard reject on panel. This finishes the convergence so
the duration grammar is truly universal.

## Acceptance

- [ ] `panel start --timeout` and `panel wait --chunk` accept the unit-required
      duration grammar (e.g. `5m`, `30s`) and reject unitless values with the
      shared self-healing hint
- [ ] The panel descriptor/help text states the duration grammar per flag,
      consistent with the other converged flags

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | src/pair/panel.ts parses --timeout and --chunk via bare Number(); at audited sha 6d0966ad neither routes through the shared cli/duration.ts grammar the epic made universal. |

## Out of scope

- Any duration flag already converged by the source epic (viewers, baseline, await, status, agent --stop-timeout)
- The internal `keeper agent run --stop-timeout-ms` translation panel emits (a separate ms-precision launch contract, intentionally not user-facing grammar)
