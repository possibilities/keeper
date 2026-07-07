# 19. TUI readiness gate over the boot-status header

## Status

Accepted.

## Context

The daemon deliberately binds its read socket right after `migrate()`, before
the boot drain, so headless consumers (`keeper status`, `keeper await`, the
autopilot CLI) can read throughout a multi-minute re-fold; every served
`result`/`rpc_result`/`error` frame carries a boot-status header
(`{rev, head_event_id, catching_up, git_seed_required, git_unseeded_roots}`).
Human-facing viewers, however, treated "first frame painted" as "server
ready": the shared view-shell's connecting indicator self-stopped on the first
data frame, so a viewer launched (or reconnecting) mid re-fold painted every
intermediate fold state — a churning, misleading board. The mainstream
event-sourcing posture (serve the stale projection while a new one rebuilds)
does not apply: keeper re-folds in place, so mid-drain reads are not "old but
consistent," they are partial history.

Two constraints shape the fix. First, the serve-during-catch-up contract is
deliberate and headless consumers depend on it, so the daemon must keep
serving reads and the gate must live client-side, in the display layer only.
Second, `patch`/`meta` frames carry no boot header and the server's
boot-complete flip fans out to no one, so a client whose last stamped `result`
landed before the flip would otherwise hold `catching_up: true` forever on a
quiet board.

## Decision

Human-facing viewers full-gate on `catching_up`: while it holds (or while the
daemon is unreachable past a short grace) they render only a loading
indicator — re-fold progress while the fold cursor trails head, a distinct
non-spinning git-seed wait once at head, a plain catching-up line for the
residual boot window — and never paint provisional rows. The gate is a
client-side value-latch in the shared subscribe client: initially ready,
set by each boot-carrying result, cleared by a `catching_up: false` header
OR by a boot-less `result` observed while latched (the pre-serialized result
memo is bypassed during catch-up, so a headerless result is positive
steady-state evidence). While latched, a catch-up-scoped slow poll refetches
one idle collection through the existing coalescer until it observes the
clear; a server-side boot-complete push was rejected as the sole mechanism
because a push dropped during a client reconnect window re-strands the client,
whereas the level-triggered poll converges unconditionally. On a socket drop
after a first paint the viewer holds the last frame behind a reconnecting
pill through a short grace, flipping to the loading indicator on grace expiry
or immediately on positive evidence (the reconnect's first result reporting
`catching_up: true`).

The machine-facing surfaces stamp rather than block: the snapshot
`keeper-meta:` trailer and the frames `FrameRecord`/`TrailerRecord` envelopes
gain a `catching_up` field (tri-state: `true`/`false`/`null` for
never-observed), and each constant bumps under its own field-shape rule —
the two version constants stay independent, extending the envelope recorded
in ADR 0012 rather than replacing it. The frame stream mirrors the human
point of view: during catch-up it emits one ordinary frame whose text is the
static loading body (no ticking percentage, so frame dedup bounds it to one
record), never a spinner flood and never the churn the human no longer sees.

## Consequences

- A viewer can sit on the loading indicator for a whole multi-minute re-fold
  with no board visible. That is the accepted trade-off: partial fold state
  is actively misleading, and the indicator carries real progress
  (percentage from the wire header while connected, from the read-only
  SQLite re-fold poller while the daemon is down).
- A wedged git seed renders as an explicit, actionable wait line rather than
  an indistinguishable hang; the distress-row machinery remains the escape
  hatch for a daemon that never becomes ready.
- The headerless-result clear couples the client to the memo-bypass
  invariant (nothing unstamped is served during catch-up). If that invariant
  ever weakens, the failure mode is a latch that clears one backstop tick
  early — visible churn, not a wedge — and the next stamped result re-latches.
- Headless consumers are structurally unaffected: the gate lives in the
  display harnesses, and data callbacks keep delivering during catch-up.
