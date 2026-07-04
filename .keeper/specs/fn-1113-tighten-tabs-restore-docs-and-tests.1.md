## Description

Findings F1 (kept) and F2 (merged-into-F1). Commit 683d9c04 bounded
`loadEnrichedGenerations` (src/restore-set.ts:810) to the current generation
plus the newest RECENT_GENERATION_BOUND dead ones, but the user-facing
strings still describe the pre-bound behavior:

- cli/tabs.ts:94 (HELP_LIST) — "every observed tmux-server generation ranked
  newest-first" now over-promises; the enriched list omits generations past
  the newest K dead.
- src/tabs-core.ts:592-597 (`loadGenerationList` / `TabsListPayload` doc) —
  "enrich every generation" describes the unbounded scan.
- cli/tabs.ts:116 (F2) — the `--generation <id>` help ("Restore a specific
  generation instead of the auto-pick") does not mention that the override
  cannot reach a generation older than the newest K dead.

Update all three strings to describe the bounded window (current +
RECENT_GENERATION_BOUND dead). Docs-only; no behavior change.

## Acceptance

- [ ] HELP_LIST and the TabsListPayload doc describe the bounded window,
  not an exhaustive list
- [ ] The `--generation` help notes it cannot reach a generation past the
  decode bound
- [ ] `bun test` green

## Done summary
Updated tabs list/restore help + TabsListPayload/loadGenerationList docs to describe the bounded decode window (current + RECENT_GENERATION_BOUND dead), and noted --generation cannot reach an id past the bound. Docs-only.
## Evidence
