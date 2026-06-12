## Description

**Size:** M
**Files:** test/consistency-*.test.ts (new), the six python-oracle bun test files (converted), test/fixtures/creation/ (mint_worker.py removed)

### Approach

Two halves. (1) Translate the markdown/consistency tests: the four skill-consistency files (31), test_close_skill (2), test_worker_template_discipline (4), test_generated_guard_hook (17 — the wiring/behavioral portions not already covered by the bun guard tests; cite those for the rest), the field-absence pair, test_global_state/test_models/test_runtime_status/test_api/test_repo_inference/test_util_vendored per the mapping: cite the bun units that cover each behavior, translate the residue that genuinely tests binary-observable behavior, drop the pure-Python-internals remainder with reasons. test_stub_contracts: drop-with-reason (pins the deleted in-process engine). (2) Convert the python-oracle bun tests BEFORE deletion unblocks: capture frozen byte-literals from the current python for the serialization/integrity/specs/audit oracles; reframe the flock interop tests to bun-vs-bun process contention and the mint race to N concurrent bun workers (the concurrency property survives; the cross-engine premise is retired); remove mint_worker.py.

### Investigation targets

**Required** (read before coding):
- test/src-store-write.test.ts:285-400, src-creation-machinery.test.ts:450-500, src-audit-spine.test.ts:66, src-brief-claim.test.ts:47, src-integrity.test.ts:103/340, src-specs.test.ts:24 — the oracle sites
- The consistency pytest files — mostly markdown reads, fast translations

### Risks

Oracle capture must run against the current python NOW — version skew between capture and the original goldens would freeze wrong bytes; diff captures against existing passing assertions before committing.

## Acceptance

- [ ] Consistency/import files fully mapped; zero python3/uv invocations remain anywhere in test/
- [ ] Concurrency coverage preserved bun-vs-bun; both suites green

## Done summary
Converted the python-oracle bun tests (audit-spine commit-set hashes + integrity catalog/restamp-verb list frozen to literals; store-write flock interop to a second bun peer; creation mint race to N bun workers, mint_worker.py removed) and translated the skill/template/epic-field consistency suites onto the live CLI surface. Zero python3/uv invocations remain anywhere in test/; bun test green fast + PLANCTL_RUN_SLOW=1, lint/typecheck clean.
## Evidence
