## Description

**Size:** S
**Files:** src/epic-deps.ts (new), src/readiness.ts, scripts/board.ts

### Approach

Extract the cross-epic dependency resolver into a new leaf module
`src/epic-deps.ts` so it can be imported by BOTH `src/readiness.ts` and (in
task .3) `src/reducer.ts` without an import cycle. Move `resolveEpicDep`,
`EpicDepResolution`, `epicIsCompleted`, `projectBasename`, and
`BARE_FN_PATTERN` out of `readiness.ts` into `epic-deps.ts`; import them back
where `readiness.ts` and `board.ts` use them. The new module must NOT import
`readiness.ts` or `reducer.ts` (leaf only — types from `src/types.ts` are fine).

Make the resolver fold-safe: the ambiguity-diagnostic at readiness.ts:1105
calls `new Date().toISOString()` inline, which cannot run inside the reducer
fold (breaks re-fold determinism). Change `resolveEpicDep` so the timestamp is
injected (a `now: string` param or an optional clock) — callers that want
diagnostics pass a real timestamp; the future reducer caller passes a value
derived from the event (or a no-op diagnostics sink). ZERO behavior change for
existing callers — `readiness.ts` and `board.ts` produce identical output.

Note `projectBasename` is currently duplicated in readiness.ts:975 and
board.ts — collapse both onto the new module's single copy.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:975-1128 — `projectBasename`, `epicIsCompleted`, `EpicDepResolution`, `resolveEpicDep`, `BARE_FN_PATTERN`, and the `new Date()` diagnostic at :1105
- scripts/board.ts:84 (import), :778 (resolveEpicDep call), and its local `projectBasename` copy
- src/types.ts — the `Epic` type the resolver depends on

**Optional**:
- src/readiness.ts:524-597 — predicate 9 caller (stays put; just re-imports)

### Risks

- Import cycle if the new module reaches back into readiness/reducer — keep it a pure leaf.
- The injected-timestamp signature change rippling to every `resolveEpicDep` call site — audit all callers.

### Test notes

- Existing test/readiness.test.ts + test/board.test.ts pass UNCHANGED (proves zero behavior change).
- Add a unit test that `resolveEpicDep` with an injected timestamp is deterministic (same inputs produce same diagnostics, no wall-clock).

## Acceptance

- [ ] `src/epic-deps.ts` holds `resolveEpicDep`, `EpicDepResolution`, `epicIsCompleted`, `projectBasename`, `BARE_FN_PATTERN`; imports nothing from readiness/reducer.
- [ ] The ambiguity-diagnostic timestamp is injected, not read from `new Date()` inside the resolver.
- [ ] `readiness.ts` and `board.ts` import from the new module; the duplicated `projectBasename` is collapsed to one copy.
- [ ] All existing readiness + board tests pass with no assertion changes.

## Done summary

## Evidence
