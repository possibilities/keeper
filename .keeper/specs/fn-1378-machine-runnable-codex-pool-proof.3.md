## Description

**Size:** S
**Files:** scripts/lint-source.ts, test/lint-source.test.ts

### Approach

Extend the source linter with an import-graph gate: resolve the
transitive module graph of every pi-extension entry (integrations/pi-*/src/**
plus the shared dep-free leafs they import from src/) and fail when any
path reaches a bun: builtin. The rule converts a discipline guardrail
into a failing gate — a bun-reaching import previously killed every pi
leg at extension load with no lint coverage. Keep the walk cheap and
deterministic (static import parsing, no execution).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- scripts/lint-source.ts — the existing linter structure and how rules report
- src/codex-pool-proof-window.ts — the canonical dep-free shared leaf (its header states the constraint)
- integrations/pi-codex-pool/src/ — the primary graph under the gate

### Risks

- Type-only imports must not trip the gate; dynamic import() strings should be flagged conservatively rather than executed

### Test notes

Fixture test: a temporary module chain reaching bun:sqlite fails; the
live tree passes; a type-only bun import does not trip.

## Acceptance

- [ ] The linter fails when any pi-extension transitive import graph reaches a bun builtin
- [ ] The current tree passes the gate
- [ ] The gate runs inside the standard lint invocation commit-work executes

## Done summary

## Evidence
