## Description

Originating finding F1 (Axis 1 / Should fix), with its test counterpart F2
(Test Gaps) folded in — same root cause. Evidence path: `src/provider-leg-death-notice.ts:236`.
Post-commit `bf5c4144`, SENSITIVE_KEY_RE's value capture is guarded by
`(?!bearer\b)`, but BEARER_RE (line 239) requires `bearer\s+`. A value literally
starting with `bearer` + a non-whitespace boundary (glued `Authorization:Bearer<token>`,
or `AUTH_TOKEN=bearer.foo` / `bearer-foo` / `bearer=...`) satisfies the `\b`, so the
negative lookahead drops it from SENSITIVE_KEY_RE, and BEARER_RE cannot reach it
(no `\s+`) — the value leaks into persisted death-capture where the pre-commit
`(\S+)` redacted it. Change `(?!bearer\b)` to `(?!bearer\s)` (defer to BEARER_RE
only when a space actually follows) to restore the fail-safe over-redaction.

Files:
- src/provider-leg-death-notice.ts (the SENSITIVE_KEY_RE lookahead)
- test/provider-leg-death-notice.test.ts (regression coverage)

## Acceptance

- [ ] `(?!bearer\b)` is tightened so a `bearer`+non-whitespace value redacts again.
- [ ] Space-separated `Authorization: Bearer <opaque>` still redacts the token,
      scheme word survives.
- [ ] Regression test asserts `Authorization:Bearer<opaque>` (no space) and at
      least one punctuated form (e.g. `AUTH_TOKEN=bearer.foo`) redact.

## Done summary

## Evidence
