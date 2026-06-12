## Overview

The program's final epic: the pytest suite (919 collected tests, 64 files) translates to bun:test as the living suite driving the production binary, and the Python implementation is deleted — planctl/, tests/, pyproject.toml, uv.lock, pyrightconfig.json — leaving a pure-bun repo. Every pytest test is accounted for in an auditable mapping (translated | cited bun unit | drop-with-reason); both suites run side by side until the count gate passes; the deletion is its own purely-subtractive atomic commit, and rollback thereafter is git revert of that commit.

## Quick commands

- `bun test` — the living suite (fast default; slow bucket via PLANCTL_RUN_SLOW=1)
- `uv run pytest tests/ --collect-only -q` — the inventory capture (runs only while tests/ exists)
- `git grep -lE "pytest|conftest|uv run|\.py\b" -- ':!*.md' ':!.planctl'` — the zero-residue check after deletion

## Acceptance

- [ ] test/harness.ts (shared module): runCli spawn wrapper (dist-path binary resolution, pipe stdio, stdin ignore, per-call timeout + a global --timeout floor in the test script), tmp-HOME env builder mirroring the conftest built-from-scratch env, seedState byte-faithful to the conftest layout, withTmpdir/withProject hook-getters, setRoots, fixedClock (PLANCTL_NOW), PLANCTL_RUN_SLOW gate via test.skipIf with visibility asserted via summary counts; session-scoped setup consolidated into module-eval
- [ ] Golden corpus migrated to test/fixtures/golden with a final re-capture (pinned hashes) and PROVENANCE.md per directory stating the frozen-spec-no-reproduction-path status; src-audit-spine repointed; _generate.py deleted with its command text recorded
- [ ] Live pytest --collect-only inventory committed OUTSIDE tests/ as the permanent record; every node mapped (source-comment per bun test); count gate = (inventory − enumerated drops) vs bun test()+each count, zero test.todo remaining
- [ ] The six python-oracle bun tests converted (frozen literals; flock interop → bun-vs-bun contention; mint race → N-bun-workers) BEFORE the deletion commit
- [ ] Deletion commit purely subtractive + residue edits: .gitignore python block, worker template runner/check-matrix rows (template edit + regenerate ALL rendered agents — grep found 6 files referencing pyproject/pytest/ruff, verify the rendered set), CLAUDE.md Running Things collapse (bun rows + PLANCTL_RUN_SLOW row; PLANCTL_BIN env entry removed), README single-implementation prose with the git-revert rollback fact; zero-.py grep clean (pycache purged first)
- [ ] bun test green (fast + PLANCTL_RUN_SLOW=1 full) against the production binary; lint/typecheck green

## Early proof point

Task that proves the approach: ordinal 1 (the harness — if per-test isolation isn't cheap, translators cut corners; the harness self-tests port test_seed_state as their own proof). Fallback: if bun:test ergonomics fight a fixture shape, consolidate affected files into fewer larger test files rather than weakening isolation.

## References

- The per-file classification table from planning recon is the mapping skeleton: pure-import files (test_global_state 58, test_models 34, test_runtime_status 31, test_api, test_repo_inference, test_util_vendored) cite existing bun units or drop-with-reason; hook tests cite the existing guard tests; test_stub_contracts + the 29 python_only marks are canonical drops (they pin the deleted in-process engine). Classification is per-FILE in the table but the completeness rule is per-TEST — the mapping reconciles to node granularity.
- Harness sources of truth (cite, reproduce byte-faithfully): tests/conftest.py:580-613 env builder (never environ.copy; HOME+XDG+GIT_CONFIG_GLOBAL/SYSTEM+PATH+PLANCTL_ACTOR+forwarded CLAUDE_CODE_SESSION_ID/PLANCTL_NOW), :854-937 seed_state exact layout (meta.json schema_version; .planctl/.gitignore "state/\n"), :545 per-worker HOME, :382-498 git fixtures (skeleton fast path + real-init branch), :717 set_roots, :997 fixed_clock (2026-06-06T00:00:00.000000Z), :762/:1047 payload extractors, :1076-1145 git assertion helpers.
- Translation discipline: toStrictEqual for dict ports (toEqual ignores undefined-valued keys — THE silent trap); "key in obj" for presence; stacked parametrize = precomputed cross-products into test.each; pytest.raises-with-post-assertions = try/catch capture; toBeCloseTo for approx; batch same-precondition assertions per spawn (2-5ms/spawn × hundreds); decode Uint8Array stdout explicitly; existing bun idiom resolves BIN from the dist path and hard-fails if absent — the harness keeps that, with an env override.
- Blast radius converted pre-deletion: test/src-audit-spine.test.ts:50-54 golden path repoint; python-oracle sites src-audit-spine:66, src-brief-claim:47, src-creation-machinery:485 (+ mint_worker.py), src-integrity:103/340, src-specs:24, src-store-write:93/306/346/378.
- Deletion = its own commit AFTER green + count-verified; rollback = git revert of that commit (the uv rollback path ends here — the program's locked premise).

## Docs gaps

- **CLAUDE.md**: Running Things collapses to bun rows (+ slow-gate row); polyglot bullet becomes the single-implementation statement; PLANCTL_BIN env entry removed
- **README.md**: prerequisites and Python paragraphs deleted; rollback note becomes the git-revert forward fact
- **template/agents/worker.md.tmpl**: runner-detection and check-matrix rows prune Python entries; regenerate every rendered agent from the template

## Best practices

- **withTmpdir hook-getter at module scope; one composite beforeEach** [bun docs]
- **toStrictEqual over toEqual when porting Python dict equality** [jest#711]
- **Count gate on EXPANDED node counts minus enumerated drops; zero-todos first** [migration auditing]
- **--parallel (file-level) yes, --concurrent (in-file) no for subprocess tests; timeout on every spawn + a global floor** [bun docs]
- **Goldens become the spec at deletion — PROVENANCE.md with generator command, hashes, capture date** [fixture policy]
