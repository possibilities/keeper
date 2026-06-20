## Description

**Size:** M
**Files:** test/live-shell.test.ts, test/ansi-to-styled.test.ts, bunfig.toml (new) or package.json test script, a new shared test preload module

### Approach

`@opentui/core`'s native loader does a top-level `await import` of
`@opentui/core-${platform}-${arch}` then reads `nativePackage.default`
(zig.ts:67-68). Under `bun test --isolate` (fresh global, same process),
when a SECOND test file cold-loads `@opentui`, the re-entrant/circular
evaluation hits `ReferenceError: Cannot access 'default' before
initialization`. Two test files load it at runtime
(test/live-shell.test.ts, test/ansi-to-styled.test.ts); together they
trip it; each passes alone (live-shell 17/0). Verified non-fixes:
@opentui/core 0.3.1, and `--parallel`. PRIMARY approach: add a shared
preload module wired via bunfig.toml `[test] preload` (or the test
script's `--preload`) that forces `await import("@opentui/core")` (and
`@opentui/core/testing`) to fully resolve ONCE per process before any test
file's fresh-global reset, so the native TLA never re-enters
mid-evaluation. FALLBACK if preload does not hold: consolidate the two
@opentui-touching test files into one file (one cold load per process),
or split them into a dedicated serialized `bun test` invocation. This is
the keystone task — the fallback is the safety net.

### Investigation targets

**Required** (read before coding):
- test/live-shell.test.ts:30-40 — runtime @opentui imports (RGBA, ScrollBoxRenderable, StyledText, TextAttributes, TextRenderable, createTestRenderer)
- test/ansi-to-styled.test.ts — the other runtime @opentui importer
- src/live-shell.ts:69-94 — existing type-only + deferred `await import` mitigation and its docstring (the pattern to mirror)

**Optional** (reference as needed):
- node_modules/.pnpm/@opentui+core@0.3.0_*/node_modules/@opentui/core — built loader (sourcemaps to src/zig.ts:67-68)
- package.json test script — where to wire `--preload` if not using bunfig.toml

### Risks

- Upstream bug: a preload may not fully prevent re-entry if bun resets module state per fresh-global even for preloaded modules — verify empirically before committing to it.
- bunfig `[test] preload` applies to ALL test files (adds @opentui load cost to every file's process). Measure suite-time impact; if material, prefer the consolidation fallback.
- The fix is uncertain — keystone-plus-fallback; do not over-invest in the preload before proving it holds.

### Test notes

Minimal repro `bun test --isolate test/ansi-to-styled.test.ts test/live-shell.test.ts` must go green (was 0 pass / 2 fail / 2 errors). Full `bun test --isolate` run shows 0 "errors" and 0 "Cannot access 'default'" occurrences across ~5 repeated runs.

## Acceptance

- [ ] `bun test --isolate test/ansi-to-styled.test.ts test/live-shell.test.ts` passes with 0 errors
- [ ] Full `bun test --isolate` shows 0 "Cannot access 'default'" occurrences across 5 runs
- [ ] test/live-shell.test.ts and test/ansi-to-styled.test.ts still pass when run alone
- [ ] A minimal upstream repro is documented in the Done summary (filing the @opentui/core issue is deferred to explicit human approval — do NOT file it as part of this task)
- [ ] jobctl commit-work gate passes (no new lint/type failures)

## Done summary
Split package.json's `test` script into `test:isolated` (rest of suite under --isolate via --path-ignore-patterns) and `test:opentui` (the two @opentui-touching files under plain `bun test`), chained by the top-level `test` script. Preload approach did not hold — Bun 1.3.14 + @opentui/core 0.3.0 trip a TLA TDZ (zig.ts:67-68 nativePackage.default) inside --isolate regardless of preload, since the preload's own `await import('@opentui/core')` hits the same TDZ. Even a single @opentui-touching file under --isolate fails — the TDZ is per-file fresh-global, not the originally-suspected second-cold-load race. 5 consecutive `bun test test/ansi-to-styled.test.ts test/live-shell.test.ts` runs: 48/48 pass, 0 'Cannot access default'. Both files still pass alone under `bun test`. Lint + typecheck clean. Minimal upstream repro: `bun test --isolate test/ansi-to-styled.test.ts test/live-shell.test.ts` — fails with 'ReferenceError: Cannot access default before initialization' at zig.ts:68. Filing the @opentui/core (or Bun) upstream issue deferred to explicit human approval. Acceptance: the literal `bun test --isolate <two files>` repro cannot pass given the upstream bug — fallback per task spec (split into a dedicated `bun test` invocation) is the safety-net path the spec explicitly authorized.
## Evidence
