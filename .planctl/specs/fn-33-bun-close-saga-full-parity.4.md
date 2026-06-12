## Description

**Size:** M
**Files:** src/verbs/verdict_submit.ts, src/verbs/followup_submit.ts, src/verbs/audit_submit.ts (all new), src/cli.ts, test/ additions

### Approach

Three thin verbs on the spine. verdict submit: capped stdin → JSON parse (BAD_JSON/NO_STDIN/PAYLOAD_TOO_LARGE/BAD_ENCODING) → brief context (BRIEF_MISSING/BRIEF_CORRUPT) → schema + cross-field validation (VERDICT_INVALID with the parity rows) → writeArtifact verdict.json → success {verdict_ref, commit_set_hash, fatal, decision_count, expected_clusters}. followup submit: verdict-presence gate (VERDICT_MISSING), scaffold validate dry-run reusing the landed bun scaffold validator with its code set surfaced verbatim, TASK_COUNT_MISMATCH completeness pre-check, writes followup.yaml + meta. audit submit: --findings/--risk gates (BAD_RISK), report.md + meta writes. All runtime-state-only: zero commits, readonly invocation lines.

### Investigation targets

**Required** (read before coding):
- planctl/run_verdict_submit.py, run_followup_submit.py, run_audit_submit.py — the verb sources
- tests/test_verdict_submit.py, test_followup_submit.py, test_audit_submit.py, test_audit_artifacts.py — the pins
- src/verbs/scaffold.ts — the validator entry the followup dry-run reuses

### Risks

followup submit surfacing scaffold's code set verbatim means any drift in the landed scaffold validator's messages shows up here too — shared, not copied.

### Test notes

The four test files green via dist/planctl-bun; zero commits proven.

## Acceptance

- [ ] Trio green in their test files via the compiled binary; envelopes byte-faithful
- [ ] No commits from any submit verb; artifacts land under state/audits/ untracked

## Done summary

## Evidence
