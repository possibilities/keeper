## Description

**Size:** M
**Files:** src/audit_artifacts.ts (new), src/submit_common.ts (new), src/verdict_schema.ts (new), test/ additions

### Approach

The early proof point. audit_artifacts.ts: path helpers, AUDIT_SCHEMA_VERSION, computeCommitSetHash byte-identical to Python (canonical order-independent SHA-256, schema_version folded, compact separators + sorted keys + ascii-escaped serialization for the hash input), writeArtifact as a COMMIT-FREE atomic writer that NEVER records touched paths (a separate function from the landed atomicWrite — artifacts under gitignored state/audits/ must not be swept into commits), ArtifactSchemaTooNewError. submit_common.ts: 1 MiB capped payload reader (reuse the landed bounded-stdin reader), resolveAuditContext (brief load + schema-version gate → primary_repo + brief), emitSubmitError matching the typed shape. verdict_schema.ts: hand-rolled structural validation reproducing python-jsonschema semantics for exactly the keywords the schema uses (type incl. ["integer","null"] union, required, additionalProperties:false, minLength, pattern), emitting {loc,type,msg} rows whose msg text matches the ordinal-1 golden table; top-3 truncation, first-failing-path schema fragment, true error_count; then the cross-field pass (fatal⇒fatal_reason, merge-target fid existence, culled⇒null task, kept/merged⇒int ordinal rejecting booleans explicitly). Fallback if parity fights: ajv + a message-translation table — goldens stay the arbiter. bun units: hash parity (spawn python3 on a shared fixture), validator vs every golden, writer never touching the touched-log.

### Investigation targets

**Required** (read before coding):
- planctl/audit_artifacts.py and submit_common.py — the spine sources
- planctl/verdict_schema.py — schema, error rows, cross-field pass
- tests/fixtures/golden/ verdict additions from ordinal 1 — the parity table
- src/store.ts atomicWrite — what writeArtifact must NOT do (touched-log)

### Risks

The touched-log distinction is subtle and high-consequence: one wrong writer choice and audit artifacts start riding mutating commits, diverging from Python silently until a close-finalize hash check explodes.

### Test notes

bun test green incl. hash cross-engine parity and golden-vs-validator; lint/typecheck green.

## Acceptance

- [ ] computeCommitSetHash byte-identical on shared fixtures; writeArtifact commit-free and touched-log-free
- [ ] Validator matches every golden row incl. message text; cross-field rules exact

## Done summary
Ported the bun close-saga audit/submit/verdict spine (audit_artifacts, submit_common, verdict_schema) with byte-parity commit-set hashing, a commit-free touched-log-free artifact writer, and hand-rolled python-jsonschema message parity. Added src-audit-spine.test.ts proving hash cross-engine parity, validator-vs-every-golden, and writer-never-touches-the-session-log.
## Evidence
