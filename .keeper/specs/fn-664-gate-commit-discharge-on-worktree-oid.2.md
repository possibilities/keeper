## Description

**Size:** M
**Files:** src/reducer.ts, test/reducer.test.ts, CLAUDE.md, README.md

### Approach

Make `foldCommit` (src/reducer.ts:2248) content-aware using the oids plumbed
in task `.1`. This is a **write-site fix** — the four discharge READ
predicates (`:1812`, `:1868-1881`, `:1934-1951`, `:1966-1973`) stay
byte-identical; only what `foldCommit` writes changes.

For each `(session, file)` the commit would discharge: compare the commit's
per-file committed `blob_oid` against the file's current `worktree_oid`
stored on its `file_attributions` row (written by the latest GitSnapshot fold
in task `.1`). Stamp `last_commit_at` (discharge) ONLY when
`committed_blob_oid == worktree_oid` AND the worktree mode matches the
committed mode (so a chmod-only dirty file with an equal content oid is NOT
wrongly discharged). When EITHER oid is NULL — pre-bump events, racy-clean,
inferred/untracked entries — fall back to the existing UNCONDITIONAL
timestamp discharge, traversing the *same code path* old events used, so a
cursor=0 re-fold of NULL-oid history reproduces byte-identical projections.
Apply symmetrically in both `foldCommit` branches (per-session and global).

Then revise the discharge-rule prose + payload shapes + version line in
CLAUDE.md (event-sourcing invariants bullet) and README.md (## Architecture,
~800-831 + SQL comment ~1171-1175).

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:2248-2316 — foldCommit (per-session loop :2282, global loop :2306) — the write site to gate
- src/reducer.ts:1760-1768 — pass-1 UPSERT (now stamps worktree_oid per task .1; the value foldCommit reads back)
- src/reducer.ts:1812 / :1868-1881 / :1934-1951 / :1966-1973 — the 4 discharge read predicates (LEAVE byte-identical)
- test/reducer.test.ts:1531 (discharge happy path), :1611 (re-discharge re-arm — new case beside it), :1688 (global discharge), :2728 TEST_OID fixture
- CLAUDE.md event-sourcing invariants bullet; README.md ~800-831

**Optional** (reference as needed):
- src/reducer.ts:1788-1806 — the comment describing the emergent bash re-arm (context for why this is a new mechanism)

### Risks

- **Re-fold determinism** — the worktree_oid MUST be read from already-folded
  `file_attributions` state (event-derived), never a fresh git probe; the
  NULL-oid fallback MUST be the identical path old events used or re-fold diverges.
- **Mode-only chmod** — equal content oid but dirty via mode; the `mW == committed mode`
  guard prevents a wrong discharge (handled here, not deferred).
- **Multi-session co-attribution** — oid is a file property, discharge is
  per-session: if the worktree matches session A's committed blob, A's claim
  legitimately discharges; a session B residual edit makes worktree_oid differ
  so B stays attributed. Verify the per-session scoping holds in a co-attribution test.
- **Rename source-path (`orig_path`) discharge gap is PRE-EXISTING and OUT OF SCOPE.**
- **`--allow-empty` / zero-file commit** — confirm the existing `files.length === 0` no-op is unregressed.

### Test notes

- NEW failing case beside test/reducer.test.ts:1611 — stage → re-edit → commit
  where `committed_oid != worktree_oid`: the file STAYS in `attributions[]`
  and does NOT increment `orphanCount`.
- Discharge-still-works case: `committed_oid == worktree_oid` → claim retired exactly as before.
- NULL-oid regression: an old-style Commit/GitSnapshot with no oids → discharge
  on the timestamp path, identical to today.
- Re-fold determinism: cursor=0 re-drain reproduces byte-identical `git_status` + `file_attributions`.

## Acceptance

- [ ] A stage → re-edit → commit file (`committed_oid != worktree_oid`) retains attribution and is NOT orphaned.
- [ ] A commit that captured the worktree (`committed_oid == worktree_oid`) still discharges exactly as today.
- [ ] A chmod-only dirty file (equal content oid, differing mode) is NOT wrongly discharged.
- [ ] NULL-oid events discharge on the timestamp fallback path; cursor=0 re-fold is byte-identical.
- [ ] The four discharge read predicates are unchanged (write-site fix); CLAUDE.md + README.md prose updated.

## Done summary
foldCommit now gates discharge on per-file (blob_oid, committed_mode) equality against the file's stored (worktree_oid, worktree_mode). The stage->re-edit->commit orphan no longer fires: the worktree diverges from the committed bytes, the gate suppresses discharge, the editing session keeps its attribution claim. Falls back to today's unconditional timestamp discharge on any null axis so cursor=0 re-fold over pre-v44/v45 history is byte-identical. Symmetric across per-session and global discharge. Schema bumped to v45 (file_attributions.worktree_mode); keeper-py SUPPORTED_SCHEMA_VERSIONS adds 45. The four discharge READ predicates are byte-identical — only the WRITE site changed.
## Evidence
