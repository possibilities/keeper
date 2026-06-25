## Description

**Size:** S
**Files:** test/usage-picker-flock.slow.test.ts (new), test/agent-tmux-launch-timeout.slow.test.ts (new), test/usage-picker.test.ts, test/agent-tmux-launch.test.ts, package.json, CLAUDE.md, README.md

### Approach

Two extractions of the same shape, following the `agent-tmux-launch-stripped-env.slow.test.ts`
precedent (header comment explaining why it's slow + fast-tier-ignored, own setup):

1. **usage-picker flock test** — move `test/usage-picker.test.ts:386-426` (the
   `describe("concurrency")` → `test("concurrent picks ... (real flock)", 30000)`) into
   a new `test/usage-picker-flock.slow.test.ts`. Carry the setup it needs: the
   `beforeEach`/`afterEach` (L41-60 — tmpdir, `setStateDir`, `XDG_CONFIG_HOME`) and the
   `writeConfig`/`writeEnvelope`/`readCounts` helpers. Those helpers are ALSO used by the
   fast tests, so they stay in `usage-picker.test.ts` AND get duplicated (minimally) into
   the new slow file — do not export+import across test files. `test/fixtures/pick-once.ts`
   stays put (referenced via `import.meta.dir`).
2. **tmux timeout test** — move `test/agent-tmux-launch.test.ts:682-694` (the
   `describe("defaultTmuxCommandRunner timeout classification")` → `sleep 30` test) into a
   new `test/agent-tmux-launch-timeout.slow.test.ts`, importing `defaultTmuxCommandRunner`,
   `TMUX_DEFAULT_TIMEOUT_MS`, `TMUX_TIMEOUT_RESULT_CODE` from `src/agent/tmux-launch.ts`.

Then wire both new files into the fast `test` script's `--path-ignore-patterns` in
package.json (they auto-run under `test:full` with no further wiring — the gate just
forwards to `bun test`, which auto-discovers minus the ignore list). Add NEITHER to
`scripts/test-real-git-allowlist.txt` (flock spawns `bun`, timeout spawns `sleep` —
neither trips `lint-no-real-git.ts`). Finally, tighten the CLAUDE.md "Test isolation" +
README test-paragraph wording so the `*.slow` rule reads as "extract an individual slow
case" not "rename the whole file."

### Investigation targets

**Required** (read before coding):
- test/agent-tmux-launch-stripped-env.slow.test.ts — the exact precedent to mirror (header, gate, teardown)
- test/usage-picker.test.ts:41-60, 386-426 — the flock test + its setup/helpers to carry
- test/agent-tmux-launch.test.ts:682-694 + src/agent/tmux-launch.ts:30,38 — the timeout test + the constants it imports
- package.json — the fast `test` script `--path-ignore-patterns` list (where the two new files go); confirm `test:full` does NOT list slow files

**Optional** (reference as needed):
- test/usage-scrape-runner.slow.test.ts — second `*.slow` precedent
- scripts/lint-no-real-git.ts — confirms only `git` spawns trip the allowlist (so no entry needed)

### Risks

- The flock test's helpers (`writeConfig`/`writeEnvelope`/`readCounts`) and `beforeEach` are shared with the fast tests that stay — they must be DUPLICATED into the slow file, not removed from the fast one. Removing them breaks the ~21 fast picker tests.
- Forgetting the package.json `--path-ignore-patterns` entry means the new `*.slow.test.ts` STILL runs in the fast tier (path-string match, not heuristic) — zero speedup. Verify with `bun run test` (slow files absent) vs `bun run test:full` (present).
- After removing each test, re-run the source file to confirm no now-orphaned imports/vars linger (lint).

### Test notes

`KEEPER_TEST_NO_GATE=1 bun run test` (target ~6s, both slow files skipped), `bun run test:full` (green, slow files run), the two slow files pass standalone, `bun run test:hygiene` + `bun run lint` green. Record before/after fast-tier wall-clock in the Done summary.

## Acceptance

- [ ] `test/usage-picker-flock.slow.test.ts` + `test/agent-tmux-launch-timeout.slow.test.ts` created, each holding the extracted test + its carried setup, passing standalone
- [ ] The two tests removed from `usage-picker.test.ts` / `agent-tmux-launch.test.ts`; the remaining fast tests in both files still pass (shared helpers preserved)
- [ ] Both new files in the fast `test` `--path-ignore-patterns`; neither in the real-git allowlist
- [ ] `KEEPER_TEST_NO_GATE=1 bun run test` ~6s and green; `bun run test:full` green; `bun run test:hygiene` + `bun run lint` green
- [ ] CLAUDE.md + README `*.slow` wording tightened to "extract individual slow case" (in place, no new paragraph)

## Done summary

## Evidence
