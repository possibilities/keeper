## Description

**Size:** S
**Files:** test/reducer-projections.test.ts, test/rpc-handlers.test.ts, test/session-state.test.ts

### Approach

Modernize `.planctl/` fixture PATH strings to `.keeper/` ONLY where they are
convenience values — the fold never inspects the dir segment (confirmed:
reducer.ts `mintPlanctlFileAttributions` ~5271-5322 passes `planctl_files`
paths through verbatim, filtering only absolute/`..` paths). Classify each
string before changing it.

- test/reducer-projections.test.ts (~2471-2915) — the `.planctl/epics|tasks|specs/...` strings in `files:` arrays. Modernize. Do NOT touch the `planctl_*` COLUMN refs (~98-186).
- test/rpc-handlers.test.ts (47-48 + header comments 4,9,12) — the `.planctl/{epics,tasks}` scaffold tree. Confirm the RPC handler under test resolves `.keeper` first, then modernize.
- test/session-state.test.ts (181-191) — the dirty-set exclusion fixture. The prod filter (`PLANCTL_EXCLUDE_PREFIXES` = `[".keeper/", ".planctl/"]`, commit-work/attribution.ts:44) excludes BOTH, so switching the fixture to `.keeper/` preserves exclusion coverage.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:5271-5322 — proves reducer-projections fixtures are convenience values (T4-safe)
- src/commit-work/attribution.ts:44 — PLANCTL_EXCLUDE_PREFIXES dual (proves session-state safe)

**Optional**:
- the three target test files

### Risks

Do NOT modernize recognition/backward-compat assertions: test/events-writer.test.ts
(legacy `planctl_invocation` envelope), test/git-worker.test.ts (T2's domain,
vendored prune), test/refold-equivalence.test.ts (re-fold determinism charter).
For session-state, `.planctl/` exclusion is still live (vendored/historical) —
switching the primary fixture to `.keeper/` is fine; optionally keep a `.planctl/`
case too.

### Test notes

session-state.test.ts spawns the real CLI (process path) -> `bun run test:full`.
reducer-projections/rpc-handlers run on the fast tier. Verify all green.

## Acceptance

- [ ] reducer-projections / rpc-handlers / session-state `.planctl/` fixture paths -> `.keeper/` (convenience values only)
- [ ] `planctl_*` column refs and recognition-assertion tests untouched
- [ ] tests green (test:full for session-state)

## Done summary
Modernized stale .planctl/ fixture PATH strings to .keeper/ in reducer-projections, rpc-handlers, and session-state tests (convenience values only); planctl_* columns and recognition assertions left untouched. Full suite green.
## Evidence
