## Description

**Size:** S
**Files:** src/exec-backend.ts, src/autopilot-worker.ts, test/exec-backend.test.ts, test/autopilot-worker.test.ts

### Approach

(a) Bound every zellij subprocess await: extend SpawnFn (src/exec-backend.ts:94-112
— currently {exited, stdout, stderr} only) with kill(), surface it from
defaultSpawn's Bun.spawn cast (:274-275), and race proc.exited against a
kill-timeout (~5s — generous for any `zellij action`) inside runCapture
(:839-860, the unbounded await is the Promise.all at :851-854). On timeout: kill
the child, return null — callers already branch on null (:880, :968-971) and the
LaunchResult {ok:false} envelope; never throw (reapSurfaces/launch are
never-throw contracts). Update every test SpawnFn stub with a kill field
(test/exec-backend.test.ts:75, 231-242, 288-291).

(b) Floor the completion-reap probe: post-fn-764 completedRowIds (built
autopilot-worker.ts:1183-1191) is non-empty nearly every cycle, so
reapCompletionSurfaces (:2376-2399, invoked :2455) spawns `zellij list-panes -a -j`
per reconcile pulse. Add a min-interval floor (e.g. MIN_REAP_INTERVAL_S = 15) via
a lastReapAt stamp checked at the :2455 call site or inside the helper — the
simple single-timestamp variant of the fn-735 stamp/sweep pattern (:449-484).
UNIT TRAP: keep it unit-seconds, never mix with *_TTL_MS. Reap semantics
otherwise unchanged (idempotent; the fn-764 done-window keeps rows visible long
enough that a floored probe still fires within the window).

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:94-121, 274-275, 839-860, 960-971 — SpawnFn, defaultSpawn, runCapture, degrade contract
- src/autopilot-worker.ts:1183-1191, 2376-2399, 2455 — completedRowIds + reap path
- test/exec-backend.test.ts:75, 231-291 — stub shapes to extend

### Risks

- A timeout-kill during a genuinely-slow-but-alive zellij op degrades that one op
  to {ok:false} — acceptable (retry next cycle) and infinitely better than a
  wedged reconciler with no fatalExit.

### Test notes

Never-resolving exited stub → runCapture returns null within the timeout and
kill() was called. Reap floor: two back-to-back cycles with completed rows spawn
ONE list-panes; after the floor elapses, the next cycle probes again.

## Acceptance

- [ ] runCapture cannot await unbounded; timeout kills the child and degrades to null (test-pinned)
- [ ] reap probe floored; existing reap tests green
- [ ] full bun test green

## Done summary

## Evidence
