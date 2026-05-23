## Description

**Size:** S
**Files:** src/protocol.ts, src/server-worker.ts, test/server-worker.test.ts

### Approach

Extend `FilterValue` at `src/protocol.ts:96` from `string | number | { ne: string | number }` to also accept `{ not_in: (string | number)[] }` and `{ in: (string | number)[] }` (both, for completeness — defaultFilter only uses `not_in`, but `in` is the natural complement). In `src/server-worker.ts` resolveFilter (around lines 288-322), add the two operator branches; mirror the existing `{ne}` pattern. Unknown-operator forward-compat behavior already silently ignores unrecognized keys per the comment at ~309-313 — preserve that.

### Investigation targets

**Required** (read before coding):
- `src/protocol.ts:96` — FilterValue type
- `src/server-worker.ts:288-322` — `resolveFilter` operator dispatch
- `src/server-worker.ts:309-313` — forward-compat comment on unrecognized keys

**Optional**:
- `test/server-worker.test.ts` — existing filter resolution tests (grep for `{ne}`)

### Risks

Wire-protocol additions are forward-compatible by construction. No migration. Degenerate cases worth a test: `{not_in: []}` should match everything; `{in: []}` should match nothing.

### Test notes

Add tests for `{ not_in: [...] }` and `{ in: [...] }` against the jobs collection; verify resulting SQL shape; verify both empty-list edges. No regression in existing `{ne}` / equality tests.

## Acceptance

- [ ] `FilterValue` type accepts `{ in: ... }` and `{ not_in: ... }`
- [ ] `resolveFilter` handles both, mirroring the `{ne}` pattern
- [ ] Tests cover both operators including empty-list edges
- [ ] No regression in existing `{ne}` / equality tests

## Done summary

## Evidence
