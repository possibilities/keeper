## Description

**Size:** S
**Files:** README.md, CLAUDE.md, .planctl/specs/fn-702-restore-previous-session-two-tier.md

Update the system map and invariants to the new model now that the freeze/snapshot machinery is gone. Forward-facing prose only — state current behavior, not what it replaced.

### Approach

Rewrite the README ninth-worker restore-snapshot block (~2348-2405) to describe read-time DB derivation + `close_kind` + `window_index` + resume-by-UUID + restore.json-as-disaster-fallback. Trim the env-var/test-isolation two-tier summary (~522-535) to one sentence. Add `close_kind` to the exit-watcher paragraph (~2156-2185). Add the two `SUPPORTED_SCHEMA_VERSIONS` bump entries and the two new jobs columns to the Architecture schema history (matching the existing entry pattern; NO DaemonBoot — boundary detection was dropped). Prune the CLAUDE.md sole-writer restore-worker claim (~67-70), keeping the `KEEPER_RESTORE_FILE` fallback reference. Add a "superseded by this epic" note to fn-702's spec.

### Investigation targets

**Required** (read before coding):
- README.md ~2348-2405 (ninth-worker), ~2156-2185 (exit-watcher), ~522-535 (env-var), Architecture schema-version history section
- CLAUDE.md ~60-70 (writes-tightly-scoped / sole-writer)
- .planctl/specs/fn-702-restore-previous-session-two-tier.md:49-51 (the now-undone doc obligations)

### Test notes

Docs-only; no test impact. Verify line ranges against the live files (README has grown — use the ranges as search anchors, not guarantees).

## Acceptance

- [ ] README ninth-worker block rewritten to the DB-derived model; env-var + exit-watcher paragraphs updated; Architecture lists the two new columns + schema bumps.
- [ ] CLAUDE.md sole-writer restore-worker claim pruned; KEEPER_RESTORE_FILE fallback note retained.
- [ ] fn-702 spec marked superseded.
- [ ] No stale references to last_session / collapse-freeze / boot-promote / two-tier remain in README or CLAUDE.md.

## Done summary

## Evidence
