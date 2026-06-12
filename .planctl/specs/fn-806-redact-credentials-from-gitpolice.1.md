## Description

Originating finding F4 (auditor Test Gaps + Security Notes). Evidence path:
`gitpolice/watch.ts:321` sets `argv: inv.argv` (raw post-tokenize argv) on
every census record while `command` is set to the `redactCommand`-scrubbed
string; `lib/git-detect.ts:472` `redactCommand` only operates on the
command string; `gitpolice/watch.ts:677` `appendCensus` JSON-stringifies
the whole record, so a credential embedded as a bare argv token
(`git remote add o https://u:pass@host`) is persisted un-redacted in the
`argv` field. This contradicts `redactCommand`'s doc-comment ("a census
never persists an embedded credential").

Redact URL userinfo from the persisted argv (element-wise via the same
`redactCommand` surface, or drop argv for the affected write-class remote
ops), and reconcile the `redactCommand` doc-comment with the actual
redaction surface so the stated invariant is true. Keep the change inside
the degrade-don't-throw, read-only-observer contract.

## Acceptance

- [ ] A census record built from `git remote add o https://u:pass@host` persists no credential in any field (`command` AND `argv`).
- [ ] `redactCommand`'s doc-comment accurately describes the redaction surface after the fix.
- [ ] A unit test asserts the redacted argv (or its omission) for a bare-token credential.

## Done summary
Redact URL userinfo from persisted census argv element-wise via redactCommand, closing the at-rest credential leak; reconciled redactCommand doc-comment and added a bare-token argv redaction test.
## Evidence
