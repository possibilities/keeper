## Description

**Size:** M
**Files:** src/builds-worker.ts, cli/builds.ts, test/builds-worker.test.ts, test/builds.test.ts

### Approach

Make a registered-but-never-built builder visible as a distinct `never
built` row. Producer + render only — NO schema migration (CREATE_BUILDS
columns are already nullable), NO change to projectBuildsRow /
extractBuildSnapshot (they fold all-null fields cleanly), NO SCHEMA_VERSION
bump.

- Worker (src/builds-worker.ts): in `parseLatestBuild`, the branch that
  today returns null for a parsed empty list (lines 202-203) instead returns
  an all-null-build-fields `BuildSnapshotMessage` carrying `builder_id`
  (from the enumeration) and a CONSTANT sentinel `state_string` (e.g.
  "never built"). The trigger is EXACTLY `Array.isArray(arr) && arr.length
  === 0` — every other null-producing shape (`{}`, non-object body, missing
  or non-array `builds`, array-of-non-objects) MUST keep returning null. The
  per-builder fetch-failure path (`buildsBody === null` in `runPollCycle`,
  ~line 414) sits BEFORE `parseLatestBuild` and MUST stay silent — do not
  move placeholder logic there; the two `null` sources must never be
  conflated (a transient fetch failure must never mint a placeholder).
- Gate/restart: `buildsGateKey` (135-143) already excludes `state_string`
  and `builder_id`, so the all-null placeholder gate key is stable and emits
  exactly once; when the builder later runs, `build_number` changes and the
  real snapshot emits. `seedFromDb` (319-352) must reseed the placeholder
  row to the SAME gate key `applySnapshot` computes, or it re-emits on every
  boot — pin this with a test.
- Viewer (cli/builds.ts): add a `NEVER_BUILT` Status const (near 73-89,
  following the RESULT_STATUS const-table idiom) with label `never built`
  and an ASCII-safe glyph distinct from `~` (running), `?` (unknown), `-`
  (skipped). In `resolveStatus` (97-105) return it for `build_number == null`
  BEFORE the existing RUNNING check (`results == null && !complete`), else a
  placeholder collapses into RUNNING. `renderRow` already renders `#?` for a
  null build number — composes with the fn-891.5 job-type tag automatically.
- Docs (forward-facing): rewrite the `parseLatestBuild` JSDoc (185-191), the
  `resolveStatus` JSDoc (92-95), and the HELP/file-JSDoc status enumeration +
  the stale "empty table means no builds yet" prose to state the `never
  built` state as current truth.

### Investigation targets

**Required** (read before coding):
- src/builds-worker.ts:193-238 (parseLatestBuild — the suppression site), ~414-428 (runPollCycle: the fetch-failure `null` vs parsed-empty-array `null` split), 135-143 (buildsGateKey — what's in/out of the key), 277-285 (applySnapshot adds to `seen` then gates), 295-305 (reconcileEnumeration — never-built is present in enumeration, never tombstoned), 319-352 (seedFromDb reseed)
- cli/builds.ts:73-89 (Status consts + RESULT_STATUS), 97-105 (resolveStatus branch order), 163-187 (renderRow null-safety)
- src/reducer.ts:3283-3293 (serializeBuildSnapshot — the placeholder must round-trip through this; an all-null payload serializes NON-empty so extractBuildSnapshot at 3302+ folds it fine — confirm no change needed), 3368-3405 (projectBuildsRow UPSERT — confirm no non-null assumption)
- src/db.ts:1042-1055 (CREATE_BUILDS — confirm all build columns nullable; do NOT bump SCHEMA_VERSION / touch keeper/api.py)

### Risks

- CONFLATION HAZARD (keystone): emitting a placeholder from the fetch-failure path (or from a malformed `{}` body) would flap pending↔real or spawn phantom rows. The trigger must be strictly the parsed empty array; all other shapes stay null. Pin with tests for `{}`, `{builds:["nope"]}`, and a fetch failure.
- Re-fold byte-identity (hard invariant): the placeholder payload must be deterministic (all-null build fields + constant sentinel + builder_id; updated_at = event.ts). No wall-clock/env in the fold. Keep the change producer + render only.
- seedFromDb must reseed the exact gate key or the worker re-emits a BuildSnapshot for every never-built builder on each boot.

### Test notes

test/builds-worker.test.ts: the existing "returns null for never-built" assertion (~127-132) FLIPS to assert a placeholder message; add (a) gate-stability (placeholder emits once, dedupes on repeat polls), (b) a per-builder fetch failure stays silent (no placeholder), (c) malformed bodies (`{}`, `{builds:["nope"]}`) stay null, (d) seedFromDb round-trips an all-null placeholder row without re-emitting. test/builds.test.ts: a `build_number:null` row renders as `never built`, distinct from RUNNING/SUCCESS/etc (mirror the `new Set(lines).size` distinctness assertion). Run `bun run test:full`.

## Acceptance

- [ ] `parseLatestBuild` emits an all-null placeholder (carrying builder_id + a constant sentinel state_string) ONLY for a parsed `{"builds":[]}`; `{}`, non-object, missing/non-array `builds`, and array-of-non-objects all still return null
- [ ] a per-builder fetch failure stays silent (no placeholder, gate preserved) — never conflated with the empty-array case
- [ ] the placeholder gate key is stable (emits once) and seedFromDb reseeds the same key (no re-emit on boot)
- [ ] `resolveStatus` returns `NEVER_BUILT` for `build_number == null` BEFORE the RUNNING check; glyph is ASCII-safe and distinct from running/unknown/skipped; label is `never built`
- [ ] no schema migration, no SCHEMA_VERSION bump, no change to projectBuildsRow/extractBuildSnapshot (producer + render only); re-fold stays byte-identical
- [ ] HELP + JSDoc revised (stale "empty table" prose + status enumeration), forward-facing
- [ ] `bun run test:full` passes

## Done summary

## Evidence
