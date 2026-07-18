# 0088 — Viewer staleness state and paint watchdog

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022. Extends
ADR 0019 (TUI readiness gate over boot status); the catching-up gate and its
spinner presentation are unchanged.

## Context

Live dash viewers hold the last-good frame across a daemon bounce with only a
small status pill, and the sole live-paint path suppresses byte-identical
bodies without advancing any observable. Operators have repeatedly misread a
held stale board as live state — most recently concluding a running closer was
not dispatched because the board rows were minutes old with no indication.
A second wedge class exists with the socket up: subscription frames stop
arriving while the daemon keeps folding (the in-band lifecycle, cursor, and
frame callbacks all freeze together), which no socket-liveness heartbeat can
distinguish from a legitimately quiet pane. The terminal shim constrains the
visual vocabulary: INVERSE and DIM strip to nothing, so an unmistakable state
must be built from the recognized SGR set and plain text.

Viewer-socket reconnection here is distinct from Harness resume (session
re-attach); this record uses "reconnect" only for the viewer's daemon socket.

## Decision

Freshness becomes its own presentation axis, composing with the existing
connection axis rather than extending it linearly.

- **Unmistakable stale state.** Any state that holds stale rows beyond a short
  debounce renders a full-width, body-region banner in red plain text carrying
  the frame's age — never only a corner pill. Liveness affordances freeze
  while stale; the age stamp ticks via an interval armed only inside the
  stale state, mirroring the existing spinner discipline. The banner joins
  the held-slot predicate so transient flashes cannot clobber it.
- **Debounced visible switch.** The internal state flips immediately on
  disconnect; the visible banner appears only after a short debounce so a
  sub-second daemon reload never flashes an alarm.
- **Proven fresh frames.** Every accepted daemon frame advances an
  accepted-frame observable even when byte-identical suppression skips the
  paint, and the first accepted frame after a reconnect or wedge forces a
  full repaint. The stale banner clears — and reconnect backoff resets —
  only on that proven fresh frame, never on socket-open alone. One proven
  frame suffices: frames are authoritative full bodies over a local socket
  behind the per-boot generation guard.
- **Paint watchdog, divergence-gated and self-healing.** The
  connected-but-not-painting wedge is detected by comparing an out-of-band
  daemon rev source against the accepted-frame observable: only a proven rev
  advance with zero accepted frames inside the window trips it — a bare
  paint-idle timer would banner every legitimately quiet pane. The idle
  heartbeat probe result is the rev source of record; a connected-state
  read-only progress poll is the sanctioned fallback if the probe path
  proves in-band with the freeze. Tripping the watchdog both renders the
  stale state and self-heals by tearing down and resubscribing. Local
  interaction repaints never clear the state or feed the observable.
- **Purely in-viewer.** The watchdog emits no synthetic event, problem code,
  or needs-human row, and is inert outside live mode. Viewers keep
  reconnect-forever semantics; no watchdog or resume path may exit the
  process or require pane replacement. The stuck catching-up gate is out of
  scope — it presents as the ADR 0019 spinner, not a frozen board.

## Consequences

- A frozen board can no longer masquerade as live state: staleness is loud,
  aged, and body-region, and the wedge class self-heals instead of waiting
  for a manual dash rebuild.
- Resumption is provable in tests through the accepted-frame observable and
  forced repaint, closing the gap where byte-identical suppression made a
  resumed pane indistinguishable from a wedged one.
- The divergence gate ties false-positive behavior to the rev source's
  honesty; a probe that cannot outlive the wedge would silence the watchdog,
  which is why the source selection carries a verified fallback.
- All live panes inherit the behavior through the shared view shell; tuning
  must hold for the least-active pane, not only the board.
