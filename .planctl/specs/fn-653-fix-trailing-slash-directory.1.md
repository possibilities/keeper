## Description

Originating finding F1: `bashTargetMatches` at `src/reducer.ts:1305`
guards directory-prefix matching with `!token.endsWith("/")`. The
deriver's `resolveAgainstCwd` preserves trailing slashes from user input
(`git rm -r dir/` → `["/repo/dir/"]`), so slash-terminated tokens skip
the prefix branch entirely — files under `dir/` are silently unattributed.

Fix: strip the trailing `/` from `token` at the top of `bashTargetMatches`
(before the `endsWith` check), or normalize in `resolveAgainstCwd`. Either
is sufficient; reducer-side normalization is preferred for locality.

## Acceptance

- [ ] `bashTargetMatches("/repo/dir/", "/repo/dir/file.ts")` returns `true`
- [ ] Reducer test: seed a `git-rm` event with target `["/repo/dir/"]`
      (slash-terminated) and a dirty file `dir/file.ts`; assert attribution
      lands on the session
- [ ] Existing no-slash reducer test still passes

## Done summary

## Evidence
