## Overview

`bashTargetMatches` skips directory-prefix matching when the token ends
with `/`. The deriver's `resolveAgainstCwd` preserves trailing slashes
from natural `git rm -r dir/` input, so slash-terminated tokens reach the
matcher and silently fail to attribute any files under that directory.
The fix is a one-line normalization (strip the trailing slash before
the `endsWith` guard) plus a reducer test covering the slash-terminated
input form.

## Acceptance

- [ ] `bashTargetMatches` correctly attributes files under a directory when
      the token ends with `/` (e.g. `/repo/dir/` matches `/repo/dir/file.ts`)
- [ ] A reducer test covers the slash-terminated directory-prefix case end-to-end
- [ ] No regression in the existing no-slash directory-prefix test

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1     | kept   | .1   | Confirmed at reducer.ts:1305 — `!token.endsWith("/")` guard skips directory-prefix for slash-terminated tokens; deriver test shows `git rm -r dir/` → `["/repo/dir/"]` with slash preserved; no reducer test covers this path |
| F2     | culled | —    | Speculative — auditor rates git mv producing two separate dirty entries as extremely unlikely; no concrete user impact surfaced |

## Out of scope

- Normalizing trailing slashes in the deriver (reducer-side fix is sufficient and consistent with the existing no-slash test)
- Glob or exact-match behavior (unaffected by this gap)
