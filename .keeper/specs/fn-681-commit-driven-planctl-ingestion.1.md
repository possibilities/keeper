## Description

**Size:** M
**Files:** src/git-worker.ts, src/plan-worker.ts, src/protocol.ts, src/types.ts, test/git-worker.test.ts, test/plan-worker.test.ts

Make a committed planctl mutation in a keeper-tracked repo the authoritative
ingest trigger: git-worker tells plan-worker exactly which `.planctl/**/*.json`
files changed in the commit delta, and plan-worker re-ingests those from
committed state via its existing idempotent path. Drop-proof and free of the
mid-write partial-read race.

### Approach

git-worker already enumerates the HEAD delta and per-commit changed files
(`enumerateCommitsInDelta`/`commitFiles`, `git-worker.ts:775-875`) and
already posts a bare `recheck-pending` to plan-worker on commit
(`:1752-1754`). Enrich that cross-worker message (or add a sibling message
type in `src/protocol.ts`) to carry: the committing repo root + the list of
changed `.planctl/{epics,tasks}/*.json` and `.planctl/state/tasks/*.state.json`
paths, each tagged add/update vs delete (delete = mode null in `commitFiles`).
Filter the delta to planctl paths git-worker-side so plan-worker gets a tight
list.

In plan-worker, extend the message handler (`plan-worker.ts:1693`) to, for
each changed path, call the existing `scanner.onChange(path)` (adds/updates)
or `scanner.onDelete(path)` (deletes) — these already classify, parse, apply
the fn-629 observation gate, run the change-gate, and emit. Because the commit
has landed, the working-tree file IS the committed state (planctl commits
atomically), so `onChange`'s `readFileSync` reads a complete file — no partial
read. If a precise per-path list proves too coupled, the fallback (see epic
Early proof point) is to send repo root + HEAD oid and have plan-worker run a
scoped `scanPlanctlDir` over that repo's `.planctl`.

Keep the existing FSEvents live subscription untouched (best-effort + the
only path for uncommitted edits). The change-gate (`lastEmitted`) makes the
duplicate fire (FSEvents + commit) a no-op.

Deletion correctness: a committed `git rm` of a `.planctl/*.json` arrives in
the delta with null mode → route to `onDelete` → existing tombstone emit.
This gives commit-path deletions without relying on FSEvents delete events.

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:700-754 (`commitFiles`), :775-875 (`enumerateCommitsInDelta`), :1682-1758 region around the commit→plan-worker post (`:1752-1754`)
- src/plan-worker.ts:1693 (recheck-pending handler), :853-984 (`onChange`/classify/parse/gate/emit), the `onDelete` path, :1659-1665 (PlanScanner wiring)
- src/protocol.ts — existing worker message type shapes to mirror
- src/daemon.ts:1675-1758 — how git-worker messages are received and how the cross-worker signal to plan-worker is delivered

**Optional** (reference as needed):
- src/plan-worker.ts:240-270 (IGNORE_GLOBS / PRUNE_DIRS — confirm planctl path classification)
- test/git-worker.test.ts, test/plan-worker.test.ts — existing message + ingest test patterns

### Risks

- Cross-worker coupling: the commit→plan message currently goes git-worker→main→plan-worker (or direct). Confirm the actual delivery path in daemon.ts before changing the payload; don't break the existing `recheck-pending` semantics (uncommitted-file drain) — extend, don't replace, unless the new path subsumes it.
- Path classification must match plan-worker's `classifyPlanPath` exactly so git-worker's filter and plan-worker's ingest agree.
- A commit touching many `.planctl` files (large scaffold) must not flood — batch the path list in one message.

### Test notes

`test/git-worker.test.ts`: a commit touching `.planctl/epics/*.json` emits a
message carrying the correct repo + changed-path list with add/update/delete
tags. `test/plan-worker.test.ts`: handling that message calls
`onChange`/`onDelete` per path and emits the right plan messages; a file
whose content is unchanged from the gate emits nothing (idempotent);
simulate the FSEvents-dropped scenario (no live event) and assert the commit
message alone drives correct ingest.

## Acceptance

- [ ] git-worker emits, on commit, the committing repo + changed `.planctl/**/*.json` paths tagged add/update/delete, filtered to planctl paths
- [ ] plan-worker re-ingests each changed path via `onChange`/`onDelete` from committed state, with no partial-read exposure
- [ ] A committed `git rm` of a planctl JSON produces a tombstone via the commit path (no FSEvents dependency)
- [ ] Duplicate fires (FSEvents + commit) are no-ops via the change-gate; existing `recheck-pending` (uncommitted drain) semantics preserved
- [ ] New/extended message type lives in `src/protocol.ts` with types in `src/types.ts`; `bun test`, typecheck, lint pass

## Done summary
Wired commit-triggered planctl ingest: git-worker filters each commit's diff-tree file list to planctl-shaped paths and posts a sibling planctl-commit-changed message tagging upsert/delete; main forwards it to plan-worker, which re-ingests via the existing onChange/onDelete pipeline against committed worktree bytes (drop-proof, no partial-read race). Reducer untouched — re-fold determinism preserved.
## Evidence
