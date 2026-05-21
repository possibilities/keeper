## Description

**Size:** M
**Files:** package.json, src/transcript-worker.ts (NEW), src/daemon.ts, test/transcript-worker.test.ts, test/integration.test.ts

The keystone (produce side): the new Worker thread, the `@parcel/watcher`
integration (keeper's first runtime dep), and the daemon wiring that turns
worker messages into synthetic events. Depends on task .1's resolver + schema.

### Approach

1. **Dependency.** `bun add @parcel/watcher` pinned to `2.5.6`; if Bun's blocked
   postinstall matters for CI, add `"trustedDependencies": ["@parcel/watcher"]`
   (the prebuilt darwin/linux binary loads without the build-from-source step).
2. **Pure line-stream core (separable exported module within the worker).** Port
   jobctl's `TranscriptLineStream` (`run_run_server.py:6605`): per-path byte-offset
   map anchored to EOF on register; per-file persistent `StringDecoder('utf8')`;
   read bounded (~64KB) chunks from stored offset to EOF; partial-line buffer
   (prepend the unterminated tail on the next read); dispatch only `\n`-terminated
   lines; `JSON.parse` malformed-skip-and-log; truncation guard (`size < offset`
   → reset offset to 0, clear buffer); match `{type:"custom-title", customTitle,
   sessionId}`; change-only emit vs an in-memory `lastEmittedTitle[sessionId]`.
   Keep this a PURE exported fn so the determinism tests drive it with no Worker
   or watcher. Restart-seed reader: backward-scan (jobctl's `_read_title_from_transcript`,
   `:5616`) OR seed `lastEmittedTitle[session]` from `jobs.title` **only when**
   `title_source === 'transcript'` (transcript is top priority, so when it has
   ever won, `jobs.title` equals the last transcript title; otherwise leave unset
   so the first title emits).
3. **Worker shell (`src/transcript-worker.ts`).** `isMainThread`-guarded; own
   read-only `openDb`; mirror `src/wake-worker.ts` structure. `@parcel/watcher`
   `subscribe(~/.claude/projects, cb, {ignore: [non-*.jsonl]})`; route each parsed
   line by its `sessionId`; post `{kind:"transcript-title", sessionId, title}` to
   `parentPort`. Own the subscription handle as an external resource and
   `unsubscribe()` in the `{type:"shutdown"}` handler (subsystem-style teardown,
   like `server-worker`'s socket). **Internal guards (per PQ5 decision):** missing
   `~/.claude/projects` root, per-file read errors, torn/malformed lines all
   skip-and-log and never escalate; only a genuine unrecoverable failure exits
   non-zero (→ daemon `fatalExit` → launchd restart, keeper's single recovery path).
4. **Daemon wiring (`src/daemon.ts`).** Spawn the 3rd worker in the same
   post-migrate/post-boot-drain window (mirror `:148-168`). `onmessage` for
   `{kind:"transcript-title"}` → `stmts.insertEvent(...)` a synthetic row
   (`hook_event="TranscriptTitle"`, `event_type="transcript_title"`,
   `data=JSON.stringify({session_title: title})`, nulls elsewhere) on the existing
   writable connection → `pumpWakes()`. The insert is synchronous on the main
   thread (cannot interleave with the synchronous drain). `onerror`→`fatalExit`,
   `addEventListener("close", ...)`→`fatalExit` (`:157-168` pattern). Add the
   worker to `shutdown()`'s post-`{type:"shutdown"}` + `Promise.all([exited(...)])`
   (`:194-235`).

### Investigation targets

**Required** (read before coding):
- src/wake-worker.ts (whole) — sensor-worker template: `isMainThread` guard, `parentPort`/`workerData`, own `openDb({readonly})`, exported test-drivable loop, shutdown wiring
- src/server-worker.ts — subsystem archetype: owning + releasing an external resource in the shutdown handler
- src/daemon.ts:148-168 (server-worker spawn + crash wiring to copy), :119-124 (onmessage→insert→pumpWakes shape), :194-235 (shutdown + Promise.all), :77 (sole writable connection), :289-325 of db.ts (`insertEvent` stmt to reuse)
- ~/code/arthack/apps/jobctl/jobctl/run_run_server.py:6605-6781 (`TranscriptLineStream` forward-tail core), :5616-5651 (`_read_title_from_transcript` restart-seed reader)

**Optional** (reference as needed):
- test/wake-worker.test.ts — drive the exported loop directly + the real-Worker `{type:"shutdown"}`→clean-`close` test
- test/integration.test.ts — real-daemon-subprocess e2e harness to extend
- ~/code/keeper-probe — real transcript samples to confirm the line shape

### Risks

- **Native addon under Bun in CI** — keystone risk. The smoke test guards it; documented fallback is chokidar v5 (pure JS) or `Bun.watch()`. Pin the version.
- **FSEvents coalescing** — events are "go look", not data; create+delete can yield no event (acceptable: a quick session's title missed).
- **UTF-8 chunk-boundary corruption** — per-file `StringDecoder`, never `toString()` per read.
- **Path-not-inode keying** — session fork = new file/new session-id name; new path = offset 0.
- **`~/.claude/projects` may not exist** on a fresh machine — tolerate (skip-and-log, tolerate late appearance).
- **fd discipline** — open→read→close per event; don't hold fds across a deep live tree.

### Test notes

- `test/transcript-worker.test.ts`: (a) determinism unit tests against the PURE line-stream core (no Worker/watcher) — partial-line buffering across two reads, truncation reset, malformed-skip, change-only emit, multi-byte title across a chunk boundary; (b) a smoke test that `subscribe`s under `bun test` and asserts the addon loads + fires one event; (c) a real-Worker spawn + `{type:"shutdown"}`→clean-`close` test (mirror wake-worker.test.ts).
- `test/integration.test.ts`: extend the real-daemon-subprocess e2e — start the daemon against a temp `KEEPER_DB` + a temp watch root, append a `custom-title` line to a transcript file under it, assert `jobs.title`/`title_source='transcript'` update, then SIGTERM → exit 0. (The watch root may need to be parameterized for the test; if `~/.claude/projects` is hard-coded, make it overridable via env so the e2e is hermetic.)

## Acceptance

- [ ] `@parcel/watcher@2.5.6` added to package.json; smoke test confirms it loads + fires under `bun test`
- [ ] The pure line-stream core is an exported fn with unit tests covering partial-line buffering, truncation reset, malformed-skip, change-only emit, and a multi-byte title split across a read boundary (no `U+FFFD`)
- [ ] The worker is `isMainThread`-guarded, opens its OWN read-only connection, routes by line `sessionId`, posts `{kind:"transcript-title", sessionId, title}`, and `unsubscribe`s on shutdown
- [ ] Missing watch root / per-file read error / torn line all skip-and-log without crashing the worker; only a genuine unrecoverable failure exits non-zero
- [ ] Daemon spawns the worker post-boot-drain; `onmessage` inserts a `TranscriptTitle` synthetic event via the existing writable connection + `pumpWakes()`; `onerror`/`close`→`fatalExit`; `shutdown()` posts `{type:"shutdown"}` and awaits its `close`
- [ ] e2e: a `custom-title` write to a watched transcript flips `jobs.title` to `title_source='transcript'` end-to-end; daemon SIGTERM exits 0
- [ ] Main remains the sole `jobs`-writer and sole in-process writable connection
- [ ] `bun test --isolate`, `biome check`, `tsc --noEmit` all clean

## Done summary

## Evidence
