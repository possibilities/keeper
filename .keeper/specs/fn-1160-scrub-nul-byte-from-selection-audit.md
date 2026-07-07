## Overview

The `selection_audit_brief` verb source carries a raw embedded NUL byte
(U+0000) inside the changed-paths dedup key on line 182, which makes git
record the entire TypeScript file as binary (`-text`). The consequence is a
hygiene landmine, not a runtime bug: the file's diff is suppressed from code
review, it is invisible to `git blame`/`diff`/`grep`, and an editor that
strips control chars would silently mutate the dedup key. This follow-up
scrubs the byte back to text and adds a mechanical guard so the class of
defect — which by definition escapes human review — cannot recur silently.

## Acceptance

- [ ] `selection_audit_brief.ts` is a text file (`git ls-files --eol` reports `w/text`) with no NUL/control byte, and the changed-paths dedup key uses an explicit visible separator (e.g. the `\0` escape or a printable delimiter) with `files_changed` behavior unchanged.
- [ ] A conformance test asserts the plan verb sources carry no raw NUL/control bytes, failing on the current byte and passing after the scrub.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Raw NUL at selection_audit_brief.ts:182 makes git record the file as binary (`git ls-files --eol` -> `-text`), suppressing its diff from review and hiding it from blame/grep. |
| F2 | merged-into-F1 | .1 | F2 (no control-byte conformance test) folds into F1's fix task — the guard prevents recurrence of F1's review-suppressing NUL and lands in the same commit. |

## Out of scope

- Any behavioral change to the audit-brief dedup / `files_changed` counting — the fix must be byte-for-byte equivalent in behavior.
- Broader binary-file hygiene sweeps of other repos or non-verb sources.
