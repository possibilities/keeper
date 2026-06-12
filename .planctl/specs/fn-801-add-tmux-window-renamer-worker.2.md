## Description

**Size:** M
**Files:** src/renamer-worker.ts, src/daemon.ts, test/renamer-worker.test.ts, test/daemon.test.ts, README.md

### Approach

New `src/renamer-worker.ts` from the restore-worker main() skeleton:
isMainThread guard, own `openDb(dbPath, {readonly:true,
prepareStmts:false, bootRetry:true})`, `{type:"shutdown"}` handling,
initial pulse before the loop (names already-resident sessions at boot),
then `watchLoop` (import from wake-worker — never re-implement the
data_version poll).

Each pulse, all pure-decision driven:
1. Read `jobs` via the shared `runQuery` seam (the
   autopilot/restore-worker read pattern).
2. Candidates: `state IN (working, stopped)` AND
   `backend_exec_type === "tmux"` AND non-null `backend_exec_pane_id`
   AND non-empty `title`.
3. Input-side dedup gate: hash the stable-sorted
   `(pane_id, title, created_at, state)` tuples (Bun.hash, mirroring
   restore-worker's hashPairs); unchanged since last pulse → skip
   entirely. This keeps unrelated data_version churn (every hook event)
   from spawning tmux ~dozens of times per second. Zero candidates →
   quiescent, no tmux spawn.
4. `backend.listPanes()` — `null` → skip cycle (degraded tmux).
5. Pure `computeRenames(candidates, panes)`: join by pane id, group by
   window id, winner = max `created_at` (tie → higher `job_id`), target
   = winner's `title` verbatim; emit `{windowId, name}` ONLY where the
   sweep's `windowName !== target` (every rename permanently suppresses
   that window's automatic-rename — matching names must not re-rename;
   suppression is deliberately left in place, tmux fighting back is
   worse than a stale name on a dead window).
6. Fire `renameWindow` per entry; each failure (TOCTOU window-close) is
   a logged non-fatal skip; the pulse never throws (try/catch per pulse,
   "non-fatal" stderr, next pulse retries).

No DB writes, no worker→main messages beyond lifecycle: daemon wiring
has NO onmessage minter — only onerror + close → fatalExit.

Registration ritual (all sites, same change): `WorkerName` union +
`ALL_WORKERS` (daemon.ts:1050,1070), `want("renamer")` spawn site
(template: restore-worker block at daemon.ts:3306-3371 minus onmessage),
`spawnedWorkers[]` teardown (daemon.ts:3429), `ALL_WORKERS` pin in
test/daemon.test.ts:3202. Do NOT add to WATCHER_WORKERS (no
@parcel/watcher). README: bump "ten workers" → eleven + a renamer
paragraph after the restore-worker one.

### Investigation targets

**Required** (read before coding):
- src/restore-worker.ts:886-991 — worker main() skeleton to copy
- src/restore-worker.ts:580-704 — sweep gate + hashPairs dedup shape to mirror on the input side
- src/wake-worker.ts:75-97 — watchLoop signature
- src/autopilot-worker.ts:1307-1319 — runQuery read seam
- src/daemon.ts:1050-1091,3306-3371,3429-3478 — registration, spawn template, teardown
- test/restore-worker.test.ts:113-167 — freshMemDb + insertJob pure-decision test pattern

**Optional** (reference as needed):
- src/types.ts:257-411 — Job fields read by the decision fn
- test/daemon.test.ts:3202-3233 — the ALL_WORKERS pin to update

### Risks

- Pulse-rate churn: without the input-side dedup hash the worker spawns
  tmux on every data_version bump (constant during active sessions).
  The hash gate is load-bearing, not an optimization.
- created_at ties must break deterministically (job_id) or window names
  flicker between equal-aged sessions every pulse.

### Test notes

Pure-decision tests via freshMemDb + raw insertJob (no tmux, no Worker
spawn): winner selection (latest created_at, job_id tiebreak), mismatch
filter, NULL-pane/NULL-title exclusion, dedup-hash skip, empty-candidate
quiescence. Worker lifecycle covered by the daemon ALL_WORKERS pin +
test:full tier. retryUntil for any async assertion, never Bun.sleep.

## Acceptance

- [ ] Windows hosting live Claude sessions get renamed to the winning job title; latest-appeared wins with deterministic tiebreak
- [ ] Renames fire only on name mismatch; unchanged job picture skips the tmux sweep entirely (hash gate)
- [ ] Degraded tmux (null sweep) and TOCTOU rename failures are non-fatal skips; pulse never throws
- [ ] Worker registered at all 4 sites incl. test pin; absent from WATCHER_WORKERS; teardown clean
- [ ] No DB writes; no worker→main messages beyond lifecycle
- [ ] README eleventh-worker paragraph landed; `bun run test:full` passes

## Done summary
Added the eleventh keeperd worker (renamer-worker): a pure external actuator that names each tmux window after its winning live-job title (latest created_at wins, job_id tiebreak), renames only on mismatch, and gates the tmux sweep behind an input-side candidate hash. Wired at all daemon sites incl. the ALL_WORKERS test pin, absent from WATCHER_WORKERS, with a README eleventh-worker paragraph.
## Evidence
