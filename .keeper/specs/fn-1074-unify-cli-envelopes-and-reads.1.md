## Description

**Size:** M
**Files:** cli/ (new envelope module), cli/status.ts, cli/query.ts, plugins/plan/src/emit.ts, docs (problem-code registry)

### Approach

Extract the status.ts envelope into a shared helper: {schema_version, ok, error, data} with
per-verb schema_version injected by the caller, error as {code, message, recovery} on ok:false
(null on success), printed to stdout with the status exit model (bad state is data, exit 0;
transport failure is ok:false envelope, exit 1). Migrate status + query onto it (query's
transport failure currently prints empty stdout + stderr prose at cli/query.ts:184 — it must
fail like status.ts:346). Converge plan's error sub-object only: emitFailureEnvelope
(plugins/plan/src/emit.ts:195-205) gains recovery alongside code/message/details without
touching the success family, plan_invocation, auto-commit-before-print, or the didSelfEmit
sentinel. Write the problem-code registry doc: every code the helper family can emit, with
meaning, recovery contract, and retry-safety. Name the exemptions in the helper's doc
comment: plan emit family, plan validate {valid,errors,warnings}, plan cat raw markdown,
show-session-files snake_case Python-parity, watch's streaming {sequence,type,data}.

### Investigation targets

**Required** (read before coding):
- cli/status.ts:306-353 — buildStatusErrorEnvelope + exit model
- cli/query.ts:184-195 — the divergent failure path
- plugins/plan/src/emit.ts:44-50,195-205 — sentinel + failure envelope
- cli/commit-work.ts:88,600 — the recovery contract wording to generalize

**Optional** (reference as needed):
- test/status.test.ts, plugins/plan/test/verbs-readonly.test.ts — shape tests + one-JSON-root guard

### Risks

- status's error is a bare string today; keep error.message carrying exactly the old string so a consumer that stringifies the field degrades readably.
- The helper must not import bun:sqlite or daemon modules — CLI-side, dep-light, so hooks never accidentally reach it.

### Test notes

Shape tests per migrated verb (success + transport-failure snapshots); plan suite must stay
green untouched except the added recovery key on failure envelopes.

## Acceptance

- [ ] Shared helper exists; status + query emit through it; query failure lands on stdout as an envelope
- [ ] Every ok:false from the helper carries error.{code,message,recovery}; registry doc lists all codes
- [ ] plan emitFailureEnvelope carries recovery; plan success family byte-unchanged (Python parity suite green)

## Done summary

## Evidence
