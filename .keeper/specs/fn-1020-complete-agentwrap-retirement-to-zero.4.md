## Description

**Size:** M
**Files:** src/agent/config.ts, test/config.test.ts, test/agent-self-invoke.test.ts, scripts/lint-retired-name.sh, scripts/frozen-allowlist.txt, test/lint-retired-name.test.ts, README.md, docs/plan-name-retirement.md (or a sibling)

### Approach

PRECONDITION: re-grep the tree (post fn-1018) and confirm the ONLY residual agentwrap is exactly this epic's surface — no stray `AGENTWRAP_SCHEMA_VERSION`/`AGENTWRAP_TMUX_EXIT`/`AGENTWRAP_HELP` etc. (those are fn-1018.2's); if any survive, surface before flipping the lint (don't silently absorb). Then: remove fn-1018.3's transitional `~/.config/agentwrap/` config fallback (read-old branch + warn line + its anchors), retire `legacyAgentwrapPresetsPath()` + `migrationHint` and rewire `loadPresetCatalog`/`loadPanelSelections` to drop the `legacyPath` param (keep config.ts dep-free — no db.ts import). DELETE the retired-alias DB-config tests (`agentwrap_path`/`KEEPER_AGENTWRAP_PATH`/`agentwrapPath` in test/config.test.ts + test/agent-self-invoke.test.ts) — this also clears the last `KEEPER_AGENTWRAP_PATH` token. Prune the README `~/.config/agentwrap/presets.yaml` migration-hint sentence. Prune the agentwrap survivors block (+ trim the present-tense header) in frozen-allowlist.txt, leaving the planctl records (incl. the src/db.ts count pin) intact. Flip scripts/lint-retired-name.sh to ZERO-TOLERANCE for agentwrap: a NEW repo-wide grep-clean check (parameterize away the hardcoded `planctl` token in Check B, or add a parallel check) asserting zero agentwrap with a DEFINED exclusion set (the guard's own files: lint-retired-name.sh + frozen-allowlist.txt; docs/*retirement*.md; .keeper/; and any kept lint-test fixtures), planctl's progressive checks unchanged. Rewrite test/lint-retired-name.test.ts (its agentwrap fixtures + the real-tree-passes assertion). Document the zero-survivor end-state (generalize docs/plan-name-retirement.md or a sibling doc), forward-facing.

### Investigation targets

**Required** (read before coding):
- src/agent/config.ts:~102 `legacyAgentwrapPresetsPath`, ~407 `migrationHint`, ~443/447/478/482 use sites; the fn-1018.3 fallback to remove
- test/config.test.ts + test/agent-self-invoke.test.ts — the retired-alias tests to delete
- scripts/lint-retired-name.sh — Check B's hardcoded `planctl`; add the zero-tolerance agentwrap mode + exclusion set
- scripts/frozen-allowlist.txt:~97-141 agentwrap block (prune); :71 planctl src/db.ts count pin (KEEP)
- test/lint-retired-name.test.ts:~89-130 — agentwrap fixtures + real-tree assertion to rewrite
- README.md — the presets-hint sentence to prune
- docs/plan-name-retirement.md — the retirement-note template

### Risks

- Order LAST: the zero-tolerance flip must run after .1/.2/.3 (all agentwrap renamed/relocated) AND the config-fallback removal here — else it hard-fails. The precondition re-grep guards scope.
- Exclusion-set completeness: the grep pattern + the guard's own files + the retirement doc + `.keeper` + kept fixtures all legitimately contain agentwrap — a missing exclusion = a permanent false-positive.
- config.ts dep-free invariant: removing the helpers must not introduce a db.ts import (the cold-start import-graph guard).
- Keep planctl's records + progressive mode intact when reworking the allowlist + script.

### Test notes

`bash scripts/lint-retired-name.sh` exits 0 with zero-tolerance active; the rewritten lint test proves agentwrap is caught repo-wide (and the exclusion set passes). `git grep agentwrap` (minus the exclusion set) empty in keeper. `bun test` green.

## Acceptance

- [ ] config fallback + `legacyAgentwrapPresetsPath` + `migrationHint` removed; `loadPresetCatalog`/`loadPanelSelections` rewired; config.ts still dep-free
- [ ] retired-alias DB-config tests deleted (`KEEPER_AGENTWRAP_PATH` gone); README presets-hint pruned
- [ ] frozen-allowlist agentwrap block pruned; planctl records intact; lint flipped to zero-tolerance with a defined exclusion set; lint test rewritten
- [ ] retirement documented forward-facing; `git grep agentwrap` (minus exclusion set) empty in keeper + arthack; `bun test` + lint green

## Done summary

## Evidence
