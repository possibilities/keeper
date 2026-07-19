## Description

**Size:** M
**Files:** cli/board.ts, src/view-shell.ts, src/live-shell-core.ts, src/live-shell.ts, src/clipboard-debug.ts, test/board.test.ts, test/view-shell.test.ts, test/live-shell.test.ts, test/clipboard-debug.test.ts

### Approach

Introduce one semantic header view model consumed by every board output mode. Allocate two fixed semantic rows at normal widths and three compact rows at narrow supported widths; group and compact at explicit separators rather than relying on word wrap. Preserve policy target, lifetime, and effective `focused`/`fallback`/`unavailable` state before lower-priority decoration, and use a deterministic width when stdout is non-TTY.

Separate transient live chrome/reconnect/copy flashes from persistent semantic header lines. Live mode dynamically adjusts header height, scroll-body top, and body height on content changes and terminal resize. Snapshot and frame text prepend the same plain semantic header without live chrome; copied diagnostics and sidecar state derive from that accepted frame. Move existing summary/autopilot metadata into the canonical header without duplicating it in the scrollable body, and include policy state in structured board frame state.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `cli/board.ts:376-383,1105-1110` — current three-line scrollable summary.
- `cli/board.ts:798-840,1152-1211` — live-only autopilot banner composition and repaint.
- `src/view-shell.ts:1265-1284,1327-1424` — shared live/snapshot/frames/sidecar render flow.
- `src/live-shell.ts:533-550,637-643` — hard-coded one-row banner and resize behavior.
- `src/live-shell-core.ts:267-280` — live chrome and persistent status composition.
- `src/clipboard-debug.ts:54-82` — copied diagnostics consume accepted frame text.

**Optional** (reference as needed):
- `cli/board.ts:328-383` — pure board summary projector/formatter pattern.
- `src/dash/app.ts:285-313` — width-aware no-wrap/overflow precedent.
- `test/dash-app.test.ts:526-545` — narrow-screen width precedent.

### Risks

- Header height changes must not corrupt selection, scrolling, history navigation, stale-frame banners, or reconnect/copy flashes.
- Width uses terminal display cells rather than JavaScript string length; ANSI and wide characters cannot shift breakpoints.
- Frames must suppress byte-identical semantic headers while still reacting to local policy/header changes.
- A fixed two/three-line promise needs a declared narrow minimum and deterministic truncation below it.

### Test notes

Test pure layouts at wide, normal, narrow-minimum, below-minimum, and non-TTY widths; live resize wide→narrow→wide; dynamic policy appearance/expiry/fallback; body top/height; snapshot/frame/copy equality; ANSI-free evidence; selection/scroll preservation; and structured frame-state parity.

### Detailed phases

1. Define the canonical semantic header model and priority-based two/three-row formatter.
2. Extend view-shell transport so semantic headers participate in accepted frame text and state while transient chrome stays live-only.
3. Make live-shell header geometry dynamic on content and resize.
4. Integrate board summary, autopilot, needs-human, and Fable-focus fields; remove duplicate body summary.
5. Prove all output modes and interaction states at width boundaries.

### Alternatives

Prepending ordinary body rows would fix snapshot visibility cheaply but let the header scroll away. Appending focus to the current banner would stay fixed but remain clipped at one row and absent from non-live evidence. Both are rejected.

### Non-functional targets

- Header formatting is pure for one `{viewModel, width, now}` input.
- Normal board updates do not add extra provider queries or high-frequency durable writes.
- Target identity and policy state remain visible before decorative metadata at every supported width.

### Rollout

The resting policy-off header remains useful and compact; no live account policy changes are required to deploy or verify the renderer.

## Acceptance

- [ ] Live board renders a fixed two-row semantic header at normal widths and a fixed three-row compact header at the declared narrow breakpoint.
- [ ] Resizing recomputes semantic rows and live header/body geometry without losing selection, scroll position, history behavior, or transient status ownership.
- [ ] Focus target, lifetime, and effective focused/fallback/unavailable state remain visible at every supported width.
- [ ] Snapshot, frames, sidecars, and copied diagnostics contain the same plain semantic header while omitting live-only chrome and ANSI control sequences.
- [ ] Existing summary, autopilot, needs-human, worktree, provider, and cap information remains available without duplicate scrollable summary rows.
- [ ] Structured board frame state carries the exact policy/header inputs used to render each accepted frame.
- [ ] Named board, view-shell, live-shell, and clipboard tests pass at wide and narrow widths.

## Done summary
Added a canonical semantic board header view model shared across live, snapshot, frame, sidecar, and clipboard output, rendering Fable focus target/lifetime/state at two normal-width rows and three compact narrow rows, with dynamic live geometry on resize and structured frame state carrying the header inputs.
## Evidence
