## Description

**Size:** M
**Files:** src/live-shell.ts (replace), src/live-shell-core.ts (new, extracted state core), cli/git.ts (moved from scripts/git.ts), test/live-shell.test.ts (split/rewrite), test/live-shell-core.test.ts (new)

The keystone. Replace the hand-rolled renderer with an OpenTUI-backed
one behind the identical caller handle, extract the renderer-agnostic
state core so its tests survive verbatim, and prove the whole thing by
cutting over the simplest TUI (`keeper git`) end-to-end. If this task
can't reproduce the UI faithfully, the epic's fallback (CLI-unify
without renderer swap) triggers here.

### Approach

1. **Extract the renderer-agnostic core** into `src/live-shell-core.ts`:
   the history ring buffer (`historyCap` default 500, `viewIdx` nudge
   on evict), the `"live"` sentinel + single-slot `liveOverlay`, the
   `bannerStatus` segment, the banner string composer (`[[<title>]]
   Showing live results` / `frame N of M — press G to return to live`
   + status suffix), the CSI/SS3 esc-parser + keymap dispatch
   (`←/→/h/j/k/l/g/G/End/Esc/q/Ctrl-C`), and the non-TTY pass-through
   decision. Pure state + string composition, no terminal I/O. Its
   existing tests (state transitions, esc-parser split-chunk, non-TTY
   plain-text bytes, history/scrollback, double-dispose) move to
   `test/live-shell-core.test.ts` and keep asserting the same values.
2. **Build the OpenTUI paint layer** in `src/live-shell.ts`, preserving
   the `LiveShell` interface (`pushFrame`/`refreshLive`/`setStatus`/
   `dispose`) and `LiveShellOptions` (`enabled`/`title`/`onUnhandledKey`/
   `stdout`/`stdin`/`historyCap`/`timers`/`safetyNetTarget`/`onExit`):
   - Non-TTY / `!enabled`: never construct `createCliRenderer`; return
     the exact plain pass-through (`pushFrame`→`stdout.write(join+\n)`,
     `refreshLive`/`setStatus` no-op, `dispose` no-op).
   - TTY: `createCliRenderer({ exitOnCtrlC:false, exitSignals:[...minus SIGINT], autoFocus:false })`,
     root Box column = dim banner `TextRenderable` (top:0, height:1,
     width:100%) + `ScrollBoxRenderable` (top:1, height:renderer.height-1).
     ScrollBox stays UNFOCUSED; own all keys via `renderer.keyInput`,
     translate `key.name`→the raw-string contract `onUnhandledKey`
     expects, scroll via `scrollTo(0)` on frame switch.
   - `pushFrame`: mutate body `TextRenderable.content` (pool + add/remove
     only on row-count delta), clear `liveOverlay`, `scrollTo(0)`.
   - `refreshLive`: apply overlay via content mutation only when
     `viewIdx==="live"`; dormant when scrolled back; identical-text no-op.
   - `setStatus`: recompose banner content; semantics unchanged.
   - `dispose`: idempotent `disposed` flag; `renderer.destroy()`;
     keep the `exit`/`uncaughtException`/`unhandledRejection` safety nets
     (load-bearing since OpenTUI doesn't hook exit). Resize via
     `renderer.on("resize")` (not the old SIGWINCH write path).
3. **Cut over `keeper git`**: move `scripts/git.ts`→`cli/git.ts`,
   change `main`→`main(argv: string[])` reading the passed argv,
   neutralize the `import.meta.main` guard (dispatcher is the entry),
   keep the SIGINT teardown order (`liveShell.dispose()` then
   `handle.dispose()`) and the `/tmp` sidecar writes. Wire it into
   `cli/keeper.ts`. Update `test/git.test.ts` import path; the exported
   `renderRowBlocks`/`renderRowLines` stay.
4. **Paint tests** in `test/live-shell.test.ts`: rewrite the
   render-dependent cases against `createTestRenderer` (`mockInput.press`,
   `captureCharFrame`, explicit width/height, `OTUI_USE_CONSOLE=false`,
   `destroy()` each test).

### Investigation targets

**Required** (read before coding):
- src/live-shell.ts:150-183 (LiveShellOptions), :202-224 (LiveShell interface), :296-327 (non-TTY pass-through), :385-394 (banner composer), :514-549 (keymap), :593-641 (esc-parser), :726-741 (refreshLive overlay)
- test/live-shell.test.ts — the 14 cases; tag each renderer-agnostic vs paint-dependent
- scripts/git.ts — `main()`, SIGINT teardown, sidecar writes, `import.meta.main` guard; exported render fns
- src/readiness-client.ts:183-187 — `subscribeCollection` `{dispose()}` handle (unchanged)
- knowctl topic `opentui`: renderer, keyboard, scrollbox, text, testing docs

**Optional:**
- src/clipboard-debug.ts — the `c`-copy path git forwards via `onUnhandledKey`
- src/rescan.ts — `SchedulerTimers` injection pattern mirrored by `timers`

### Risks

- **Keyboard ownership** is the highest-risk area: a focused ScrollBox silently eats arrows. Verify the frame-history keymap owns the global stream and `onUnhandledKey` still receives the raw-string contract.
- The `key.name`→raw-string translation must be exact or callers' bindings break (`c`, and later space/`v`).
- Banner pinning: the banner must stay at row 0 while a tall frame scrolls; the live tip must not auto-scroll out of view.
- "Exact same UI" bar: banner wording + frame-history behavior stay byte/behavior identical; only the paint mechanism changes.

### Test notes

Core tests assert state/strings (no renderer). Paint tests use
`createTestRenderer`. Keep the non-TTY plain-text assertions verbatim
in the core suite. Manually diff `keeper git` against the old
`bun scripts/git.ts` (frame, nav, copy, quit, resize, pipe-to-file).

## Acceptance

- [ ] `src/live-shell-core.ts` holds the renderer-agnostic state machine; its tests pass verbatim (values unchanged).
- [ ] `src/live-shell.ts` is OpenTUI-backed with an unchanged `LiveShell`/`LiveShellOptions` surface; non-TTY path never constructs a renderer.
- [ ] `keeper git` renders UI-identical to `bun scripts/git.ts` — banner, frame-history nav, `c`-copy, `q`-quit, tall-frame scroll, resize, non-TTY pipe.
- [ ] `cli/git.ts` takes `main(argv)`, guard neutralized, SIGINT order + sidecars preserved; wired into the dispatcher.
- [ ] Paint tests run on `createTestRenderer` and pass; `dispose()` leaves the terminal clean.

## Done summary

## Evidence
