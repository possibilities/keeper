## Description

**Size:** M
**Files:** src/dash/app.ts, cli/dash.ts, test/dash-app.test.ts, test/dash-shell.test.ts, README.md

Rewrite the OpenTUI paint layer to render the card/band model from task `.1`
into a single column of robot-faced cards, add the focus cursor + terminal
toggle keybinds, rewrite the frame/shell tests, and update the docs.

### Approach

- **Scene tree:** root column = header `Text` (census / connection line) +
  `ScrollBoxRenderable` (single column, `viewportCulling:true`, scrollbar hidden
  via the sticky `body.verticalScrollBar.visible = false` setter — NOT
  `scrollbarOptions`). Cards stack vertically; full-width with a ~80-col
  `maxWidth` cap.
- **Card:** one `BoxRenderable` per `job:<id>` — `borderStyle:"rounded"`,
  `borderColor` structure-gray (index 8), `title` = project name (left). Three
  interior `Text` lines: `<rail><robot> <status> · <role> · ◉<count>` /
  `<title>` / `<age> · <session:pane>`. The rail (`▌` solid / `▏` thin) carries
  the status color (the only color channel). Robot glyph in its own slot +
  trailing space (Nerd Font Mono single-cell).
- **Card-diffing:** stable `Map<key, CardHandle>`; mutate `borderColor`/
  `borderStyle`/child Text content in place; restructure (detach-then-append)
  ONLY when banded order changes — carry over the existing order-signature
  pattern from `attachDashApp`. Never add/remove per frame.
- **Band rules:** dim full-width rule rows (structure index 8) with an inline
  title between bands; collapse (omit) a band with zero cards.
- **Focus cursor:** a `focusedKey` (job_id) in app state; `j`/`k`/arrows move it
  (keyed — survives re-sort); the focused card swaps `borderStyle`→`"heavy"` +
  `focusedBorderColor` cyan (index 14); `scrollChildIntoView(card.id)` keeps it
  visible (replaces today's `body.focus()` native scroll).
- **Terminal toggle:** a keybind (default `t`) flips `showTerminal` and repaints.
  Subscribe the jobs feed widened to include terminal states (explicit `state`
  wire filter overriding the `collections.ts:127` default) so the toggle reveals
  them client-side; the view-model gates rendering. Default render stays
  live-only.
- **Process shell:** keep `createDashApp` teardown discipline verbatim
  (reconnect-forever, ONE idempotent `exitCleanly` with destroy-before-exit,
  fatal nets, the 30s unref'd stale interval for age glyphs). Drop the
  `autopilot_state`/`armed_epics` `subscribeCollection` subs (the new header
  needs neither). `q`/Ctrl-C quit unchanged.
- **Docs:** rewrite `cli/dash.ts` HELP + module docstring; the three `src/dash/`
  module docstrings; the README dash bullet (~1025-1068) + the `active_since`
  note (~1876-1886).

### Investigation targets

**Required** (read before coding):
- src/dash/app.ts:127-339 — `attachDashApp` paint layer + the keyed-diff / order-signature machinery to adapt
- src/dash/app.ts:180-201 — ScrollBox construction + sticky scrollbar-hide setter + focus-on-mount
- src/dash/app.ts:323-330 — keypress handler (extend for j/k/arrows focus cursor + the toggle)
- src/dash/app.ts:424-602 — `createDashApp` process shell + the three subscriptions (:469-518) to trim
- cli/dash.ts:24-69 — HELP + module docstring + TTY gate (gate stays)
- test/dash-app.test.ts — `createTestRenderer` harness, `APP_RUNTIME`, `app.render`→`renderOnce`→`captureCharFrame`, `frameLineOf`, `mockInput.pressKey`
- test/dash-shell.test.ts — `DashAppDeps` injection + the `exit-triggers.ts`↔`view-shell.ts` byte-parity assertion
- package.json:15-17 — `test:opentui` chain + both fast-tier `--path-ignore-patterns` lists (reuse the 3 existing test files → no wiring change; confirm)

**Optional** (reference as needed):
- src/readiness-client.ts:1331-1366 — `subscribeReadiness`/`subscribeCollection` + how to pass an explicit `state` filter for the widened jobs sub
- src/dash/exit-triggers.ts — the byte-parity twin of `view-shell.ts` `armViewerExitTriggers` (touch both if either)

### Risks

- `BoxRenderable` border/`title`/`focusedBorderColor` are first use in the repo — verify rendering in a frame snapshot. `titleColor` does not exist, so border+title share one color (structure-gray, by design).
- Adding/removing cards per frame forces a full Yoga re-layout — mutate in place.
- The widened jobs subscription must NOT change the default (live-only) render — the view-model gates terminal visibility, not the wire.
- `exit-triggers.ts` byte-parity test — if teardown touches either file, touch both.

### Test notes

Frame snapshots in `test/dash-app.test.ts`: static card tree; live frame with
cards + band rules; focus-cursor border swap + `j`/`k` movement; terminal-toggle
keybind reveals/hides ended/killed; connecting/reconnecting header line;
empty-but-live; `q`/Ctrl-C. Shell teardown in `test/dash-shell.test.ts`
unchanged (destroy-before-exit, idempotent, byte-parity). A NEW opentui test
file would need registering in `package.json` (reuse the 3 existing → none).
Run `bun run test:opentui` + `bun run test:full` before landing; manually
screenshot a ~25-job field and confirm idle cards recede (calm).

## Acceptance

- [ ] `keeper dash` renders a single column of robot-faced cards (rounded border, project title, 3 interior lines), one per job, in three urgency bands with collapsing empty rules
- [ ] Border always structure-gray; status color only in the left rail; correct robot face per status rung; Nerd Font Mono single-cell alignment holds in a frame snapshot
- [ ] `j`/`k`/arrows move a per-card focus cursor keyed on `job_id` (survives re-sort); focused card shows a heavy cyan border; `scrollChildIntoView` keeps it visible
- [ ] A keybind toggles ended/killed visibility; default OFF (live-only); ON reveals happy/dead robots
- [ ] Header shows the census when live, `connecting…`/`reconnecting…` otherwise
- [ ] Cards mutate in place across frames (no add/remove churn); read-only/TTY-only/teardown invariants preserved (no DB, no RPC, destroy-before-exit); `exit-triggers.ts` byte-parity intact
- [ ] `cli/dash.ts` HELP + the three `src/dash/` docstrings + README dash bullet + `active_since` note rewritten for the card screen
- [ ] `bun run test:opentui` + `bun run test:full` green; a ~25-job screenshot reads calm

## Done summary
Rewrote the keeper dash OpenTUI paint layer into a single column of bordered robot job-cards (one BoxRenderable per job, rail-colored six-rung status, heavy-cyan j/k/arrow focus cursor keyed on job_id, t terminal-visibility toggle). Widened the jobs subscription to terminal states via a new subscribeReadiness jobsFilter and dropped the unused autopilot/armed subs; rewrote the frame/shell tests and the dash docs.
## Evidence
