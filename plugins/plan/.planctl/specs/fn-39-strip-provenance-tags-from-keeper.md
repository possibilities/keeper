## Overview

The keeper SILENT_STREAM_CUT detector landed correct, but its source comments
and test docstrings/names carry backward-facing provenance tombstones — the
`(fn-38.2)` task id and the `ea343ed2`/`cfcbc8ec` commit hashes — that violate
keeper's WHY-only comment discipline. This is a pure doc/comment cleanup sweep
across two keeper files; no behavior changes.

## Acceptance

- [ ] No `(fn-38.2)` task-id tag remains in keeper src/reducer.ts comments while the WHY-prose is preserved.
- [ ] No commit-hash or task-id tombstone remains in test/silent-stream-cut.test.ts docstrings or test names while the behavioral description is preserved.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | src/reducer.ts:3801 JSDoc + :3993 inline comment lead with (fn-38.2) provenance tag; strip the tag, keep the prose. |
| F2 | merged-into-F1 | .1 | F2 (test/silent-stream-cut.test.ts:2/:13-14 docstring + :134/:159 test names) is the same provenance-tombstone root cause as F1 in the same keeper files; one cleanup commit. |
| F3 | culled | — | Auditor marked the SCHEMA_VERSION pin-ledger note No action — sanctioned bookkeeping, not a finding. |
| F4 | culled | — | Multi-turn disposition-leak is correct by construction via max(turn_seq); no observed defect. |
| F5 | culled | — | AskUserQuestion dispatch precedence already correct; a test would only document correct behavior. |
| F6 | culled | — | Auditor cleared the 2.7:1 test ratio as acceptable for a no-false-positive drop-recovery path. |

## Out of scope

- The SCHEMA_VERSION pin-ledger entries (F3) — sanctioned per-version bookkeeping pattern.
- Speculative test-coverage adds (F4 multi-turn, F5 AskUserQuestion precedence) — behavior is correct by construction; deferred, not blocking.
- Any behavioral change to the SILENT_STREAM_CUT detector — this is comment text only.
