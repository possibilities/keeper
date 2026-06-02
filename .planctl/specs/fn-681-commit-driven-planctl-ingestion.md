## Overview

Make keeper's planctl-tree ingestion robust against FSEvents drops and
mid-write partial reads by triggering ingestion off **git commits** instead
of relying solely on broad recursive `@parcel/watcher` watching of `~/code`.

**Why.** keeper's `plan-worker` watches the whole `~/code` root recursively.
FSEvents drops events at the kernel/client buffer level *before* userspace
`IGNORE_GLOBS` filtering, so unrelated churn anywhere under `~/code` (a build,
an `npm install`, another repo's git ops) can overrun the buffer and silently
drop a `.planctl` write. We hit this: a fresh `planctl scaffold` of a new
epic (9-file burst) was dropped, so keeper ingested a stale/partial epic row
(null `last_validated_at`, missing title) and — because the file never
changed again — stayed wrong for a non-brief window until the debounced
O(`~/code`) drop-rescan eventually healed it.

**Approach (mostly wiring existing parts).** `git-worker` already (a) watches
each tracked repo's `.git` common-dir and fires on every commit
(`git-worker.ts:1420-1441`), (b) computes per-commit changed files +
committed blob oids (`commitFiles`/`enumerateCommitsInDelta`,
`:700-875`), (c) enumerates planctl-backed repos (`discoverProjectRoots`,
`:930-974`), and (d) already posts a `recheck-pending` signal to plan-worker
on commit (`:1752-1754`). plan-worker already has an idempotent per-file
re-ingest (`onChange`, `:853-984`), a per-`.planctl`-dir scan primitive
(`scanPlanctlDir`, `:1385`), and a change-gate that suppresses no-op
re-emits. We connect these into three layers:

1. **Commit-triggered ingest (authoritative).** Enrich the git-worker→plan-worker
   commit signal to carry the committing repo + its changed `.planctl/**/*.json`
   paths (adds/updates/deletes). plan-worker re-ingests exactly those files from
   the **committed** working tree via `onChange`/`onDelete`. This collapses a
   9-file scaffold burst into one drop-proof event and eliminates the
   partial-read race (committed state is never half-written).
2. **Periodic reconcile backstop (catches the new-repo + dropped-event case).**
   A low-frequency heartbeat does a *shallow* discovery of `<root>/*/.planctl`
   dirs and runs `scanPlanctlDir` on each (idempotent via the change-gate).
   This is the layer that fixes the exact bug we hit: a brand-new repo's FIRST
   scaffold can't be commit-triggered (git-worker isn't watching that repo's
   `.git` until an epic row for it exists in the DB), so a cheap periodic
   `.planctl` reconcile is what guarantees timely convergence.
3. **Targeted drop recovery.** Replace the on-drop rescan's whole-root
   `scanRoot` walk with a `.planctl`-scoped scan over the discovered set, so
   recovery is O(#projects) not O(`~/code`) — sub-second instead of "not brief".

The existing FSEvents live watch stays as a best-effort sub-second path
(and the only path for *uncommitted* working-tree edits, which are rare for
planctl). No big-bang removal — every layer is additive and independently
valuable.

## Quick commands

- `bun test --isolate test/plan-worker.test.ts test/git-worker.test.ts test/rescan.test.ts`
- `bun run typecheck`
- `bun run lint`
- Manual proof: in a fresh repo, `planctl init && planctl scaffold ...`, then confirm `keeper board` shows the epic `[validated]` within the reconcile interval even with FSEvents under load.

## Acceptance

- [ ] A `planctl` commit in a keeper-tracked repo drives plan-worker to re-ingest exactly the changed `.planctl/**/*.json` from committed state (add/update/delete), without depending on FSEvents delivery
- [ ] A brand-new repo's first scaffold converges in keeper within the reconcile interval even if its FSEvents burst is dropped and git-worker isn't yet watching it
- [ ] On an FSEvents drop, recovery rescans only `.planctl` dirs (O(#projects)), not the whole `~/code` tree
- [ ] The partial-read race cannot produce a null-marker/missing-title row via the commit path (committed state only)
- [ ] No regression in deletion handling or the change-gate no-op suppression; `bun test`, typecheck, lint all pass

## Early proof point

Task that proves the approach: the first task (commit-triggered ingest). If
it fails (git-worker can't cheaply hand plan-worker the changed-path list, or
cross-worker message coupling is too invasive): fall back to having the
commit signal carry only the repo root + HEAD oid and let plan-worker run a
scoped `scanPlanctlDir` on that repo's `.planctl` — still drop-proof, just
coarser than a precise changed-file list.

## References

- `src/git-worker.ts:1420-1441` — `.git` common-dir watch (fires on commit); `:700-754` `commitFiles`; `:775-875` `enumerateCommitsInDelta`; `:930-974` `discoverProjectRoots`; `:1505-1528` `reconcileRoots`; `:1596-1605` 60s heartbeat; `:1752-1754` existing `recheck-pending` post to plan-worker
- `src/plan-worker.ts:1693` `recheck-pending` handler; `:853-984` `onChange` (idempotent single-file ingest) + `onDelete`; `:1336-1483` `scanRoot`; `:1385` `scanPlanctlDir`; `:1063-1107` `sweep` (deletion retraction); `:240-270` IGNORE_GLOBS/PRUNE_DIRS; `:1659-1665` PlanScanner instantiation; `:1778-1800` RescanScheduler wiring
- `src/rescan.ts:45-62` `isDropError`; `:103-158` `RescanScheduler` (500ms debounce, single-flight, dirty bit)
- `src/daemon.ts:1424-1432` plan-worker spawn; `:1675-1758` git-worker onmessage → synthetic event insert + cross-worker signal
- `src/protocol.ts` — worker message type definitions (new/enriched commit→plan message)
- Incident: `~/.local/state/keeper/server.stderr` `[plan-worker] watcher error for /Users/mike/code: Events were dropped by the FSEvents client. File system must be re-scanned.`

## Docs gaps

- **keeper architecture docstrings** (`src/plan-worker.ts` / `src/git-worker.ts` module headers): document the commit-triggered ingest channel + reconcile backstop as the authoritative path, FSEvents as best-effort.
- **`README.md` / CLAUDE.md** (if they describe the ingestion model): note the three-layer ingest (commit-trigger / periodic reconcile / FSEvents live) and the FSEvents-drop rationale.

## Best practices

- **FSEvents drops happen below userspace** — ignore globs reduce processing, not the kernel event volume that overruns the buffer; don't treat them as drop protection.
- **Read committed state, not the working-tree file, on the commit path** — that's what removes the mid-write partial-read race.
- **Keep ingest idempotent** — reuse the existing change-gate so commit-trigger + reconcile + FSEvents can all fire for the same change without duplicate emits.
- **Producer-worker contract** — workers never throw on a bad read; fold to null/empty and let the next trigger retry (mirror git-worker's existing discipline).
- **Additive reconcile** — the periodic backstop should re-ingest (not retract); leave deletion semantics to the commit path (`git rm`) and existing sweep to avoid false tombstones.
