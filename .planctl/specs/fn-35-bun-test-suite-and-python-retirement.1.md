## Description

**Size:** M
**Files:** test/harness.ts (new), test/fixtures/golden/** (migrated + PROVENANCE.md), test/harness.test.ts (new), test/src-audit-spine.test.ts (repoint), test/fixtures/pytest-inventory.txt (new), package.json (test script timeout floor)

### Approach

The foundation everything else rides. harness.ts exports: runCli (Bun.spawnSync against the dist binary with env override, pipe stdio, stdin ignore, per-call timeout; merged-output and split accessors plus the payload extractors mirroring the conftest pair), buildEnv (built-from-scratch minimal env: tmp HOME + XDG + GIT_CONFIG_GLOBAL/SYSTEM + PATH + PLANCTL_ACTOR, forwarding PLANCTL_NOW/CLAUDE_CODE_SESSION_ID when set), withTmpdir/withProject/withGitRepo hook-getters (module-scope registration; single composite beforeEach; real git init with local identity), seedState byte-faithful to the conftest layout, setRoots, fixedClock, slowTest gate (PLANCTL_RUN_SLOW + test.skipIf; visibility asserted via the run summary counts since CLAUDECODE quiets per-test lines), and the git assertion helpers. Port test_seed_state.py as harness self-tests proving seedState's on-disk bytes match what the binary reads. Migrate the golden corpus to test/fixtures/golden with one FINAL re-capture (pin binary + python hashes in PROVENANCE.md per directory; record the _generate.py command text; state the frozen-spec-no-reproduction status); repoint src-audit-spine; delete _generate.py and any .pyc strays from the moved tree. Capture the live pytest --collect-only inventory to test/fixtures/pytest-inventory.txt (the permanent record — the planning-time count was stale, capture fresh). Add the global --timeout floor to the package.json test script.

### Investigation targets

**Required** (read before coding):
- tests/conftest.py:382-613, :717-937, :997-1145 — the fixture spec being reproduced
- test/src-cli.test.ts:18-50 — the landed BIN/spawn idiom to standardize
- tests/fixtures/golden/ — the corpus incl. verdict/_generate.py

### Risks

seedState byte-fidelity is the keystone — a divergent layout invalidates every translated test silently; the self-tests are the proof. The golden re-capture must run against the current python before anything is deleted.

## Acceptance

- [ ] Harness lands with self-tests green; goldens migrated + PROVENANCE.md + repoint; inventory committed; timeout floor set
- [ ] Both suites still green (pytest untouched; existing bun tests pass with the repoint)

## Done summary

## Evidence
