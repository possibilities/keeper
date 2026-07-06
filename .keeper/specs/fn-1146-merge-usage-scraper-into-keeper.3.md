## Description

**Size:** M
**Files:** src/db.ts, src/usage-scraper-worker.ts, src/usage-picker.ts, cli/usage.ts, test/db.test.ts, test/usage-scraper-worker.test.ts, test/usage-picker.test.ts, test/usage.test.ts

### Approach

Introduce one keeper-config map, `usage_models`, as the single declaration of
which models exist to scrape and how they display:
`usage_models: { <envelope-id>: <alias or null>, ... }`. Keys must pass the
envelope-id shape (`^[a-z0-9-]+$`); the id `codex` selects the codex target,
every other id is a claude profile; values are optional display aliases
(null/absent renders the raw id). Parsing is fail-open per keeper config
convention: malformed shapes fold to an empty map. This ONE key replaces
three surfaces: (1) `buildAccounts` derives the account set from the declared
registry — claude entry per non-codex id with the multiplier still
tier-derived from the profile's own state, codex appended only when declared,
empty registry means the worker idles; the external
`~/.config/agentusage/config.yaml` read (`loadProfileNames`) deletes. (2) The
picker's `listProfiles` returns the declared claude ids from the same
registry — its own yaml file read deletes; no keeper code reads the external
config path afterwards. (3) `account_aliases` retires: the TUI's alias lookup
derives from `usage_models` values, and the old key is no longer parsed
(lingering copies ignored). Watch the import graph: `resolveConfig` lives in
the DB module — if any current `listProfiles` importer is deliberately
db-free on its cold-start path, thread the declared list in as a parameter
there rather than adding a heavy import.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/usage-scraper-worker.ts:186-222 (loadProfileNames — deletes), :332-357 (buildAccounts — re-sources), :411 (pinned path filter, untouched)
- src/usage-picker.ts:111-180 (configPath/parseYaml/listProfiles — re-sources) and every listProfiles/pickProfile importer (import-graph check for db-free cold-start paths)
- src/db.ts:218, :359, :472-480 (accountAliases field + parse — replace with the usage_models parse), :587+ neighborhood for where the new parse arm lands
- cli/usage.ts:166 (alias resolver), :845 (resolveConfig().accountAliases consumption)
- src/claude-tier.ts resolveTierMultiplier — unchanged multiplier source, confirm the id→profile threading survives

**Optional** (reference as needed):
- test/usage-picker.test.ts, test/usage-scraper-worker.test.ts — existing fixtures for profile lists and account building to re-shape

### Risks

- Cold-start regression if a db-free importer of the picker gains a transitive DB-module import — resolve via parameter threading, not import.
- Behavior change on unconfigured machines: absent registry now means idle (previously codex was always scraped) — intended, but tests asserting the codex-append must flip.

### Test notes

Table-drive the parse (valid map / bad id / non-string alias / non-record →
fold behavior); assert buildAccounts against declared sets including
codex-absent and empty; assert the TUI alias rendering path from the unified
key; picker tests re-source their profile fixtures.

## Acceptance

- [ ] One config map declares the scraped model set and aliases; parsing is fail-open and id-validated
- [ ] The scrape account set equals the declared registry exactly — codex only when declared, idle on an empty declaration, multipliers still tier-derived
- [ ] No keeper source reads the external agentusage config file; the picker balances over the declared claude ids
- [ ] Usage TUI aliases render from the unified key; the old alias key is no longer parsed and lingering copies are harmless
- [ ] Full fast suite green

## Done summary

## Evidence
