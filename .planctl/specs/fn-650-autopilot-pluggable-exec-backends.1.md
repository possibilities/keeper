## Description

**Size:** M
**Files:** src/exec-backend.ts (new), src/db.ts, scripts/autopilot.ts, test/exec-backend.test.ts, test/db.test.ts, README.md

Extract autopilot's Ghostty-specific spawn/close mechanics behind a
narrow `ExecBackend` interface, add a `zellij` backend with the same
API, make the backend config-selectable (default zellij), and rewire
autopilot to route launch/close through the resolved backend without
changing any orchestration behavior.

### Approach

**1. New module `src/exec-backend.ts`** — mirror `src/live-shell.ts`'s
shape (leading docstring, `export interface` first, `Default*` consts,
`create*({deps})` factories, zero import-time side effects). Define:

```ts
export interface ExecBackend {
  // Spawn a terminal surface running argv; resolve to a stable id
  // (or null if no id captured). Async because the id is parsed from
  // spawn stdout.
  launch(argv: string[], rowId: string, dir: string): Promise<string | null>;
  close(windowId: string): void; // fire-and-forget
}
```

- `createGhosttyBackend({ noteLine })`: move the osascript launch
  (`new surface configuration` → set `command of cfg` to the
  argv re-joined into the `$SHELL -l -i -c <quoted body>` string →
  `new window with configuration cfg` → `return id of w`),
  the stdout-id parse, AND the fire-and-forget `yabai -m window --space 5`
  move — verbatim from `launchInGhostty`. `close` = the repeat-loop
  `close window w` osascript. **Preserve the -2741 / -1708 error-code
  gotcha comments verbatim** — they document why the repeat-loop form
  is the only one that reaps the surface.
- `createZellijBackend({ noteLine, session })`: `launch` lazily ensures
  the session ONCE (memoized `Promise<void>`): run `zellij list-sessions`,
  and if `session` is absent run `zellij attach -b <session>`, then poll
  `list-sessions` until the name appears (≈50ms interval, ≈5s cap) to beat
  the #3733 race; then `zellij --session <session> action new-tab --cwd <dir> -- <argv>`
  and capture the bare-number tab id from stdout. `close` =
  `zellij --session <session> action close-tab-by-id <windowId>`. No yabai.
- `resolveExecBackend(name, deps)`: factory by name; hard-default to
  `"zellij"`, but any unknown name falls back to `"zellij"` (the config
  layer already validated, so this is belt-and-suspenders).

Reuse the `Bun.spawn` fire-and-forget pattern from
`scripts/autopilot.ts:2387-2446` (`{stdout:"pipe",stderr:"pipe",stdin:"ignore"}`,
`Promise.all([proc.exited, text(stdout), text(stderr)])`, surface stderr
via `noteLine`, never throw). Inject the spawn fn (or keep argv
construction pure) so tests assert the built argv without launching real
processes. ENOENT (zellij not installed) → resolve `null` + `noteLine`,
mirroring the ghostty non-zero-exit path.

**2. `src/db.ts` config** — add `execBackend?: "ghostty" | "zellij"`
and `zellijSession?: string` to `KeeperConfig`; in `resolveConfig`
parse `exec_backend` (validate against `{ghostty,zellij}`, else default
`"zellij"`) and `zellij_session` (non-empty string, else `"autopilot"`)
off the same parsed document, each independent/best-effort. **Add both
new defaults to the catch-block return at src/db.ts:180-184** or a parse
failure silently drops them.

**3. `scripts/autopilot.ts` rewire** — construct the backend once in
`main()` via `resolveExecBackend(resolveConfig().execBackend, {noteLine, session: resolveConfig().zellijSession})`.
Rename `launchInGhostty` → `launchWindow`; keep ALL of its orchestration
(shouldSuppressDispatch guard, logDispatch, settling.set, dryRun gate,
the in-memory windowId stamp, the `kind:"window"` appendFileSync
persist) and replace ONLY the osascript spawn/capture core with
`backend.launch(argv, rowId, dirFull).then(id => { if (id) <existing stamp+persist> })`.
Build `argv = [shell, "-l", "-i", "-c", body]` where `body` is the
existing `${workerShellCommand} ; exec ${shell} -l -i`. Re-point the
single call site `fireLaunch` (line ~2538). Rewire
`detectJobTransitionsDeps.closeWindow` to call `backend.close(windowId)`
(keep the dryRun-note and undefined/"" no-op guards at the call site).

**4. README.md** — per the Docs gaps section of the epic spec.

### Investigation targets

**Required** (read before coding):
- src/live-shell.ts — factory module pattern to mirror (interface, defaults, `create*({deps})`, import-clean)
- scripts/autopilot.ts:2283-2468 — `launchInGhostty`; note the shell-wrapping at 2330-2346 and the windowId stamp + JSONL persist at 2401-2435 (the parts that STAY)
- scripts/autopilot.ts:2534-2548 — `fireLaunch`, the single launch call site to re-point
- scripts/autopilot.ts:2691-2768 — `detectJobTransitionsDeps.closeWindow`; preserve the -2741/-1708 gotcha comments when moving into the ghostty backend
- scripts/autopilot.ts:439-458 — `buildWorkerCommand` (the `cd <projectDir> &&` baked into the command — backstop for zellij `--cwd`)
- src/db.ts:116-120 — `KeeperConfig`; src/db.ts:146-187 — `resolveConfig` (catch block 180-184 re-lists ALL defaults)

**Optional** (reference as needed):
- test/live-shell.test.ts — closest structural template for a `src/` factory-module test (injected fakes, no real side effects)
- test/db.test.ts:4496-4535 — config-key test pattern (KEEPER_CONFIG → tmp yaml → assert resolveConfig().x → restore in finally)
- test/autopilot.test.ts:897-905 — recording-stub pattern for `DetectJobTransitionsDeps` (noteLine/closeWindow capture arrays)

### Risks

- **#3733 session race** — first `new-tab` after `attach -b` can no-op if the server isn't ready. Mitigate with the poll-until-listed loop before the first new-tab; ensure-session is memoized so the cost is paid once.
- **Default flip to zellij** — this switches real autopilot dispatch onto the less-battle-tested path. The zellij backend must be correct on first ship; if `new-tab` id capture proves unreliable in live testing, fall back `resolveExecBackend`'s default to ghostty (see epic Early proof point) and land the rest.
- **Daemon env** — zellij's server socket lives under `$XDG_RUNTIME_DIR`; if autopilot is ever run from a non-login/launchd context, propagate `XDG_RUNTIME_DIR`/`TERM` in the zellij `Bun.spawn` env. Autopilot today is a foreground TUI the human runs in a terminal, so inherited env is normally fine — add propagation only if a missing-socket failure shows up.
- **windowId is now backend-shaped** — `dispatch.log` persists ids across restarts; switching `exec_backend` between runs hands a foreign-format id to the other backend's `close`. Each `close` must no-op/​swallow gracefully on an unmatched id (ghostty repeat-loop already returns "not-found"; zellij `close-tab-by-id` on a stale id must not throw back).

### Test notes

- `test/exec-backend.test.ts` (new): inject a fake spawn; assert the
  ghostty osascript argv and the zellij `new-tab`/`close-tab-by-id`/
  `attach -b`/`list-sessions` argv are constructed correctly (cwd =
  absolute dir, argv after `--`, session name threaded). Assert
  `resolveExecBackend` returns the right backend by name and
  falls back to zellij on unknown. No real `zellij`/`osascript` spawn.
- `test/db.test.ts` (extend ~4496-4535): `exec_backend` present /
  absent→`"zellij"` / malformed→`"zellij"`; `zellij_session` present /
  absent→`"autopilot"` / non-string→`"autopilot"`; independence (a bad
  `exec_backend` doesn't disturb `roots`/`zellij_session`).
- `bun test test/autopilot.test.ts` stays green (orchestration unchanged).
- Live smoke (manual, before trusting the default): in a real zellij
  session, confirm `zellij action new-tab -- echo hi` prints a numeric
  tab id on stdout and `close-tab-by-id <that>` reaps it.

## Acceptance

- [ ] `src/exec-backend.ts` exports `ExecBackend`, `createGhosttyBackend`, `createZellijBackend`, `resolveExecBackend`; import-clean, factory-style per `src/live-shell.ts`
- [ ] Ghostty backend reproduces today's launch (osascript window + yabai move + id capture) and close (repeat-loop) behavior, gotcha comments preserved
- [ ] Zellij backend: lazy-memoized session-ensure (`list-sessions` + `attach -b` + poll), `new-tab --cwd <abs> -- <argv>` id capture, `close-tab-by-id` close
- [ ] `resolveConfig()` returns `execBackend` (default `"zellij"`, validated) and `zellijSession` (default `"autopilot"`); both in the catch-block defaults; keys independent/best-effort
- [ ] `launchWindow` + `closeWindow` route through the resolved backend; suppression/settling/logDispatch/JSONL-persist/dry-run all unchanged; `fireLaunch` re-pointed
- [ ] `test/exec-backend.test.ts` asserts argv construction via injected fakes (no real spawn); `test/db.test.ts` covers both new keys (present/absent/malformed); `test/autopilot.test.ts` still passes
- [ ] README config block + autopilot prose updated to be backend-neutral
- [ ] `bun test` green; lint clean

## Done summary

## Evidence
