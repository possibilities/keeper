## Overview

The Bearer-scheme fix added a `(?!bearer\b)` lookahead to SENSITIVE_KEY_RE's
value capture, but its fallback BEARER_RE only fires on `bearer\s+`. Any
sensitive-key value whose text literally begins with `bearer` followed by a
NON-whitespace boundary (glued `Authorization:Bearer<token>`, or
`AUTH_TOKEN=bearer.foo` / `bearer-foo` / `bearer=...`) now escapes BOTH regexes
and survives into persisted death-capture. This is a self-inflicted fail-open
narrowing in a module explicitly documented to fail toward MORE redaction; the
common space-separated `Bearer <token>` case is unaffected. This follow-up
restores the fail-safe for the punctuated/glued forms and locks it with a test.

## Acceptance

- [ ] A sensitive-key value literally starting with `bearer` + a non-whitespace
      boundary is redacted again (fail-toward-more-redaction restored).
- [ ] The space-separated `Authorization: Bearer <opaque>` path still redacts the
      token while the scheme word survives (no regression to the shipped fix).
- [ ] A regression test asserts the non-space-separated / punctuated forms redact.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | src/provider-leg-death-notice.ts:236 `(?!bearer\b)` + BEARER_RE's `\s+` lets a value starting with `bearer`+non-whitespace escape both regexes (fail-open regression), fixed by `\b`->`\s`. |
| F2 | merged-into-F1 | .1 | F2 (missing coverage for non-space-separated bearer-prefixed forms) is the test counterpart of F1's same-root-cause leak; folded into F1's task. |

## Out of scope

- Replacing the interim inline SENSITIVE_KEY_RE with the shared secrets pattern
  list (deferred to the pattern-list ADR, per the module comment).
