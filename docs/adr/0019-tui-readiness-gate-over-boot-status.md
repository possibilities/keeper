# 19. TUI readiness gate over the boot-status header

## Status

Accepted.

## Context

The daemon deliberately binds its read socket right after `migrate()`, before
the boot drain, so headless consumers (`keeper status`, `keeper await`, the
autopilot CLI) can read throughout a multi-minute re-fold; every served frame
carries `{rev, head_event_id, catching_up, git_seed_required,
git_unseeded_roots}` boot status.
Human-facing viewers, however, treated "first frame painted" as "server
ready": the shared view-shell's connecting indicator self-stopped on the first
data frame, so a viewer launched (or reconnecting) mid re-fold painted every
intermediate fold state — a churning, misleading board. The mainstream
event-sourcing posture (serve the stale projection while a new one rebuilds)
does not apply: keeper re-folds in place, so mid-drain reads are not "old but
consistent," they are partial history.

Two constraints shape the fix. The serve-during-catch-up contract is
deliberate — headless consumers depend on it — so the gate must live
client-side, in the display layer only. And `patch`/`meta` frames carry no
boot header while the server's boot-complete flip fans out to no one, so a
client whose last stamped `result` landed before the flip would otherwise
hold `catching_up: true` forever on a quiet board.

## Decision

Human-facing viewers full-gate on `catching_up`, which follows the main boot
gate plus pending git seed; `rev`/`head_event_id` are progress telemetry only.
While gated they render re-fold progress, git-seed wait, or plain catch-up text
and never paint provisional rows. The shared client keeps a per-connection
tri-state latch: the first valid `result` publishes its state, including ready
`false`, and later results publish flips only. A boot-less result establishes
or clears ready `false`; memo bypass during catch-up makes it positive
steady-state evidence. While true, a slow poll refetches one idle collection
until it clears. This level-triggered path converges without a boot-complete
push that could drop and strand a reconnecting client.

A post-paint transport drop has three presentation states. The short grace
holds the last-good frame behind the unchanged `reconnecting…` pill. After
grace, `waiting` lifecycle telemetry supplies a plain banner with its attempt
and decreasing retry countdown, while the frame remains visible. Once the
monotonic age of that last-good frame crosses a small threshold, the banner
uses the plain `DISCONNECTED` token with that age and the body adds the
colorized indicator without replacing the panel. A ready paint clears every
connection presentation and resets its monotonic frame stamp; transport-open
alone does neither. A generation re-baseline with no transport drop therefore
has no banner effect.

The machine-facing surfaces stamp rather than block: the snapshot
`keeper-meta:` trailer and the frames `FrameRecord`/`TrailerRecord` envelopes
gain a tri-state `catching_up` field (`true`/`false`/`null` for
never-observed), each bumping its own field-shape rule and extending the
envelope recorded in ADR 0012 rather than replacing it. The frame stream
mirrors the human view: one ordinary frame carries the static loading body
during catch-up (no ticking percentage), never a spinner flood.

## Consequences

- A viewer can sit on the loading indicator for a whole multi-minute re-fold
  with no board visible. That is the accepted trade-off: partial fold state
  is actively misleading, and the indicator carries real progress (wire
  header while connected, the SQLite re-fold poller while down).
- A post-paint outage degrades in place: it first exposes retry timing, then
  an age-based `DISCONNECTED` warning, rather than blanking the last-good
  panel or confusing it with a readiness gate.
- A wedged git seed renders as an explicit, actionable wait line rather than
  an indistinguishable hang; the distress-row machinery remains the escape
  hatch for a daemon that never becomes ready.
- The headerless-result clear couples the client to the memo-bypass invariant
  (nothing unstamped is served during catch-up). A weakened invariant fails
  as visible churn (an early backstop-tick clear), not a wedge.
- Headless consumers are structurally unaffected: the gate lives in the display harnesses, and data callbacks keep delivering during catch-up.
