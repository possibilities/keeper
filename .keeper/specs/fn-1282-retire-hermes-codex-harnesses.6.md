## Description

**Size:** S
**Files:** src/transcript/registry.ts, src/transcript/codex.ts, test/transcript-codex.test.ts, test/transcript-cli.test.ts

### Approach

Delete the Codex reader and registry entry while preserving the generic reader/model/render pipeline and Claude/Pi readers. Codex requests use ordinary unsupported-harness failure.

### Investigation targets

*Verify before relying — these refs move with the repo.*

**Required** (read before coding):
- `src/transcript/registry.ts:9` — Codex registration.
- `src/transcript/codex.ts:1` — reader to delete.
- `src/transcript/pi.ts:1` and `src/transcript/reader.ts` — retained implementation/seam.

**Optional** (reference as needed):
- `test/transcript-cli.test.ts` — registry-derived help assertions.

### Risks

The transcript registry is independent of launcher membership; delete only the Codex implementation.

### Test notes

Delete Codex reader tests, update help assertions, and retain Pi bounds/branch/filter coverage.

### Detailed phases

1. Remove registration/implementation/tests.
2. Update CLI membership expectations.
3. Run Claude/Pi transcript suites.

### Alternatives

A historical Codex reader is rejected.

### Non-functional targets

Existing byte, line, pagination, and output budgets remain unchanged.

### Rollout

No data migration; ambient Codex files become unsupported.

## Acceptance

- [ ] Registry contains only Claude/Pi.
- [ ] Codex transcript requests fail normally.
- [ ] Generic and Claude/Pi transcript behavior remains intact.

## Done summary

## Evidence
