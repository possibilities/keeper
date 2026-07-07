## Description

**Size:** S
**Files:** README.md, CONTEXT.md, docs/adr/0009-tmux-owned-usage-scrape-driver.md

### Approach

Bring the three doc surfaces truthful to the merged state, forward-facing
only. README: the third-party runtime-dep claim now covers the Temporal
polyfill alongside the watcher; the producer-roster label reflects the
merged scraper; the config prose points at the `usage_models` registry
instead of the deleted runtime keys — revise in place, prune rather than
append. CONTEXT.md gains two glossary-genre entries: the usage-model
registry (the declared scrape set + alias map) and `agentusage` as the
frozen on-disk namespace (state root, tmux socket, path-filter token) that
survives the retired external project. Port the tmux-owns-the-PTY driver
rationale out of the source repo's ADR into keeper's `docs/adr/` under the
next free number (0009) so the decision record survives the archive —
ADR genre carries the decision and its trade-offs; the module headers keep
only present-tense invariants.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- README.md:44 (dep claim), :59 (producer roster), :80 (config prose)
- ~/code/agentusage/docs/ — the tmux-driver ADR to port (source repo still present; this task runs before any archive move)
- CONTEXT.md — glossary genre: 1-2 sentence definitions + Avoid lines, zero implementation detail
- docs/adr/ — numbering and MADR-ish shape; two files already share prefixes 0007/0008, take 0009

**Optional** (reference as needed):
- scripts/lint-claude-md.ts — the doc gate that must stay green

### Risks

- Genre bleed: decision rationale belongs only in the ADR; CONTEXT.md stays pure glossary; README stays lean front door.

### Test notes

Doc lint green; grep proves no README/CONTEXT reference to the external
project directory or the deleted config keys remains.

## Acceptance

- [ ] README's dependency, producer-roster, and config statements are accurate for the merged state with no reference to the deleted keys or external project
- [ ] CONTEXT.md defines the usage-model registry and the frozen agentusage namespace in glossary genre
- [ ] The tmux-driver decision record exists in keeper's ADR directory under the next free number
- [ ] Doc lints pass

## Done summary
Truthed up README (Temporal-polyfill dep, usage_models config pointer) and CONTEXT.md (usage-model registry + agentusage-namespace glossary entries), and ported the tmux-owns-the-PTY driver decision into docs/adr/0009.
## Evidence
