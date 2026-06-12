## Description

**Size:** M
**Files:** src/integrity.ts (new), src/validation_restamp.ts (new), test/ additions

### Approach

The early proof point. integrity.ts ports _check_epic_tree as one linear check with the exact error/warning string catalog — every interpolation byte-matched against the golden corpus, including Python repr quoting for the repo warnings (single-quoted, escaped) and the two distinct path-comparison semantics: samefile (dev+ino equality) for the primary_repo mis-location check, resolved-string compare for target_repo coverage. Public wrappers validateEpicIntegrity and validateEpicIntegrityWithWarnings; the check_filesystem_repos toggle wired through (set-*-repo callers pass false, validate passes true). Reuse specs.ts validateTaskSpecHeadings — never fork the heading check. validation_restamp.ts ports VALIDATION_RESTAMP_VERBS and restampEpicOrFail: load on-disk tree, extend the epic universe via discoverProjects + scanEpicIdsGlobal with fail-soft catch → empty map, run the check, on errors print the integrity_failed compact envelope (message exactly "<verb> on <epic_id> produced an invalid epic tree; last_validated_at NOT re-stamped") and exit 1 leaving the structural write on disk, else return nowIso(). Expose the shared runSetter pipeline (load → gate → per-verb validate → apply/write → restamp → stamp-write → emitMutating) with hooks for the two special cases: a pre-restamp hook (set-target-repo's touched_repos recompute) and a rollback handler (add-dep's prior-state restore on introduced cycles). bun:test units against fixture trees mirroring the golden corpus cases.

### Investigation targets

**Required** (read before coding):
- planctl/integrity.py — the full check inventory and string catalog
- planctl/validation_restamp.py — helper mechanics, fail-soft discovery, failure envelope
- tests/fixtures/golden/ — the captured catalog from ordinal 1
- src/specs.ts:98 validateTaskSpecHeadings — the reusable heading check

**Optional** (reference as needed):
- planctl/run_validate.py — how the wrappers are consumed
- src/flock.ts — reset's task lock (task-scoped only; there is no epic-id lock in this wave)

### Risks

String parity across ~15 templates is the whole game — work from the golden corpus, not from reading the Python source alone. The samefile check needs dev+ino stat comparison in Bun; a string-compare shortcut diverges on symlinked repos.

### Test notes

bun units green incl. a fail-forward case proving the structural write survives a failed restamp; lint/typecheck green.

## Acceptance

- [ ] Integrity catalog byte-matches the golden corpus; both path-comparison semantics reproduced; toggle wired
- [ ] restampEpicOrFail fail-forward semantics exact; runSetter pipeline with the two hooks exposed
- [ ] No fork of the spec-heading check

## Done summary
Ported the integrity catalog (checkEpicTree, both path-comparison semantics, checkFilesystemRepos toggle) and the restamp pipeline (restampEpicOrFail fail-forward + runSetter with pre-restamp and rollback hooks) to planctl-bun, with bun units catalog-byte-matched against the Python check.
## Evidence
