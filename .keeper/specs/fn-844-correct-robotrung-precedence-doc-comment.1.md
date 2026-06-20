## Description

Originating finding F1 (Consider / REDUNDANT_COMMENT). Evidence path:
`src/dash/view-model.ts:100-137`. The doc-comment at lines 103-104 reads
"api-error -> awaiting (permission OR input) -> working -> ended -> stopped
-> killed", but the body (lines 114-119) returns `ended`/`killed` BEFORE the
`last_api_error_at` check at line 120. The header asserts the inverse of the
actual precedence. Rewrite the header to lead with terminal-state resolution
(e.g. "ended/killed -> api-error -> awaiting -> working/stopped") so it
matches the body. The inline body comment (lines 109-113) already explains
the why and needs no change.

## Acceptance

- [ ] The `robotRung` doc-comment header lists terminal state (ended/killed)
      ahead of the annotation and base-state checks, matching the body.
- [ ] No body or behavior change; existing dash-view-model tests still pass.

## Done summary
Rewrote the robotRung doc-comment header to lead with terminal-state resolution (ended/killed -> api-error -> awaiting -> working/stopped), matching the body. Docs-only, no behavior change.
## Evidence
