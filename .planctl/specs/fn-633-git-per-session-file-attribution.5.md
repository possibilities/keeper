## Description

**Size:** M
**Files:** src/git-worker.ts, src/types.ts, test/git-worker.test.ts

### Approach

Drop `liveJobsForRoot` (src/git-worker.ts:485-496) and the live-only attribution path it gates. Rewrite `buildGitSnapshot` (src/git-worker.ts:547-586) to emit a file-centric payload:

```ts
interface GitSnapshotPayloadV31 {
  project_dir: string;
  branch: string | null;
  head_oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty_files: Array<{
    path: string;
    xy: string;
    kind: 'ordinary' | 'renamed' | 'unmerged' | 'untracked';
    orig_path?: string;
    mtime_ms: number | null;  // null if stat failed (file deleted between status + stat)
  }>;
}
```

`attributions[]` is NOT computed in the producer — it lives in the reducer (task 6). The producer's job is: enumerate dirty files via `git status --porcelain=v2 -z`, `stat()` each for `mtime_ms` (via `fs.statSync(path).mtimeMs` — practice-scout confirmed this gives ms precision on APFS), embed mtime in the payload. The reducer reads payload + event log inside BEGIN IMMEDIATE to compute attribution.

Stat failures (file in `git status` but gone by stat — race) → `mtime_ms: null`. Reducer treats null as "no inferred-attribution possible for this file" and rolls forward without it.

The per-job `jobs[]` rollup carried by the old payload (src/git-worker.ts:107-130 in scripts/git.ts renderer) becomes a derived view computed by the reducer inside the same fold from `file_attributions` + the snapshot's dirty file list — not embedded in the GitSnapshot payload.

`GitSnapshotMessage` interface (src/git-worker.ts:83-86) widens to carry the new shape. The producer no longer touches `events` or computes per-(session, file) joins — that's the reducer's territory.

### Investigation targets

**Required:**
- src/git-worker.ts:485-496 — `liveJobsForRoot` (to delete)
- src/git-worker.ts:498-514 — `touchesForJob` (to delete; reducer takes over)
- src/git-worker.ts:547-586 — `buildGitSnapshot` (rewrite seam)
- src/git-worker.ts:74-86 — `GitSnapshotPayload`, `GitSnapshotMessage` shapes (widen)
- src/git-worker.ts:287-377 — `parsePorcelainV2` (no change, just consume)
- practice-scout findings: `fs.statSync().mtimeMs` is ms-precision on APFS; HFS+ is 1s; atomic-rename editors give late mtime; truncate-overwrite gives early mtime; package-lock rewrites stamp current mtime even on content-unchanged — both points say "treat as loose signal, accept inherent ambiguity"

### Risks

- stat race: file in `git status` output but deleted before stat. Emit `mtime_ms: null`. Already handled.
- Symlinks: stat follows symlinks by default. For a worktree-managed symlink we want the symlink's own mtime, not the target's — use `fs.lstatSync()` not `fs.statSync()`. Verify with a test case.
- Per-file payload size: a worktree with 10k dirty files (after a global rename or new-clone before initial add) emits a 10k-entry payload. The existing `lastByRoot` JSON dedupe absorbs no-ops but doesn't help on first emit. Acceptable — same shape as today's `dirty_files[]` count.
- Reducer-side join cost: BEGIN IMMEDIATE holds the writer lock; the discharge-rule join over events + file_attributions runs there. If the join is slow on a 100k-event log + 1k dirty files, this blocks the hook writer. Mitigation: the bash_mutation partial index from task 2 + the file_attributions indexes scope the scan. Bench under realistic load before declaring done.

### Test notes

test/git-worker.test.ts: pure-function test for `buildGitSnapshot` against a tmp repo with mixed dirty/untracked files; verify `dirty_files[].mtime_ms` is populated and `null` on simulated stat-failure (mock `fs.statSync` to throw). Verify no `events`-table query happens in the producer post-rewrite (assert via DB read-counter mock or by inspecting the SQL prepared statements the worker holds).

## Acceptance

- [ ] `buildGitSnapshot` no longer joins against `events` or `jobs` — purely composes `git status` parse + `lstat` per file
- [ ] `GitSnapshotPayload` carries `dirty_files: Array<{path, xy, kind, orig_path?, mtime_ms: number | null}>` (no per-job rollup)
- [ ] `liveJobsForRoot`, `touchesForJob`, `planctlPathsForJob` removed from src/git-worker.ts
- [ ] Stat race (file gone) emits `mtime_ms: null` without crashing
- [ ] Symlinks: `lstat` used, not `stat`
- [ ] test/git-worker.test.ts covers the new payload shape with ≥5 cases (clean, mixed-dirty, all-untracked, stat-race, symlink)

## Done summary

## Evidence
