## Description

Fix finding F1 (with merged F2). Evidence path: `git ls-files --eol
plugins/plan/src/verbs/selection_audit_brief.ts` reports `i/-text w/-text`
(binary), and `perl` escaping shows line 182 reads
`paths.add(`${g.repo}<00>${row.path}`)` — a literal NUL byte between the
repo and path. The byte is functionally harmless (the Set still dedupes,
`files_changed` counts correctly) but the file is committed as binary, so
its diff was suppressed from review and it is invisible to blame/grep.

Files:
- `plugins/plan/src/verbs/selection_audit_brief.ts` — replace the raw NUL on line 182 with an explicit separator. A NUL delimiter is a sound choice (NUL cannot appear in a repo or file path), so writing it as the `\0` (or `\x00`) escape keeps the dedup semantics identical while restoring the file to text; a printable separator is equally acceptable.
- A verb-source conformance test (F2's guard) asserting the plan verb sources contain no raw NUL/control byte — it must fail against the pre-fix byte and pass after.

## Acceptance

- [ ] `git ls-files --eol plugins/plan/src/verbs/selection_audit_brief.ts` reports `w/text` and the file contains no raw NUL/control byte.
- [ ] The dedup key uses an explicit escaped or printable separator; `files_changed` / diff-stats behavior is unchanged (existing `diff_stats` tests stay green).
- [ ] A new conformance test fails on a raw NUL in a verb source and passes post-scrub.

## Done summary
Scrubbed the raw NUL byte from selection_audit_brief.ts's changed-paths dedup key (now the \0 escape), restoring the file to text with identical dedup behavior; added a conformance test that fails on a raw control byte in any plan verb source and passes post-scrub.
## Evidence
