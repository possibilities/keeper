## Description

**Size:** M
**Files:** src/db.ts, test/db.test.ts

### Approach

Introduce an ordered `SCHEMA_STEPS` array in src/db.ts — each entry
`{ version: number, kind: StepKind, apply(ctx): void }` — and re-express `migrate()`'s
interleaved middle section (the ~125 unguarded idempotent ALTERs and ~31 version-guarded
blocks) as entries applied in array order inside the SAME single transaction. The
behavioral contract is byte-equivalence: each entry's `apply` body is the existing block
MOVED VERBATIM, and the observable outcome is that a fresh `:memory:` migrate produces a
byte-identical schema (the pinned `SCHEMA_FINGERPRINT` must not change). Derive
`export const SCHEMA_VERSION` from the ladder tail (`SCHEMA_STEPS[SCHEMA_STEPS.length - 1].version`)
as a plain const binding of type `number` — never a getter or function (import sites across
tests and scripts consume the value).

`ctx` carries what the moved bodies already read: the `Database`, `preMigrateStoredVersion`,
and any helper the bodies use to RE-FETCH `meta.schema_version` mid-transaction. Guard
flavor preservation is the load-bearing constraint: some blocks guard on
`preMigrateStoredVersion < N`, some on re-fetched locals, and at least one deliberately
guards on a DIFFERENT N than its nominal version (the `< 63` block) — each body keeps its
exact read, unnormalized, with the guard INSIDE `apply`. Entries exist at version-boundary
granularity: every version from the ladder floor to the current SCHEMA_VERSION gets exactly
one entry; a historical version with no surviving body (a bare/whitelist-only bump) becomes
an explicit no-op entry (`kind: "noop"`) so the version set stays contiguous and derivable.

`StepKind` is a machine-readable discriminant the successor renumber tool keys its
additive-idempotency refusal on — classify conservatively: `"additive"` ONLY when the body
is purely addColumnIfMissing / CREATE ... IF NOT EXISTS-shaped; anything containing
dropColumnIfPresent, DELETE, UPDATE, a cursor rewind, a table rebuild, or a JS backfill is
`"rewind"` / `"backfill"` / `"drop"` as fits; `"noop"` for bare bumps. When in doubt,
classify non-additive.

Registry-EXTERNAL machinery stays exactly where it is, outside the step array: the pre-txn
downgrade throw, the `needsEventsRebuild` PRAGMA foreign_keys toggle (non-transactional
pragma), the always-run base CREATE block, the unconditional `meta` version stamp at the
txn tail, the `finally` pragma restore, and the post-commit chunked backfill. Only the
interleaved middle section becomes entries.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/db.ts:2606-2661 — pre-txn reads, downgrade throw, FK toggle (stays external)
- src/db.ts:2663-2739 — always-run base CREATE block (stays external)
- src/db.ts:2824, 2906, 2926, 2952, 2980 — the guard-flavor variants (re-fetched locals; the deliberate `< 63`-not-`< 13` guard)
- src/db.ts:6319-6358 — the newest REWINDING block (canonical non-additive entry)
- src/db.ts:6360-6372 — meta stamp + finally FK restore (stay external)
- src/db.ts:76-89 — computeSchemaFingerprint (the byte-stability oracle)
- test/db.test.ts fingerprint recompute test + the fresh-vs-migrated tail tests (tailOf helper) — every one must pass UNMODIFIED

**Optional** (reference as needed):
- src/db.ts:6377-6379 — post-commit backfillResolvedEpicDeps (stays external, guarded `< 34`)
- scripts/emit-schema-fixture.ts — the downstream DDL dump the sitter repo pins

### Risks

- Normalizing a guard's version source (pre-txn snapshot vs mid-txn re-fetch) silently changes behavior in ways the fingerprint CANNOT catch (same value today) — bodies move verbatim, no cleanup.
- Reordering any two ALTERs moves SQLite's stored CREATE text column order → fingerprint moves → sitter fixture drifts. Array order must reproduce today's exact execution order.
- A `Math.max(...)`-style derivation spread over the array is fine for value semantics but the tail-entry read is cheaper and keeps the "last entry IS the version" invariant obvious.

### Test notes

The pinned SCHEMA_FINGERPRINT not changing IS the proof of byte-equivalence — do not re-pin
it in this task. Run the full fast suite; the fresh-vs-migrated tail tests and the
fingerprint recompute test are the acceptance oracles, unmodified.

### Detailed phases

1. Define `StepKind` + the entry interface + `SCHEMA_STEPS: readonly Step[]`.
2. Move the middle section body-by-body into entries, in exact source order, classifying `kind` per body.
3. Replace the inline section with the `for (const step of SCHEMA_STEPS) step.apply(ctx)` drive.
4. Derive `SCHEMA_VERSION` from the tail entry; delete the hand-typed literal.
5. Full suite + typecheck + lint; verify the fingerprint test passes without any re-pin.

### Alternatives

- One entry per ALTER (~150 entries): rejected — version-boundary granularity matches how
  bumps are authored and reviewed, and keeps entry count ~= version count.

### Non-functional targets

- Boot-time migrate cost unchanged (same statements, same order, one transaction).

### Rollout

Lands as one commit with zero schema movement; revert-safe.

## Acceptance

- [ ] `SCHEMA_STEPS` exists with explicit per-entry versions and a `kind` discriminant on every entry
- [ ] `SCHEMA_VERSION` is derived from the ladder tail as a plain exported const of type number; no hand-typed version literal remains
- [ ] `SCHEMA_FINGERPRINT` constant is byte-unchanged and its recompute test passes without re-pinning
- [ ] Every pre-existing fresh-vs-migrated identity test and the full fast suite pass unmodified
- [ ] Every historical version maps to exactly one entry (no-op entries fill bare bumps); the ladder floor and any discovered irregularities are documented in the Done summary

## Done summary

## Evidence
