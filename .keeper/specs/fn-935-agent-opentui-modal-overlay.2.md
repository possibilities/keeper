## Description

**Size:** M
**Files:** new src/agent/modal-overlay.ts (OpenTUI host + scrim + test modal), wire into src/agent/modal-host.ts (.1), src/agent/dispatch.ts / README.md (flag docs), test/agent-modal-overlay.test.ts, package.json (`test:opentui` glob)

### Approach

Build the OpenTUI renderer ONCE at host start and keep it SUSPENDED as the resting
state — lift `defaultBuildRenderer` from the dash (`createCliRenderer({exitOnCtrlC:
false, exitSignals:[], autoFocus:false, screenMode:"alternate-screen"})`). On the
reserved hotkey (delivered by .1): perform the atomic stdin handoff — remove keeper's
passthrough `data` listener BEFORE `renderer.resume()` — then draw a dim scrim
(`FrameBufferRenderable` + `setCellWithAlphaBlending`, bottom z) and a placeholder
test modal (`BoxRenderable`, top z via add-order), routing keypresses to the modal
through `keyInput.on("keypress", ...)`. On dismiss (Esc OR a click on the scrim via a
cell hit-test): `renderer.suspend()`, re-add keeper's stdin listener AFTER suspend,
then `terminal.resize(cols,rows)` to force a SIGWINCH redraw of the agent, and resume
passthrough. Bracket each rendered frame in `?2026` BSU/ESU (tight, per-frame), skip
`?2026` under tmux (`$TMUX` on the parent), do NOT re-enter `?1049h` (already on the
alt-screen), push/pop the kitty-keyboard level (`CSI >1u` / `CSI <u`), and disable the
child's focus reporting (`?1004l`) during the modal if it had it enabled. Merge exit
discipline: on child exit while the modal is open, auto-dismiss → `renderer.destroy()`
(restores the terminal) BEFORE propagating the child's disposition. Re-layout the
scrim/modal on a real-terminal resize while open. v0 backdrop is the dim scrim only —
no faithful agent render behind it.

### Investigation targets

**Required** (read before coding):
- src/dash/app.ts:570-591 — `defaultBuildRenderer` (lift the renderer config + runtime ctor bundle); :218-219 — add-order = z-order layering; :490-513 — keypress dispatch + destroyed guard; :475-486,682-702 — idempotent `exitCleanly` with `renderer.destroy()` before exit
- node_modules/@opentui/core/renderer.d.ts:539-541 — `suspend`/`resume`/`pause`; :514 — `resetTerminalBgColor`
- node_modules/@opentui/core/buffer.d.ts — `OptimizedBuffer.create({respectAlpha:true})`, `setCellWithAlphaBlending`; renderables/FrameBuffer.d.ts — `FrameBufferRenderable`
- test/dash-app.test.ts — `createTestRenderer` from `@opentui/core/testing`; package.json — the `test:opentui` serial glob (the new test MUST be added here or it never runs)

**Optional** (reference as needed):
- src/live-shell-core.ts:451-496 — escape parsing for hotkey/dismiss byte handling
- src/agent/modal-host.ts (.1) — the passthrough host + hotkey-stub seam to wire into

### Risks

- stdin double-read race if the listener handoff is not atomic (remove before `resume`, re-add after `suspend`) — splits multi-byte escapes, phantom keys.
- `?2026` BSU left pending on a crash freezes the terminal buffer — keep the window per-frame and ensure the restore handler fires.
- create-once-suspend means the renderer holds exclusive stdin/stdout across the whole session; verify it coexists with passthrough.

### Test notes

- OpenTUI test via `createTestRenderer`: hotkey opens the modal (scrim + test box present), Esc / scrim-click dismisses, input is mutexed to the modal while open. ADD the file to the `test:opentui` serial glob in package.json (it is path-ignored from the default `test` run).
- Real-PTY open/dismiss/restore + child-exit-while-open smoke as `*.slow.test.ts`.

## Acceptance

- [ ] The reserved hotkey opens an OpenTUI modal (placeholder test box) over a dim scrim; the agent is visible-but-dimmed behind (scrim only in v0)
- [ ] Esc and a click on the scrim dismiss the modal; input returns to the agent and the agent screen is restored (resize/SIGWINCH redraw)
- [ ] While the modal is open, input goes ONLY to the modal (stdin mutex; no bytes leak to the child)
- [ ] Transitions are flicker-free (`?2026` bracketing) and never leave the terminal corrupted on dismiss, child-exit-while-open, crash, or signal
- [ ] The OpenTUI test is added to the `test:opentui` serial chain and passes

## Done summary
OpenTUI modal overlay floats on the --agentwrap-modal hotkey: a suspended renderer resumes to show a placeholder Box modal over a dim alpha-blended FrameBuffer scrim, dismissed by Esc or a scrim click with an atomic stdin-mutex handoff and a SIGWINCH agent redraw. The host destroys the renderer before propagating the child's disposition on every exit path; covered by a serial test:opentui suite + a real-PTY slow smoke.
## Evidence
