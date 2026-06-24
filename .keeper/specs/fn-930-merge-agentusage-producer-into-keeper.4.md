## Description

**Size:** M
**Files:** src/usage-scraper-worker.ts (new), src/daemon.ts

### Approach

Port `daemon.py`'s orchestration into `src/usage-scraper-worker.ts`, modeled on
`builds-worker` (the non-watcher poll producer), NOT the git-worker. Structure: N
concurrent per-account async loops sharing a global profile-gate + a per-target mutex
(`Map<id,Promise>`), each loop on the builds-worker pattern (setTimeout-after-completion,
`inFlight` skip, per-cycle NO-THROW so a scrape bug never reaches `onerror`/`fatalExit`).
Per cycle: re-resolve the account's tier/multiplier (read `config.yaml` profiles +
append codex + read each `~/.claude-profiles/<p>/.claude.json` — account discovery +
tier move to TS), run the idle-skip (TS fs-walk of `~/.claude/projects` + `~/.codex/
sessions` mtimes, >15min) + cooldown (`lift_at`) gates, then `runScrape` via `.3`'s
`ScrapeRunner`. Assemble the envelope (producer-side wall-clock: `multiplier`,
`next_fetch_at` = now + `uniform(60,180)`, `last_*_fetch_at`, `lift_at` carry — read the
prior `<id>.json` on boot for restart-cheap `next_fetch_at` + keep-prior-multiplier) and
atomically write `<id>.json` (temp+rename, filename passing `isUsageFilename`), plus
`.error.json` on failure + an `events.jsonl` append. Own a singleton FileLock on the
state dir; `mkdir` the root before first write. `isMainThread` guard; own read-only
`openDb({readonly,prepareStmts:false,bootRetry:true})`. Shutdown handler: clear timers,
abort + KILL any in-flight scrape child, release the FileLock, close db, exit 0. Wire
into `src/daemon.ts`: new `WorkerName` (e.g. `"usageScraper"`) added to the union +
`ALL_WORKERS` (update the regression test keyed at :1325), NOT to `WATCHER_WORKERS`;
config-GATED spawn like builds-worker (:3063-3072); add the handle to `spawnedWorkers`
(:4258-4275) for the shutdown broadcast + terminate sweep. The worker writes ONLY its
own external surface — never keeper.db; main stays the sole event writer (the existing
consumer mints `UsageSnapshot` from the files).

### Investigation targets

**Required** (read before coding):
- src/builds-worker.ts:472-580 (poll skeleton), :529-579 (setTimeout-after-completion + inFlight), :399-402 (AbortController), :563-576 (shutdown), :549-559 (no-throw cycle), :584 (isMainThread)
- src/daemon.ts:3063-3072 (builds config-gated spawn), :2964-3053 (usage-worker wiring template), :1304-1344 (`WorkerName`+`ALL_WORKERS`, regression test :1325), :1353-1359 (`WATCHER_WORKERS` — do NOT add), :4258-4275 (`spawnedWorkers`), :4281-4283 / :4304-4310 (shutdown broadcast + terminate)
- ~/code/agentusage/daemon.py:497-818 (account loop), :551-655 (idle/cooldown gates), :377-404 (restart-cheap next_fetch_at), :433-465 (envelope builder), :258-264 (idle session-log walk + scrape-path filter), :845 (per-target locks)
- src/usage-worker.ts:217-231 (`isUsageFilename` + carve-outs the writer must satisfy)
- src/usage-scrape-runner.ts (`.3`'s ScrapeRunner) + the vendored picker stateDir

### Risks

- Concurrency semantics: a single sequential loop collapses the per-target-lock + profile-gate + per-account-jitter design — N concurrent per-account loops with the shared gate/mutex are required to preserve behavior.
- A leaked scrape child on shutdown: the worker MUST kill the in-flight `Bun.spawn` child (which the `.1` util then `killpg`s its TUI grandchild) before exiting.
- Never `fatalExit` on a transient scrape failure (no-throw cycle) — an unguarded throw → `onerror` → LaunchAgent restart loop. A failure writes `stale` + `.error.json` + logs + continues.
- Keep-prior-multiplier across restart: a tier-read failure must read the prior envelope's `multiplier`, not default to 1x (else a Max account silently downgrades).

### Test notes

Unit (stubbed `ScrapeRunner`, sandboxed root): idle-skip gate, cooldown gate,
envelope assembly + filename parity, keep-prior-multiplier, restart-cheap reload,
the no-throw failure path. A daemon-boot test asserts the new worker is in
`ALL_WORKERS` + spawns under its config gate + is absent from `WATCHER_WORKERS`.
`bun run test:full` (MANDATORY — daemon + worker).

## Acceptance

- [ ] `src/usage-scraper-worker.ts` runs N per-account loops (jitter, idle-skip, cooldown, profile-gate, per-target mutex) and writes `<id>.json` + `.error.json` + `events.jsonl` with filenames passing `isUsageFilename`
- [ ] wired into `daemon.ts`: new `WorkerName` in the union + `ALL_WORKERS` (regression test updated), config-gated spawn, in `spawnedWorkers`, NOT in `WATCHER_WORKERS`
- [ ] shutdown kills the in-flight scrape child + releases the FileLock + closes db + exits 0; a transient scrape failure never `fatalExit`s
- [ ] tier/multiplier + account discovery resolved TS-side; keep-prior-multiplier on a failed tier read; restart-cheap `next_fetch_at` from the prior envelope
- [ ] `bun run test:full` green

## Done summary
Ported agentusage's retired daemon.py producer into src/usage-scraper-worker.ts: N concurrent per-account scrape loops (jitter, idle/cooldown gates, profile-gate, per-target mutex) writing <id>.json/.error.json/events.jsonl envelopes via .3's ScrapeRunner, with tier/multiplier + account discovery + lift_at moved TS-side (keep-prior-multiplier, restart-cheap next_fetch_at, no-throw failure cycle). Wired a config-gated usageScraper worker into daemon.ts (in ALL_WORKERS + spawnedWorkers, NOT WATCHER_WORKERS).
## Evidence
