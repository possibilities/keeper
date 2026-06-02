## Description

**Size:** M
**Files:** src/daemon.ts, src/restore-worker.ts, README.md, CLAUDE.md

### Approach

Spawn the tab-namer worker beside `restoreWorker`: `new Worker(new
URL("./tab-namer-worker.ts", import.meta.url).href, {workerData: {dbPath}
satisfies TabNamerWorkerData})`, `onerror` -> `fatalExit`,
`addEventListener("close", () => { if (!shuttingDown) fatalExit(); })`, NO
`onmessage` (pure consumer). Add it to ALL THREE shutdown lists: the SIGTERM
`postMessage({type:"shutdown"})` fan-out, the `exited()` await list, and the
`terminate()` list — missing any one leaks the thread. Bump worker-count prose:
`src/daemon.ts` header + inline "TEN"/"ALL TEN" (~12, 52, 2345, 2432-2435) ->
eleven; `src/restore-worker.ts` header (~4-5) "TENTH" + the sibling enumeration ->
add the tab-namer.

Docs: README.md — add an eleventh-worker paragraph (model on the tenth /
restore-snapshot paragraph ~1427); bump "The ten workers..." -> eleven (both
occurrences ~1449); add `renameTab` to the `ExecBackend` op list (~1372).
CLAUDE.md — revise the fn-678 bullet's closing sentence (~357-375): dispatch
dedup still never reads the tab name (fn-678 stands), but `renameTab` is now a
real op used by the tab-namer worker, so "exposes only launch, closeByTabId,
focusPane, resolveTabForPane" is stale — add `renameTab` and name the worker as
the aesthetic side-effector.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts — `restoreWorker` spawn block (~2361-2375): the exact template (workerData, onerror, close, no onmessage)
- src/daemon.ts — shutdown fan-out (~2412-2430), `exited()` await (~2442-2459), `terminate()` (~2463-2517): the three lists to extend
- src/daemon.ts — header + inline worker-count prose (~12, 52, 2345, 2432-2435)
- src/restore-worker.ts — header (~1-44, esp 4-5): the "TENTH" + sibling list to bump
- README.md — `ExecBackend` op list (~1372), worker enumeration + count (~1427-1449)
- CLAUDE.md — the fn-678 bullet (~357-375)

### Risks

- Missing one of the three shutdown lists (postMessage / exited / terminate) leaks the worker thread at shutdown — verify all three.
- Worker-count drift spans two source files plus README; `grep -rn "TEN\|TENTH\|ALL TEN" src/` and re-read the README count to confirm none stale.

### Test notes

- `bun test` (full suite) green.
- Daemon boots with the new worker and shuts down cleanly (no worker hung at the shutdown deadline).
- `grep -rn "TEN\|TENTH\|ALL TEN" src/daemon.ts src/restore-worker.ts` shows no stale worker-count references; README count reads eleven.

## Acceptance

- [ ] Daemon spawns the tab-namer worker after migrate + boot drain beside `restoreWorker`, with `onerror`/`close` -> `fatalExit` and no `onmessage`
- [ ] Worker is in all three shutdown lists (postMessage fan-out, `exited()` await, `terminate()`)
- [ ] Worker-count prose bumped to eleven/eleventh in `src/daemon.ts` and `src/restore-worker.ts`; no stale TEN/TENTH worker-count refs (grep-verified)
- [ ] README documents the eleventh worker + updated count + `renameTab` in the `ExecBackend` op list; CLAUDE.md fn-678 sentence revised + op list updated
- [ ] `bun test` full suite is green

## Done summary

## Evidence
