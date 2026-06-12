## Description

**Size:** S
**Files:** src/live-shell.ts, src/dash/app.ts, test/live-shell.test.ts (only if an expectation shifts), test/dash-app.test.ts (only if an expectation shifts)

### Approach

Immediately after each `ScrollBoxRenderable` construction, assign
`<box>.verticalScrollBar.visible = false` and
`<box>.horizontalScrollBar.visible = false`. The ScrollBar `visible`
setter pins `_manualVisibility = true`, which permanently disables the
auto show-on-overflow logic (`recalculateVisibility()` no-ops while the
flag is set, `recalculateBarProps()` never writes `visible`, and nothing
in the opentui bundle calls `resetVisibilityControl()`), so the hide is
sticky for the renderer's lifetime and survives resize. Bare property
access is correct — `verticalScrollBar`/`horizontalScrollBar` are
non-optional `readonly` fields constructed unconditionally.

Placement: in src/live-shell.ts, right after the `const sb = new
runtime.ScrollBoxRenderable(...)` at ~line 544 (before the first
`sb.viewport.width` read at ~564); in src/dash/app.ts, right after the
`const body = new runtime.ScrollBoxRenderable(...)` at ~line 148 (before
`root.add(body)` / `body.focus()`). Do NOT route the hide through the
runtime ctor bags — the instance already exposes both bars.

Add a short forward-facing comment at each site stating the invariant
and the trap: passing `scrollbarOptions: { visible: false }` at
construction does NOT stick (the base Renderable constructor writes
`_visible` directly, bypassing the ScrollBar setter, so the bar
reappears on overflow), and the post-construction `scrollbarOptions`
setter has the same bypass (it `Object.assign`s onto the bar). The
post-construction `.visible = false` assignment is the only sticky path.

Hiding the vertical bar reclaims its column, so `sb.viewport.width` can
grow by 1 on overflow frames relative to the old bar-visible state. The
live-shell right-edge bg-pad (`linesToContent` consuming
`sb.viewport.width`) adapts on repaint; dash rows are `width: "100%"`
yoga nodes and need nothing.

Verification: run `bun run test:opentui` explicitly —
test/live-shell.test.ts and test/dash-app.test.ts are path-ignored from
both `bun test` and `bun run test:full`, so the default tiers execute
zero coverage for this change. Existing frame assertions are
`.toContain()` substring checks (column-shift tolerant) and should hold;
if any `captureCharFrame` expectation pins a right edge or exact width,
update it in the same commit.

### Investigation targets

**Required** (read before coding):
- src/live-shell.ts:544 — construction site #1 (`id: "live-shell-scroll"`); backs usage + all createViewShell consumers (board, jobs, autopilot, git, builds)
- src/dash/app.ts:148 — construction site #2 (`id: "dash-body"`) for keeper dash
- src/live-shell.ts:564 — first `sb.viewport.width` read (also ~573, ~707); the one consumer affected by the reclaimed column

**Optional** (reference as needed):
- node_modules/@opentui/core/renderables/ScrollBar.d.ts — `visible` setter / `resetVisibilityControl` surface
- test/live-shell.test.ts:345 — tall-frame overflow test; the place a right-edge expectation would shift
- src/ansi-to-styled.ts:353 — right-edge bg-pad that consumes viewport width

## Acceptance

- [ ] Both bars hidden via post-construction `.visible = false` at both construction sites, each with a forward-facing comment naming the sticky-setter invariant and the `scrollbarOptions` trap
- [ ] Tall-frame overflow renders show no scrollbar column in either scene
- [ ] Existing scroll behavior tests pass unchanged (keys, wheel, scroll reset)
- [ ] `bun run test:opentui` passes, with any right-edge frame expectation updated in the same commit

## Done summary

## Evidence
