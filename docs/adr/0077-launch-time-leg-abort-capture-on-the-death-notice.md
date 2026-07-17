# 0077 — Launch-time leg abort capture on the death notice

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022. Builds on
[ADR 0069](0069-provider-leg-death-notices-and-honest-waits.md),
[ADR 0056](0056-wrapped-provider-leg-window-lifecycle.md), and
[ADR 0071](0071-durable-wrapper-leg-ownership-and-terminal-cascade.md).

## Context

A wrapped provider leg that dies before it writes a transcript leaves no result
envelope and no work to read: a `partner_died` outcome with nothing behind it.
The death notice (ADR 0069) then carries only `failure_detail` (the close-kind
and kill-reason enums), which cannot distinguish a leg the ownership cascade
tore down from one that self-exited on a boot fault, nor name the fault.

The dying pane holds the only first-hand evidence — the harness's own stderr and
the tmux `pane_dead_status` wait code. That evidence is ephemeral: a producer
probe can read it, but a fold must never (re-fold determinism forbids a fold
reading wall-clock, the filesystem, or a live process). So the capture has to
happen ONCE, at the producer, and be carried durably to the async death-notice
sweep. Pane text is attacker-influenceable and may hold secrets, so it must be
redacted and size-bounded before it is persisted anywhere.

## Decision

Capture producer-side at the synthetic `Killed` mint, gated to wrapped legs
(`birth_session_id = wrapped`). A best-effort, bounded, synchronous
`capture-pane` (+ `pane_dead_status`) reads the dying pane, mirroring the
existing `classifyCloseKind` probe. The raw text is redacted through an interim
inline denylist (sensitive `KEY=value` names + recognizable token shapes; SHAs
and UUIDs deliberately survive as forensic correlators) and byte-bounded — the
UNREDACTED text never leaves the producer.

**The evidence lives on the immutable `Killed` event's `data` payload**, beside
`close_kind`/`reason`, as an `abort_capture` object (redacted text or a typed
`capture-unavailable` marker) plus a structured `exit` `{signal, code}`. It is
NOT denormalized onto the jobs projection: the capture is a ~KB forensic blob
read exactly once by the death-notice sweep, so its home is the event, not the
hot live-only jobs row. The sweep reads it back with a plain
`e.data` join — a live producer read, not a fold — so re-fold determinism is
untouched and no migration is needed.

The notice schema bumps to v2 to carry the two new fields. Capture failure, an
already-vanished pane, or any probe error degrades to the typed
`capture-unavailable` marker and NEVER blocks or drops the terminal `Killed`
mint — the terminal-event invariant (ADR 0069) is absolute.

## Consequences

- A pre-boot leg death is now attributable from the notice alone: redacted abort
  text (when the pane persists) or a typed marker, plus a signal-vs-code exit.
- No schema change: the blob rides the event, so a rewind/replay reproduces it
  and the jobs projection stays lean.
- Reliable capture on a leg pane with no login-shell backstop needs the pane to
  persist as a `remain-on-exit` dead pane. Arming that is DEFERRED: the cascade
  window-teardown currently defers on a dead pane, so arming without that change
  would leak dead panes. Until then capture succeeds when a backstop or dead pane
  happens to persist and degrades to the marker otherwise.
- The interim redaction denylist is structured for replacement by the shared
  secrets pattern list when that ADR ratifies; it fails toward more redaction.
