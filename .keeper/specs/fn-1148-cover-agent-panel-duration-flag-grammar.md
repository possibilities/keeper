## Overview

The agent-panel `--timeout` and `--chunk` flags now route through the shared
`cli/duration.ts` unit-required grammar, but the central shipped behavior — a
bare unitless value rejected with exit 2 and the self-healing "needs a unit"
hint — has no direct test, and `--timeout` has no CLI-level coverage at all.
This adds the missing assertions so a future re-loosening back to `Number()`
fails CI instead of shipping silently.

## Acceptance

- [ ] A unitless `--chunk` value exits 2 with the self-healing unit hint on stderr
- [ ] A unitless `--timeout` value exits 2 with the self-healing unit hint on stderr
- [ ] A `--timeout <dur>` happy path asserts the accepted unit maps to the correct stop-timeout

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | test/agent-panel-cli.test.ts @131b9872 has zero --timeout cases and no direct unitless-rejection assertion (only 540s/9999s suffix edits); the epic's core acceptance is unasserted. |

## Out of scope

- The grammar itself (`cli/duration.ts` parseDuration) — already covered by its own suite; this task asserts only the panel-flag wiring.
- Any behavior change to the flags — the shipped parsing is correct; this is coverage-only.
