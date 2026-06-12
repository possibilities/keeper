## Description

**Size:** M
**Files:** test/verbs-*.test.ts (new, one per source module batch), mapping comments throughout

### Approach

Translate the engine-agnostic verb modules onto the harness: test_readonly_verbs (15), test_worker_verbs (14), test_query_verbs (34), test_restamp_verbs (29), test_creation_verbs (17), test_gist (4), test_cli (4), test_init (7), test_envelope (11), test_envelope_shape (12), test_emit (6), test_now_iso_contract (5), test_cli_invoker_guard, test_no_track_commands, test_decorator_hardening — every test carries its pytest node source-comment; drops/cites recorded inline with reason. toStrictEqual discipline; cross-products precomputed; slow/real_git tests ride the slowTest gate; PATH-shim helpers (gh, promptctl) as executable temp scripts via a harness utility. Both suites green at the batch boundary.

### Investigation targets

**Required** (read before coding):
- The pytest files being translated — the spec, test by test
- test/harness.ts — the landed surface; never re-declare per-file helpers

### Risks

Assertion weakening is the failure mode — byte pins stay byte pins; when a pytest assertion is awkward in bun, keep the strength and pay the verbosity.

## Acceptance

- [ ] All listed modules translated with source-comments; zero unexplained drops; both suites green

## Done summary
Translated the engine-agnostic verb modules (readonly/worker/query/restamp/creation/cli+init/envelope/gist + decorator/no-track mapping) onto the bun harness: 147 new tests, every pytest node mapped by source-comment (translated | cited | drop-with-reason), zero todos. Added harness helpers (gitBaseline, seedRuntime, pathShim, scaffoldEpic) and migrated the list/integrity goldens with PROVENANCE. Fast + slow bun suites green (547 pass), lint + typecheck green.
## Evidence
