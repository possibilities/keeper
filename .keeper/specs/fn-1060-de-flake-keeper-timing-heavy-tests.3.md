## Description

**Size:** M
**Files:** plugins/plan/test/stop-guard.test.ts

### Approach

The plan-suite ladder test "work marker + in_progress_uncommitted → block with the checklist" (:291) flaps at ~5.4s under a 30s budget — a genuine race, not a timeout. CAPTURE BEFORE FIXING: the failure signature has never been observed, only hypothesized. First reproduce locally — `cd plugins/plan && bun test test/stop-guard.test.ts --rerun-each 20` under induced load (e.g. a parallel `bun run test` in the root repo) — and instrument `run()` (:226) to dump the spawned guard's full stderr/stdout and the `planCliCalled` sentinel state on failure. Leading hypothesis: the nested bun→bun spawn (`run()` spawns GUARD, which execs the generated `keeper` shim from `writePlanCliShim` at :212 — itself a bun script) cold-starts or races under contention. Fix per the captured evidence, not the hypothesis: if the nested spawn is confirmed, collapse one spawn level (e.g. point the shim at an in-process stub or invoke the guard's handler directly) while PRESERVING what the ladder test covers — the guard's real stdin/stdout block-checklist contract; if the signature shows a sentinel-file read race or stdout read-before-flush instead, fix that seam. Document the captured signature verbatim in the Done summary.

### Investigation targets

**Required** (read before coding):
- plugins/plan/test/stop-guard.test.ts:226 — run()'s Bun.spawn shape; :212 writePlanCliShim; :291 the named ladder test
- plugins/plan/package.json:11 — the plan suite's `--timeout 30000`

**Optional** (reference as needed):
- test/helpers/retry-until.ts — the poll-don't-sleep helper if the fix needs an async wait (never a fixed sleep)

### Risks

An in-process rewrite that removes real subprocess coverage may pass while the actual race (if elsewhere) keeps flapping in CI — hence capture-first. The instrumentation must not itself alter timing enough to mask the race (prefer on-failure dumps over per-step logging).

### Test notes

Fixed test survives `--rerun-each 20` under induced load; the block-checklist contract assertions are unchanged.

## Acceptance

- [ ] The real failure signature is captured and quoted in the Done summary (or 40+ loaded reruns produce zero failures and that null result is documented before any rewrite)
- [ ] The fix targets the observed seam; the ladder test's block-checklist contract coverage is preserved
- [ ] `cd plugins/plan && bun test` green; the named test survives a --rerun-each 20 sweep under load

## Done summary

## Evidence
