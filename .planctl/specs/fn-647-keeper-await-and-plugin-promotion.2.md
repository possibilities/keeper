## Description

**Size:** M
**Files:** the `keeper await` subcommand module on the fn-646 dispatcher
(exact path per fn-646.1's command layout — a non-TUI command, NOT the
OpenTUI renderer), plus a co-located test using the mock-socket
`ConnectFactory`.

### Approach

Register `keeper await <complete|unblocked> <id>` on the fn-646 dispatcher.
Parse with the predicate module's `classifyTargetId` for epic-vs-task.
Resolve the socket with `resolveSockPath()` (`--sock` override) and open
`subscribeReadiness({ sockPath, idPrefix, onSnapshot, onFatal, … })` as the
board-scoped authority — read `snap.readiness` directly (no re-`computeReadiness`).

Lifecycle:
- First snapshot establishes the **on-board baseline**. If the target is
  absent at that first paint ⇒ terminal `failed reason=not-found` (exit 1),
  with NO `armed` line (preserves "armed → exactly one terminal").
- Otherwise emit `[keeper-await] armed target=<id> kind=<…> condition=<…> state=<verdict>` once.
- Per snapshot, call `evaluateAwaitCondition`. On `met` ⇒ terminal
  `met` (exit 0). On `stuck` ⇒ stderr warning + keep waiting; exit 5 only
  under `--fail-on-stuck`.
- **epic-complete / deleted**: track prior presence; when an epic target
  drops out of `snap.epics`, fire a one-shot scope-exempt
  `subscribeCollection({ collection: "epics", filter: { epic_id } })`
  (pk filter is exempt from `default_visible`), await one `result`, dispose:
  row present & done+approved ⇒ `met`; absent ⇒ `failed reason=deleted`
  (exit 4). Do NOT conflate a disconnect/reconnect first-paint gap with a
  drop — only treat a drop as terminal after a live post-reconnect snapshot.

Monitor protocol (mirror pairctl `run_send_message.py` / `emit_event`):
stdout is the event channel, `[keeper-await] ` prefix, `key=value` fields,
sanitize values (`/[\r\n]/g → " "`). A single `terminating` flag guards all
terminal paths. Write the terminal line via
`process.stdout.write(line, () => process.exit(code))`. Register BOTH
`SIGTERM` and `SIGINT` (Monitor sends SIGTERM at `timeout_ms`); the handler
emits `failed reason=timeout` (exit 3) through the same `terminating` guard.
Pass a custom `onFatal` to `subscribeReadiness` so its default
`process.exit(1)` can't bypass the terminal-line protocol — route
connection-fatal to `failed reason=connect` exit 1.

Flags: `--json` (terminal/armed lines as JSON objects for non-Monitor
use), `--timeout <dur>` (own deadline; default none, set below Monitor's
kill-timeout when used), `--fail-on-stuck`, `--no-armed-line`,
`--require-transition` (default off; when set, don't exit on a
already-true-at-arm condition — wait for a real edge), `--sock`.

stderr: one human progress line per verdict CHANGE (throttled, never per
500ms poll), routed to Monitor's output file, never the event channel.

### Investigation targets

**Required** (read before coding):
- src/readiness-client.ts:979 — `subscribeReadiness` shape + `ReadinessClientSnapshot` (`snap.readiness`, `snap.epics`); :929 `subscribeCollection`; `onFatal` default ~:998 (the footgun to override).
- src/db.ts:83 — `resolveSockPath()`.
- scripts/git.ts:411-433 — canonical `subscribeCollection` + SIGINT dispose+exit (adapt to SIGTERM + terminating guard).
- ~/code/arthack/apps/pairctl/pairctl/run_send_message.py + helpers.py:26 (`emit_event`) — armed/terminal convention, SIGTERM-emits-terminal invariant.
- src/await-conditions.ts (task .1) — `evaluateAwaitCondition`, `classifyTargetId`, `AwaitState`.
- test/readiness-client.test.ts — mock-socket `ConnectFactory` injection for synchronous frame delivery (drive the await loop in tests).

**Optional** (reference as needed):
- src/protocol.ts — `LineBuffer` (if any raw framing needed; prefer the subscribe helpers).
- src/collections.ts:253-265 — confirm `epic_id` filter is scope-exempt for the re-query.

### Risks

- **fn-646 dependency**: the dispatcher and command-registration surface
  don't exist until fn-646.1 lands. The exact command file path + how
  subcommands register is defined there — follow fn-646.1's pattern; do not
  invent a parallel entrypoint or fall back to a `scripts/await.ts`.
- **Double terminal line**: SIGTERM racing a met. The `terminating`
  check-and-set must be atomic before any terminal write.
- **False deleted on reconnect**: subscribeReadiness resets first-paint on
  reconnect; a target absent in the post-reconnect first snapshot is a blip,
  not a delete. Gate drop-detection on a stable live snapshot.
- **Flush on pipe**: never `process.exit()` before the write callback.

### Test notes

Use the mock-socket `ConnectFactory` to deliver crafted `result`/`patch`
frames and assert the emitted stdout lines + exit code. Cover: armed then
met (task complete, task unblocked, epic unblocked); not-found at first
paint (no armed line, exit 1); SIGTERM ⇒ failed reason=timeout exit 3 (one
terminal line only); epic drop ⇒ re-query present ⇒ met vs absent ⇒ deleted
exit 4; stuck default waits, `--fail-on-stuck` ⇒ exit 5; reconnect blip does
not fire deleted.

## Acceptance

- [ ] `keeper await <complete|unblocked> <id>` registered on the fn-646 dispatcher; epic/task auto-detected; non-TUI.
- [ ] Emits one `armed` line after the on-board check, then exactly one terminal `met`/`failed`; not-found at startup emits no armed line.
- [ ] SIGTERM emits `failed reason=timeout` (exit 3) via the `terminating` guard; terminal line flushed via write-callback before exit.
- [ ] epic-complete vs deleted disambiguated by a scope-exempt `subscribeCollection({filter:{epic_id}})` one-shot; reconnect blips don't fire deleted.
- [ ] Exit codes 0/1/3/4/5 as specified; custom `onFatal` prevents the helper's `process.exit(1)` from bypassing the protocol.
- [ ] Flags `--json`, `--timeout`, `--fail-on-stuck`, `--no-armed-line`, `--require-transition`, `--sock` behave as specified; stderr progress is verdict-change-throttled.
- [ ] Tests via the mock-socket ConnectFactory pass; `biome check` + `tsc --noEmit` clean.

## Done summary

## Evidence
