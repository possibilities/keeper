## Description

**Size:** M
**Files:** src/reducer.ts, test/reducer.test.ts

### Approach

Make deletions/renames attributable via the EXPLICIT pass (pass 1), which has
no mtime guard — sidestepping the null-mtime inference gap entirely. Today
`findExplicitAttributions` bash-matches via SQL `json_each(targets) WHERE
j.value = ?` (exact). Add prefix + glob matching for the new deletion kinds:
since SQL can't glob, pull candidate `git-rm`/`git-mv` events (narrowed by a
`bash_mutation_kind IN (...)` scan, ideally a partial index) into JS and match
each captured token against the dirty file's `path`/`orig_path` by: (a) exact,
(b) directory-prefix (token has no glob + no trailing `/` → `file === token ||
file.startsWith(token + '/')`), (c) hand-rolled fnmatch. The fnmatch is
dependency-free (hook forbids third-party deps; keep it reducer-side only):
`*`→`[^/]*`, `?`→`[^/]`, escape other regex metachars, anchor `^$`, cache
compiled RegExp in a module Map, no `**`/nested quantifiers. CRITICAL: the
prefix/glob path must skip the literal `__TREE__` sentinel so a tree-mutate
event can't match real files. Feed matches into the SAME file_attributions
UPSERT (newest-wins) — no second write path. The per-job rollups (orphan
counts) then re-count correctly with no rollup code change.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:1181-1292 — findExplicitAttributions (bash exact-match
  1250-1289; candidate paths from `<root>/<path>` + `<root>/<orig_path>`)
- src/reducer.ts:1327-1389 — findInferredAttributions (null-mtime early-return
  :1332 — the gap we route around; do NOT add an mtime guard to pass 1)
- src/reducer.ts:1454-1541 — projectGitStatus pass 1/2 + rollups
- src/derivers.ts:615 — TREE_SENTINEL (the token to exclude)
- test/reducer.test.ts:53-54/94-95 (bash_mutation overrides), :220-403 (orphan/
  attribution fold assertions — template), :253 (deleted-file `xy:" D"` fixture)

### Risks

- Sentinel collision: a `git checkout` event carries `__TREE__`; the new
  prefix/glob must never match it to a real path. Test this explicitly.
- fnmatch ReDoS / over-match (`*` crossing `/`). Anchor + `[^/]*` only.
- The SQL→JS boundary moves; keep it deterministic (no wall-clock, no FS) so
  re-fold stays byte-identical.

### Test notes

Negative control: a plain modification still attributes via exact match
(unchanged). Positive: deleted file matched by exact token, by `-r dir/`
directory-prefix, by `'*.ts'` glob; rename matched on both src and dst; a
`__TREE__` event attributes nothing. Assert orphan_count drops.

## Acceptance

- [ ] Deleted/renamed dirty files gain attribution via pass-1 exact +
  directory-prefix + fnmatch against git-rm/git-mv targets.
- [ ] `__TREE__` never prefix/glob-matches a real file.
- [ ] Plain modifications still attribute exactly as before (negative control).
- [ ] fnmatch is dependency-free and reducer-side only; `*` does not cross `/`.
- [ ] Matching is pure (re-fold deterministic); new + existing reducer.test.ts
  pass.

## Done summary
Reducer's findExplicitAttributions now matches snapshot-known deleted/renamed paths against git-rm/git-mv bash_mutation_targets via exact / directory-prefix / hand-rolled fnmatch (no third-party deps); __TREE__ sentinel rejected up front so tree-mutate events can't cross-match real files; six new GitSnapshot tests cover all match modes plus negative controls.
## Evidence
