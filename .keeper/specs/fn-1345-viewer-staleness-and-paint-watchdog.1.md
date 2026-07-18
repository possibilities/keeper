## Description

**Size:** M
**Files:** src/view-shell.ts, src/readiness-client.ts, src/live-shell-core.ts, test/view-shell.test.ts, test/readiness-client.test.ts, CONTEXT.md, docs/adr/0088-viewer-staleness-and-paint-watchdog.md

### Approach

Implement the ADR 0088 contract on the shared view shell so all live
panes inherit it. Freshness becomes a second presentation axis
composing with the existing connection states. (1) Unmistakable stale
state: any state holding stale rows beyond a short visible-switch
debounce (~500ms; internal state flips immediately) renders a
full-width, body-region banner — red SGR plus plain text only, since
the shim strips INVERSE/DIM — carrying the held frame's age; the age
stamp ticks via an interval armed only inside the stale state (the
spinner discipline); the banner joins the held-slot predicate so
flashes cannot clobber it; liveness affordances freeze while stale.
(2) Proven fresh frames: every accepted daemon frame advances a new
accepted-frame observable even when byte-identical suppression skips
painting, and the first accepted frame after a reconnect or wedge
forces a full repaint; the stale state clears and reconnect backoff
resets only on that proven frame, never on socket-open. Align backoff
to capped-exponential with full jitter if it is not already. (3) Paint
watchdog: divergence-gated — an out-of-band daemon rev provably
advancing while zero frames were accepted within the window — and
self-healing: tripping tears down and resubscribes as well as
rendering the stale state. The idle heartbeat probe result is the rev
source of record; VERIFY it survives the app-level-eviction wedge
(the in-band lifecycle/cursor/frame callbacks all freeze together
there); if the probe path proves in-band, fall back to a
connected-state read of the injectable read-only progress poll and
true up the ADR. Local interaction repaints never feed the observable
or clear the state. Everything is gated on live mode; snapshot and
frames modes untouched; no synthetic events, problem codes, or
needs-human rows; viewers keep reconnect-forever and never exit or
require pane replacement. The stuck catching-up gate (spinner) is out
of scope. New timers use the injected clock/timer seams so tests
drive them; only the visible-switch debounce may reuse the
bare-global timeout pattern the grace timer uses.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/view-shell.ts:1272-1298 — the disconnect branch that holds the last-good frame (the witnessed path)
- src/view-shell.ts:832-858 — reconnectBanner + refreshReconnectPresentation, the sole body-repaint-during-drop seam to extend (never add a parallel painter)
- src/view-shell.ts:1213-1241 — paintLiveFrame byte-identical suppression + repaintLocal (local repaints must not feed the observable)
- src/view-shell.ts:623-636, :860-885 — disconnect state block, grace timer, bannerSlotHeld predicate
- src/view-shell.ts:590-593 — latestCursor stored but unread in live mode; :704-710 syncIndicator (route new animation here)
- src/view-shell.ts:738-747 — the shim SGR constraint (INVERSE/DIM strip)
- src/readiness-client.ts:210-227 — idle heartbeat probe (socket-liveness only today); :1382-1394 generation epoch guard (verify it fires end-to-end on a bounce); :1396-1424 handleFrame; :374-393 GiveUpPolicy (viewers reconnect-forever)
- docs/adr/0088-viewer-staleness-and-paint-watchdog.md and docs/adr/0019-tui-readiness-gate-over-boot-status.md
- test/view-shell.test.ts:61,87,134,151 — makeBoot (extend with generation), patchTimeouts, makeFakeMonotonicClock, spyStatus harness seams

**Optional** (reference as needed):
- src/live-shell-core.ts:13-14,269 — banner composer / frame-counter footer
- cli/board.ts:1219-1230 — pane wiring shape (jobs/git/autopilot/builds identical; no per-pane changes expected)
- CONTEXT.md:117-123 — Frame (Avoid: repaint) and Harness resume (Avoid: reconnect) entries the new glossary text must respect

### Risks

- The probe-result rev source may prove in-band with the eviction freeze — the fallback (connected-state read-only progress poll) is pinned in the ADR; record which source shipped.
- Divergence tuning must hold for the least-active pane (git); a false-positive banner on a healthy idle pane is a worse regression than the pill.
- Suspend/resume clock jumps must not fake a wedge: the divergence gate requires a proven rev advance, so a wake with no rev advance stays quiet; use the monotonic clock seam for ages.
- A resumed byte-identical body is the exact witnessed case — the forced repaint plus accepted-frame observable is what makes it provable; do not regress the byte-identical suppression for steady-state frames.

### Test notes

Red-repro first, all through the existing fake seams (no real daemon,
socket, or tmux): (1) bounce then byte-identical resume — accepted-frame
observable advances, forced repaint happens, banner clears, backoff
resets; (2) eviction-wedge simulation — rev source advances with zero
accepted frames, watchdog trips, teardown/resubscribe invoked, body
region carries the aged red banner; an idle pane without rev divergence
never trips; (3) sub-second bounce — no visible banner; (4) local
repaint during a wedge — banner persists, observable unchanged. Named
gates only: `bun test ./test/view-shell.test.ts ./test/readiness-client.test.ts`
plus `bun run typecheck`.

## Acceptance

- [ ] A daemon bounce held beyond the debounce renders a full-width, body-region red banner with the held frame's age on live panes; a sub-second bounce never shows it.
- [ ] The stale state and banner clear only on a proven fresh frame — an accepted daemon frame that forces a full repaint and advances the accepted-frame observable even when byte-identical — and reconnect backoff resets on that same proof.
- [ ] The connected-but-not-painting wedge (out-of-band rev provably advancing, zero accepted frames within the window) trips the watchdog: the stale banner renders AND the subscription self-heals by teardown and resubscribe; a pane with no rev divergence never trips it.
- [ ] Local interaction repaints neither clear the stale state nor advance the accepted-frame observable.
- [ ] No reconnect or watchdog path exits the process or requires pane replacement; snapshot and frames modes are byte-unchanged; no synthetic events, problem codes, or needs-human rows are emitted.
- [ ] CONTEXT.md carries stale-frame state and paint-watchdog entries disambiguating viewer-socket reconnect from Harness resume; the recorded ADR matches shipped behavior, trued up if the rev source fell back.
- [ ] Focused named gates plus typecheck are green.

## Done summary
Implemented ADR 0088 on the shared view shell: a body-region red STALE banner stamping the held frame's age past a visible-switch debounce, an accepted-frame observable with forced repaint that clears the stale state on a proven fresh frame, and a divergence-gated self-healing paint watchdog reading the out-of-band fold cursor off the read-only progress poll (the shipped rev source; heartbeat probe proved in-band) and resubscribing via a new ReadinessClientHandle.reconnect() seam. Wired all live panes; CONTEXT.md + ADR trued up.
## Evidence
