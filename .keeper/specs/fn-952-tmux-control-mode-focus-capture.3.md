## Description

**Size:** M
**Files:** src/tmux-control-worker.ts (new), src/daemon.ts, test/tmux-control-worker.test.ts (new), test/tmux-control-worker.slow.test.ts (new), scripts/test-real-git-allowlist.txt

### Approach

A NEW dedicated worker owning the `tmux -C` child + pipes (mirror the `src/bus-worker.ts`
external-resource template): `isMainThread`-guarded; own read-only `openDb` connection
(`prepareStmts:false`); releases the child in its own `{ type: "shutdown" }` handler.

- **Attach** (via `localeDefaultedEnv`): `tmux -N -C attach-session -f no-output,ignore-size,no-detach-on-destroy -t <anchor>`.
  First framed commands on connect: `refresh-client -f no-output` (re-assert), then `copy-mode -q`
  (defensive — no `%config-error` on 3.6b). NEVER toggle `no-output` afterward (3.6b hang).
- **Anchor** (keepalive parking spot ONLY — observation is global, the anchor does not limit what's
  seen): gate connect on `hasLiveTmuxJob`; pick a live session, preferring a keeper-managed one by
  recent activity. REJECT a dedicated hidden observer session (would hold the server alive → pid never
  flips → breaks the recycle guard).
- **Reader**: a dedicated async loop draining stdout through the task-1 parser into an in-memory queue;
  never block it on a DB write or a command round-trip.
- **Capture**: on structural notifications (`%session-window-changed`, `%window-pane-changed`,
  `%client-session-changed`, `%sessions-changed`, `%window-add`, `%window-close`, `%client-detached`)
  mark dirty → debounced, SINGLE-in-flight framed re-read (`list-clients` + `list-panes -a`) → derive
  focus via the task-1 seam → dedup over `(generation_id, session_name, window_index, pane_id)` EXCLUDING
  `client_activity` → post `{ kind: "tmux-client-focus-snapshot", ... }` to main only on change. Idle ⇒ 0 events.
  If a notification lands mid-re-read, re-arm dirty and re-read once.
- **Generation / reconnect**: read the server pid (`display-message -p '#{pid}'`) FIRST on every connect,
  then post. On `%exit` (treat ANY exit as "child gone"; ignore the version-dependent reason string) or
  EOF/SIGPIPE: tear down the child, discard cached ids + generation, exponential backoff, reconnect,
  re-bootstrap. A bounded reconnect cap → `fatalExit` (no in-process respawn). Never post a wiping/empty
  snapshot on disconnect — only post `status:"none"` on a real "0 real clients" observation.
- **Daemon wiring** (`src/daemon.ts`): add to the `WorkerName` union + `ALL_WORKERS` spawn order; gate the
  spawn behind the `want(...)` selector, after migrate + boot-drain; main mints the synthetic
  `TmuxClientFocusSnapshot` event from the typed message (main is the SOLE synthetic-event writer).
- **Supervision**: emit a `git-liveness`-style side-channel pulse (mirror `GitLivenessMessage`) into the
  supervisor watchdog so a silently-hung client (not just a hard crash) escalates; pulse even during long
  idle (no focus change ≠ unhealthy).

### Investigation targets

**Required** (read before coding):
- src/bus-worker.ts:1458 — dedicated-worker shutdown-handler template; docstring at :11 for the external-resource worker shape.
- src/git-worker.ts:272 + :2400 — `GitLivenessMessage` side-channel pulse; src/daemon.ts:875 — the watchdog that escalates on mute.
- src/daemon.ts:1644 — `WorkerName` union + `ALL_WORKERS`; :1820 — `want(...)`; :4548 — restore-worker spawn; :4554 — the worker→main `onmessage` synthetic-event mint to mirror.
- src/restore-worker.ts:495 — dedup-hash with informational fields stripped (the `(generation_id,...)`-without-`client_activity` precedent); the `hasLiveTmuxJob` gate.
- src/exec-backend.ts:438 — `localeDefaultedEnv`.
- src/tmux-control-parser.ts + src/tmux-focus-derive.ts — the task-1 seams this worker drives.

**Optional** (reference as needed):
- src/wake-worker.ts — `watchLoop` (for the `data_version`/`hasLiveTmuxJob` gating signal, not the stream reader).

### Risks

- tmux 3.6b `no-output` off→on toggle hangs the client — set once, never toggle (hard invariant).
- macOS pipe backpressure → `%exit "too far behind"` if the reader stalls — dedicated drain, never block on DB.
- Config-error copy-mode hang — `copy-mode -q` on connect.
- `-N` fails when no server is running — degrade-and-retry, NEVER `fatalExit` on a no-server condition.
- Reconnect storm on a flapping server — bounded cap before escalation.

### Test notes

Fast tier: pure attach-arg construction, dedup, and the reconnect state machine driven by an INJECTED
spawn/stream seam with synthetic transcripts (no real tmux). Real `tmux -C` attach against a throwaway
`-L` server → `test/tmux-control-worker.slow.test.ts`, added to `scripts/test-real-git-allowlist.txt`.
Poll daemon/worker state with `retryUntil`, never `Bun.sleep`. `bun run test:full` before landing.

## Acceptance

- [ ] A new supervised worker attaches one `tmux -C` client (`-N`, `no-output` once, `copy-mode -q`), drains stdout via the task-1 parser on a dedicated non-blocking reader, and releases the child in its own shutdown handler.
- [ ] Focus is captured via notifications-as-signal + debounced single-in-flight framed re-read; idle ⇒ 0 events; dedup excludes `client_activity`; main mints the `TmuxClientFocusSnapshot` event.
- [ ] On `%exit`/EOF the worker discards cached ids, reads the server pid first on reconnect, re-bootstraps (re-running if a notification lands mid-bootstrap), and escalates to `fatalExit` only after a bounded reconnect cap.
- [ ] A side-channel liveness pulse lets the watchdog catch a silent hang; the worker is registered in `WorkerName`/`ALL_WORKERS` and spawned gated, after migrate+drain.
- [ ] Fast-tier tests use an injected seam (no real tmux); the live attach test is `*.slow.test.ts`, allowlisted.

## Done summary

## Evidence
