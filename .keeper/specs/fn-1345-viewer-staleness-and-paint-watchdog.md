## Overview

Live dash viewers hold stale frames through daemon bounces with only a
subtle pill, and a connected-but-not-painting wedge is invisible to the
socket heartbeat — operators have repeatedly misread stale boards as live
state. This epic implements ADR 0088: an unmistakable body-region stale
banner on a new freshness axis, provable fresh-frame resumption via an
accepted-frame observable with forced repaint, and a divergence-gated,
self-healing paint watchdog. End state: a frozen pane is loud and aged,
resumption is testable, and the wedge class heals itself without
`keeper setup-tmux`.

## Quick commands

- `bun test ./test/view-shell.test.ts ./test/readiness-client.test.ts`
- `bun run typecheck`
- Operator post-deploy: `keeper daemon restart`, watch the dash board pane — the banner must appear after the debounce, then clear on the first fresh frame; frames keep advancing afterward.

## Acceptance

- [ ] A held stale frame beyond the debounce renders the full-width body-region red banner with the frame age on every live pane; sub-second bounces never flash it.
- [ ] The stale state clears only on a proven fresh frame; the connected-but-not-painting wedge trips the watchdog, renders the banner, and self-heals by resubscribing.
- [ ] Idle panes without rev divergence never trip the watchdog; no process exit or pane replacement on any path.

## Early proof point

Task that proves the approach: ordinal 1 (its wedge-reproduction fixture).
If the out-of-band rev source cannot be proven to outlive the wedge:
fall back to the connected-state read-only progress poll per ADR 0088 and
true up the ADR.

## References

- docs/adr/0088-viewer-staleness-and-paint-watchdog.md — the recorded contract (two axes, proven fresh frames, divergence-gated self-healing watchdog, visual-only)
- docs/adr/0019-tui-readiness-gate-over-boot-status.md — the catching-up gate this composes with (unchanged)
- Landed reconnect lineage: the retry/long-dead banner states and reconnect recovery this extends
- Witness log: ~/docs/keeper-review-remediation.md (stale-board misread; permanent-DISCONNECTED instance; crash-loop-era held frames)

## Docs gaps

- **CONTEXT.md**: stale-frame state + paint watchdog glossary entries, disambiguating viewer-socket reconnect from Harness resume (task deliverable; respect the existing Avoid: repaint guidance)

## Best practices

- **Freshness is a state machine composing with connection state** — never a boolean flip mirrored 1:1 from socket events [PatternFly / resilient-UX]
- **Freeze liveness affordances while stale and stamp the age** — an animated stale pane is how operators get misled [resilient-UX]
- **Render-path watchdog, not data-side heartbeat** — only a paint-coupled observable catches the painted-nothing wedge [Chromium / Qt / ANR-WatchDog]
- **Clear on proven fresh frames, reset backoff there too — never on socket-open** [epoch/logical-clock pattern]
