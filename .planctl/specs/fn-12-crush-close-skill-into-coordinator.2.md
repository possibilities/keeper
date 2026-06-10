## Description

**Size:** M
**Files:** planctl/run_audit_submit.py (new), planctl/run_verdict_submit.py (new), planctl/run_followup_submit.py (new), planctl/verdict_schema.py or schema JSON in-package (new), planctl/cli.py, tests/test_audit_submit.py, tests/test_verdict_submit.py, tests/test_followup_submit.py (new)

### Approach

Three `--file -` submit verbs over the task-1 module, registered as nested click groups (`audit`/`verdict`/`followup` + `submit`) modeled on `@cli.group("epic")` at cli.py:982. All three: read via `store.read_file_or_stdin` with a 1 MiB byte cap (scaffold's), stamp `commit_set_hash` + `schema_version` from the on-disk brief (typed error if brief missing), persist commit-free via the task-1 writer, last-writer-wins. `audit submit` accepts the report markdown plus `--findings <N> --risk <Low|Medium|High>` flags echoed in the envelope and a meta field. `verdict submit` validates JSON against the NEW small schema — `{fatal: bool, fatal_reason: str, decisions: [{fid, action: kept|culled|merged-into-<fid>, task: int|null, rationale}]}`, additionalProperties:false on every object node — then post-validates cross-field invariants jsonschema cannot (merged-into targets reference an existing fid; culled → task null; kept/merged → non-null task ordinal; fatal:true → non-empty fatal_reason). Typed reject envelope per practice-scout: machine-readable list (loc/type/msg), top-3 errors + minimal schema fragment for the failing path only. `followup submit` runs yaml.safe_load + scaffold's Phase-2 validation WITHOUT the mutate phase (factor or call into run_scaffold's validation block; the dry-run skips the CLAUDE_CODE_SESSION_ID mint gate — it mints nothing) and cross-validates the YAML task count against the persisted verdict's distinct non-null kept/merged ordinals. Read-only-style error paths use the house `_set_invocation_sentinel` + `_emit_*_error` pair.

### Investigation targets

**Required** (read before coding):
- planctl/run_scaffold.py:106+ — stdin handling, byte cap, yaml.safe_load, assert-all→mutate→emit split, _emit_failure codes (the validation block followup submit reuses)
- planctl/cli.py:497-585, :982 — verb registration + nested-group pattern; add new prefixes to _MULTIWORD_PREFIXES in the consistency test
- planctl/run_reconcile.py:51-67 — typed-envelope conventions (str-Enum, not StrEnum)

**Optional** (reference as needed):
- skills/close/classifier/schema.json — the retiring 8-field schema (what NOT to carry over; deletion happens in task 4)
- tests/test_classifier_schema.py — Draft202012Validator usage pattern (file itself retires in task 4)

### Risks

Factoring scaffold's validation for reuse must not change scaffold's own behavior — keep the factor surgical or call the existing functions. Reject-envelope verbosity: too much schema in the error makes agent self-correction worse, not better.

### Test notes

Per verb: happy path persists + envelope shape; reject paths (bad JSON, schema violation, each cross-field invariant, oversize stdin, missing brief); hash stamped from brief; no commit fires. Verdict: fid dangling-merge case. Followup: count mismatch vs verdict; scaffold-invalid YAML surfaces scaffold's codes; no session-id required.

## Acceptance

- [ ] `planctl audit submit` / `verdict submit` / `followup submit` registered and persist commit-free under `audits/<epic_id>/` with stamped hash
- [ ] verdict schema + cross-field post-validation enforced at emission; reject envelope is machine-readable and minimal
- [ ] followup submit validates via scaffold dry-run semantics (no mint, no session-id gate) and cross-checks task count against verdict.json
- [ ] `uv run pytest tests/test_audit_submit.py tests/test_verdict_submit.py tests/test_followup_submit.py -q` green

## Done summary

## Evidence
