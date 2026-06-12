## Description

**Size:** M
**Files:** src/yaml_input.ts (new), src/ids.ts, src/store.ts or src/flock.ts (fail-soft epic-id lock helper), src/emit.ts, src/repo_inference.ts (new), src/config.ts, package.json, test/ additions

### Approach

The early proof point. yaml_input.ts: one input wrapper matching pyyaml safe_load on the ordinal-1 matrix — eemeli yaml with YAML 1.1 schema and duplicate-key last-wins; documented fallback is a coercion shim over js-yaml if the matrix fixtures disagree; config.ts loadRoots moves onto the wrapper (parser unity — all bun YAML input parses one way). Bounded stdin reader: chunked accumulation off Bun.stdin.stream(), reject at 1 MiB + 1 with the byte-count message shape, TTY rejection, concat once. ids.ts gains scanMaxEpicId (scans BOTH epics/*.json and specs/fn-*.md — the orphan-spec invariant), scanMaxTaskId, slugify, generateSuffix. expandPath in repo_inference.ts THROWS on unresolvable ~ (distinct from resolveUserPath — both survive). The epic-id flock helper: blocking LOCK_EX on the same lock path Python uses, FAIL-SOFT acquire (any OSError → proceed unlocked; never route through flockOrThrow), unlock+close in finally. checkGlobalNameUnique. The accumulate-all failure emit: one compact line {"success":false,"error":{"code","message","details":[strings]}} + exit 1, bypassing the invocation builder — a sibling of the landed emit paths, not a modification of them. bun:test units: the matrix fixtures parsed through the wrapper byte-compare against the pinned Python outcomes; the cross-engine epic-id race harness (N python3 + N bun workers minting under the shared lock, assert no duplicates + contiguous); fail-soft lock behavior on an unwritable state dir.

### Investigation targets

**Required** (read before coding):
- tests/test_creation_verbs.py + the matrix fixtures — the arbiter
- planctl/run_epic_create.py:21-75 — _epic_id_lock fail-soft + checkGlobalNameUnique
- planctl/ids.py:27-157 — slugify/suffix/scan helpers
- planctl/repo_inference.py — expandPath throw semantics
- src/flock.ts + src/emit.ts — landed seams being extended, not forked

### Risks

The wrapper is the wave's hinge — if eemeli-1.1 misses any matrix case, switch to the shim fallback early rather than patching divergences one-off. The fail-soft lock must never turn a permissions error into a hard failure.

### Test notes

bun test green incl. matrix + race harness; lint/typecheck green; no Python file touched.

## Acceptance

- [ ] Wrapper matches the pinned matrix on all five classes; config.ts unified onto it
- [ ] Epic-id lock interops with Python in the race harness; fail-soft proven
- [ ] scanMaxEpicId honors the orphan-spec invariant; accumulate-all emit path lands

## Done summary
Added the bun creation-spine machinery: eemeli-1.1 pyyaml-parity YAML input wrapper (matches the full scalar matrix) with config.loadRoots unified onto it, bounded 1 MiB stdin/file reader, slugify/scanMaxEpicId(orphan-spec dual scan)/scanMaxTaskId, throwing expandPath, fail-soft global epic-id lock proven interop-clean against Python in a cross-engine race harness, checkGlobalNameUnique, and the accumulate-all failure emit path.
## Evidence
