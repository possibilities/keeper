## Description

**Size:** M
**Files:** src/pair/panel.ts, src/agent/config.ts, test/pair-panel.test.ts, test/agent-config.test.ts

### Approach

panel.yaml members become triples: the loader parses each member with the shared grammar, keeps the fail-loud posture (malformed member or missing file throws), and keeps the panel-eligibility predicate exactly aligned between load and launch (panels remain claude/codex/pi — an axisless-capturable harness stays excluded as today). Duplicate identical triples are legal and become distinct legs via a 1-based ordinal suffix in declaration order; member identity for resolution, attribution, and the judge label is the raw triple plus ordinal. Leg names and per-leg state files derive from the slugified triple (shared slugifier + hash-suffix) so two DISTINCT triples that slugify identically also get disambiguated — never share a tmux name or output path. The leg-name scheme keeps its existing prefix shape with the member slot carrying the slugified member, and the resolve envelope for a panel lists members as raw triples with ordinals so the runner and judge attribute stably.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/pair/panel.ts:308 resolvePanelMembers, :398 resolveAdHocMember, :494 buildPanelLegArgv, :537 leg-name construction, :1112 panel state dir layout
- src/agent/config.ts:588-652 loadPanelSelections + capturable gate + default pointer
- test/pair-panel.test.ts — member resolution and leg argv expectations

**Optional** (reference as needed):
- src/slug.ts — the slugifier + length cap the leg slot must respect
- src/agent/main.ts presets resolve panel branch — envelope shape for panel deref

### Risks

- Ordinals are positional: editing panel.yaml mid-flight changes labels between runs — acceptable (runs are ephemeral) but the judge label must be minted per run, never persisted across config edits
- The x-preset value forwarded to each detached leg must be the raw triple; only display surfaces take the slug

### Test notes

Fixtures: a panel with the same triple twice (two legs, ordinal labels, distinct state paths), two distinct triples engineered to slugify identically (hash-suffix keeps paths distinct), a malformed member (loud throw), the default pointer, and an excluded-harness member (loud reject). Assert leg argv carries the raw triple and the state filenames carry the disambiguated slug.

## Acceptance

- [ ] A panel may list the same triple more than once and every leg launches with a distinct ordinal-bearing identity, distinct tmux-safe name, and distinct output path
- [ ] Two distinct members can never collide on a leg name or state file path, even when their slugs coincide
- [ ] Malformed members, unknown panels, and non-panel-eligible harnesses fail loud at load with the member named
- [ ] Panel resolution output identifies members by raw triple plus ordinal

## Done summary

## Evidence
