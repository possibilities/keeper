## Description

Fixes F1 (merges F4). In `src/provider-leg-death-notice.ts`,
`redactAbortEvidence` (function at ~:263, regexes `SENSITIVE_KEY_RE` ~:235
and `BEARER_RE` ~:239) leaks an opaque bearer token: on
`Authorization: Bearer <token>`, `SENSITIVE_KEY_RE`'s `AUTH` key arm matches
the `Authorization` key and captures `Bearer` (the `\S+` value) for
redaction, leaving `<token>` and destroying the `Bearer ` prefix that
`BEARER_RE` (which runs next) needs — so a non-JWT opaque token survives.
Evidence path: read `redactAbortEvidence` and trace
`Authorization: Bearer <opaque-token>` through the three redaction arms in
order.

Fix (pick the cleanest): run `BEARER_RE` before `SENSITIVE_KEY_RE`, or drop
the `AUTH` arm from `SENSITIVE_KEY_RE` (the bearer arm already covers
Authorization headers), or exclude scheme keywords from the key regex's
`\S+` value capture. Keep the "fails toward more redaction" intent — do not
weaken existing key/JWT/token coverage, and keep SHAs and UUIDs preserved as
forensic correlators.

F4 (merged): add the currently-missing regression test in the
`redactAbortEvidence` test file covering
`Authorization: Bearer <opaque-non-JWT-token>` end to end.

Files: `src/provider-leg-death-notice.ts` and its redaction test.

## Acceptance

- [ ] `Authorization: Bearer <opaque-non-JWT-token>` redacts the token, leaving the scheme/key structure intact
- [ ] JWT-shaped bearer, key-denylist `KEY=value`, and token-shape cases still redact; SHAs/UUIDs still survive
- [ ] A new regression test directly exercises the opaque-bearer path

## Done summary

## Evidence
