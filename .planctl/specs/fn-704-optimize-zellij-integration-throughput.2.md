## Description

**Size:** S
**Files:** src/tab-namer-worker.ts, src/zellij-events-worker.ts, src/daemon.ts, README.md

### Approach

Add durable, env-gated tracing to confirm (or rule out) the suspected loop:
feed -> `backend_exec_tab_name` write -> `data_version` bump -> tab-namer kick
(fn-699) -> `rename-tab-by-id` -> TabUpdate -> bridge re-emit -> feed. Mirror
the established `KEEPER_TRACE_SERVER` convention (src/server-worker.ts:326-372)
EXACTLY: read each flag once at module load into a `const`
(`KEEPER_TRACE_TABNAMER`, `KEEPER_TRACE_ZELLIJ`), gate AT THE CALL SITE so the
template literal never allocates when off, trace to `console.error` in an
awk-parseable shape, on a rolling window.

tab-namer side (`KEEPER_TRACE_TABNAMER`): count renameTab shell-outs at the
ACTUAL `backend.renameTab(...)` call site (tab-namer-worker.ts:354) — AFTER
the convergence (:331), memo (:339), and empty-name (:324) gates, so the count
reflects real shell-outs not suppressed iterations — plus kicks received
(:484-490).

zellij/`data_version` side (`KEEPER_TRACE_ZELLIJ`): instrument BOTH signals,
because they measure different things and the RATIO is the loop diagnosis —
(a) `zellij-events-changed` notifications posted by the worker
(zellij-events-worker.ts:150,216) = raw input pressure from the bridge's write
volume; (b) actual `BackendExecSnapshot` mints in main's `scanZellijEventsDir`
(daemon.ts:876-911) = the real `data_version`-bumping loop driver (the worker
has NO DB handle by design — sole-writer rule — so the true bump is only
observable at main's mint site). A high notification rate with a low mint rate
means the feed is noisy-but-harmless (Task 1 territory); a high mint rate that
tracks rename shell-outs confirms the loop.

All counter code is allocation-free and exception-free when flags are off, and
MUST NOT throw inside the kick/tick handlers or main's drain (no-self-heal:
an uncaught throw bounces the daemon). daemon.ts is a heavily-shared file —
keep its edit additive and fully env-gated. Add a short "how to read the
trace" note (which numbers indicate the loop) alongside the README env-var
entries.

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts:326-372 — `const TRACE` env read, call-site gate, `formatStages` awk-parseable shape (the pattern to mirror)
- src/tab-namer-worker.ts:277-394 — `runTick`; :354 `renameTab` call site; :324/:331/:339 gates; :484-490 kick handler
- src/zellij-events-worker.ts:150,216 — notification-post sites (worker has no DB)
- src/daemon.ts:662 — `scanZellijEventsDir`; :876-911 — `BackendExecSnapshot` mint (the actual data_version bump)
- README.md ~441-465 — `KEEPER_TRACE_SERVER` env-var reference block (add the two new vars HERE, do not scatter)

**Optional**:
- src/exec-backend.ts:1063 — `renameTab` returns `{ok}|{ok:false,error}`, never throws

### Risks

- Counters must not throw inside kick/tick handlers or main's drain (no-self-heal escalates to fatalExit).
- Env read once into a `const` + call-site gate — a per-shell-out template literal that allocates when off defeats the convention.
- daemon.ts is shared and re-fold-sensitive; the mint-site counter must be a pure additive increment behind the flag, touching no fold/projection logic.

### Test notes

Verify each counter increments only behind its flag and is a no-op when off
(mirror the `KEEPER_TRACE_SERVER` test approach). The trace itself is read by a
human on a live busy session, not asserted in CI.

## Acceptance

- [ ] `KEEPER_TRACE_TABNAMER` gates tab-namer counters (renameTab shell-outs past the memo/convergence gates + kicks received); read once into a `const`, call-site gated
- [ ] `KEEPER_TRACE_ZELLIJ` gates BOTH notification-posts/sec (worker) and `BackendExecSnapshot` mints/sec (main `scanZellijEventsDir`)
- [ ] Trace lines go to stderr, awk-parseable, on a rolling window; counters never throw
- [ ] Zero allocation and zero behavior change when both flags are off
- [ ] README env-var reference updated with both new `KEEPER_TRACE_*` vars (name, purpose, default, how to flip) + a short "how to read the trace to spot the loop" note
- [ ] Lands independent of `.1` (no shared files beyond docs; deps empty)

## Done summary

## Evidence
