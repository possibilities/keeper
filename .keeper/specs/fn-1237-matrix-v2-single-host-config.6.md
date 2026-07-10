## Description

**Size:** S
**Files:** docs/install.md, docs/plugin-composition-map.md, docs/problem-codes.md, CONTEXT.md, CLAUDE.md, plugins/plan/CLAUDE.md

### Approach

Sweep every doc to describe only the v2 world, forward-facing (history already lives in ADR 0036 — no
tombstones, no "formerly"): install.md's host-matrix section inverts optional → required with the
copy-the-example activation flow, pruning the claude-only-default and byte-identical-fallback language and
every route:/native: mention; plugin-composition-map repoints its subagents.yaml references at matrix.yaml
(subagent_templates / subagent_models) and refreshes the ADR cross-link to 0036; problem-codes gets a
wording audit for surviving route:-era vocabulary (the new failure-code row landed with the daemon task).
CONTEXT.md glossary: add "Launch id"; add or sharpen subagent_models / subagent_templates entries; redefine
"Capability model" around basename derivation; reframe "Launch-only provider" (a roster model absent from
subagent_models — per-capability, not per-provider) or retire it; audit "Pecking order" and retire "Alias
target" in favor of the launch-id vocabulary. CLAUDE.md (root): the plugins bullet naming subagents.yaml as
the render source now names the host matrix, and the test-isolation bullet's sandboxed state classes go six
→ seven (KEEPER_CONFIG_DIR); plugins/plan/CLAUDE.md gets the same reference sweep. Keep
`bun scripts/lint-claude-md.ts` green.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- docs/install.md:59-95 — the optional-matrix walkthrough to invert
- docs/plugin-composition-map.md:79, 90, 107, 123 — the subagents.yaml references
- CONTEXT.md:34-39, 133 — Capability model / Pecking order / Alias target / Launch-only provider entries
- CLAUDE.md — the plugins render-source bullet and the "ALL SIX state classes" test-isolation bullet

**Optional** (reference as needed):
- docs/adr/0036-required-host-matrix-v2-with-launch-id-entries.md — the decision record the docs must agree with
- docs/problem-codes.md:89-145 — the table to wording-audit

### Risks

- Backward-facing phrasing sneaking in — every edit states the present-tense rule, never what it replaced

### Test notes

`bun scripts/lint-claude-md.ts` green; `rg -l 'subagents\.yaml|route: false|native:' docs CONTEXT.md CLAUDE.md plugins/plan/CLAUDE.md` hits only docs/adr/.

## Acceptance

- [ ] No documentation outside docs/adr/ references subagents.yaml, route:, or native: as a live surface
- [ ] install.md describes the required-matrix activation flow (copy the example) and the v2 keys
- [ ] CONTEXT.md defines the v2 vocabulary and carries no definition keyed to a retired mechanism
- [ ] The CLAUDE.md files state the host-matrix render source and the seven sandboxed state classes
- [ ] The CLAUDE.md size/style lint passes

## Done summary

## Evidence
