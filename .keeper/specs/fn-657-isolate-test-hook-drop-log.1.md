## Description

**Size:** S
**Files:** test/events-writer.test.ts, test/integration.test.ts, README.md, CLAUDE.md

### Approach

Introduce a shared sandboxed base env for every test that spawns the real
hook, so the drop-log (and dead-letter dir) always land under the per-test
`tmpDir`, never the production `~/.local/state/keeper/` paths. Concretely:
add `KEEPER_DROP_LOG: join(tmpDir, "hook-drops.ndjson")` (and fold in
`KEEPER_DEAD_LETTER_DIR` for belt-and-suspenders) to a single base-env
object that ALL six hook-firing spawn sites consume. The drop-log path must
reference the LIVE per-test `tmpDir` (computed inside the helper, not frozen
at module scope — tmpDir is re-created each `beforeEach`).

Cover ALL SIX spawn sites (the request originally named only four):
`fireViaLauncher` (~:92), `fireViaLauncherWithEnv` (~:1131),
`fireViaLauncherWithDeadLetter` (~:1310), the inline `Bun.spawn` at
`events-writer.test.ts` ~:293 (sess-broken-ps, fires against a tableless DB
— a guaranteed leak), plus `test/integration.test.ts` `fireHook` (~:152) and
the SIGKILL victim launcher (~:1697). For `fireViaLauncherWithEnv`, apply the
base env AFTER its `undefined`-clears-key overlay loop (or protect the
state-bearing keys) so no caller overlay can re-open the leak.

Then document the overrides: README env-var prose (~:388) gains
`KEEPER_DROP_LOG` + `KEEPER_DEAD_LETTER_DIR` (one sentence each, inline
style); CLAUDE.md gains one sentence on the test-isolation contract
(centralize spawn env; never spread `...process.env` for state paths).

Do NOT touch production hook logic (`dropLogPath` / `writeDropLog` /
exit-0 / error-swallow contract). This is test-env + docs only.

### Investigation targets

**Required** (read before coding):
- plugin/hooks/events-writer.ts ~:415 (`dropLogPath`) and ~:427 (`writeDropLog`) — confirm the env-override seam; do NOT change this code
- test/events-writer.test.ts ~:92, ~:1131, ~:1310 — the three spawn helpers + their `{...process.env, KEEPER_DB}` base
- test/events-writer.test.ts ~:293 — the inline `sess-broken-ps` spawn (tableless DB; guaranteed leak)
- test/events-writer.test.ts ~:1148-1154 — the `undefined`-clears-key overlay semantics (the re-leak gotcha)
- test/events-writer.test.ts ~:87-89 — `tmpDir` beforeEach/afterEach lifecycle (anchor the drop-log path here)
- test/integration.test.ts ~:152 (`fireHook`) and ~:1697 (SIGKILL victim launcher) — the second-file spawn sites

**Optional** (reference as needed):
- README.md ~:388 — env-var prose block to extend
- CLAUDE.md — dead-letter / event-sourcing invariants cluster for the one-sentence contract note

### Risks

- **Re-leak via overlay clear:** if the base env is applied BEFORE `fireViaLauncherWithEnv`'s `undefined`-deletes-key loop, a caller overlay can wipe `KEEPER_DROP_LOG`. Apply base after, or protect state keys.
- **Launcher-chain inheritance:** the var is set on the outermost spawn and must reach the hook two processes down (helper → launcher shim → hook). Verify it actually lands (the shim forwards `env: process.env` wholesale, so inheritance should hold — confirm with the zero-append check).
- **Stale tmpDir capture:** compute the drop-log path from the live `tmpDir` inside the helper; a module-scope capture would point at a stale/blank dir.
- **Don't break exit-0:** zero production-hook changes; the failure-path tests must still observe exit 0 and the dead-letter file in the temp dir.

### Test notes

Primary acceptance is a ZERO-append check: capture `wc -l` of
`~/.local/state/keeper/hook-drops.ndjson` before and after a full run of
both suites (`bun test test/events-writer.test.ts test/integration.test.ts`);
the delta MUST be 0. Also confirm the existing dead-letter assertions still
pass (the dead-letter NDJSON still lands in the temp dir; only the drop-log
moved). Grep the production feed for `sess-deadletter-ss`/`sess-mode` after a
run — count must not increase.

## Acceptance

- [ ] A full run of `test/events-writer.test.ts` + `test/integration.test.ts` appends ZERO new rows to production `~/.local/state/keeper/hook-drops.ndjson` (before/after `wc -l` delta == 0)
- [ ] All six hook-firing spawn sites consume a shared sandboxed base env setting `KEEPER_DROP_LOG` (and `KEEPER_DEAD_LETTER_DIR`) under `tmpDir`
- [ ] `fireViaLauncherWithEnv`: no caller overlay can clear the state-bearing keys (base applied after the clear loop, or keys protected)
- [ ] Zero production hook-logic changes (dropLogPath / writeDropLog / exit-0 contract untouched); existing dead-letter tests still green
- [ ] README documents `KEEPER_DROP_LOG` + `KEEPER_DEAD_LETTER_DIR`; CLAUDE.md notes the test-isolation contract
- [ ] `bun test` green; committed to main staging only the touched files

## Done summary
Sandboxed KEEPER_DB / KEEPER_DEAD_LETTER_DIR / KEEPER_DROP_LOG across all six hook-firing test spawn sites via a shared sandboxedBaseEnv() helper in both test files; fireViaLauncherWithEnv applies the sandbox after its overlay-clear loop so callers can't re-open the leak. Verified zero appends to production hook-drops.ndjson across a full run of both suites. README + CLAUDE.md document the contract.
## Evidence
