## Overview

The gitpolice sitter scrubs URL userinfo from the persisted `command`
string via `redactCommand`, but the census record also carries the raw
post-tokenize `argv` array un-redacted. A credential passed as a bare argv
token (e.g. `git remote add o https://u:pass@host`) therefore lands at rest
in the census file even though `command` is clean. This is a local
(user-owned `~/.local/state/babysitters/gitpolice/`) at-rest credential
leak that also contradicts `redactCommand`'s own doc-comment claim that "a
census never persists an embedded credential". Closing the gap keeps the
read-only-observer's on-disk footprint credential-free.

## Acceptance

- [ ] No persisted census record retains URL userinfo in any field, including `argv`.
- [ ] The `redactCommand` doc-comment matches the actual redaction surface (or argv is dropped for the affected class).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | resolveSnapshot N+1 is bounded (batch cap 500, write-class only) and auditor-confirmed fine to ship; no user-noticeable impact today. |
| F2 | culled | — | join(path, '..') vs dirname(path) is a readability nitpick; code is correct and matches the performance-sitter pattern. |
| F3 | culled | — | Empty-batch cursor advance is intended, documented in-comment, and covered by the appendCensus empty-batch test. |
| F4 | kept | .1 | gitpolice/watch.ts:321 persists base.argv=inv.argv raw while only command is scrubbed (lib/git-detect.ts:472), leaking a credential to the census via appendCensus (:677). |
| F5 | culled | — | Absent git_status row is already handled (?? null); a lone missing-test on a defensive, correct path with no user impact. |

## Out of scope

- resolveSnapshot N+1 batching (F1) — deferred; bounded and not user-noticeable.
- dirname-readability and empty-batch-advance call-outs (F2, F3) — intended/correct as shipped.
- Test-only coverage gap on the absent git_status path (F5).
