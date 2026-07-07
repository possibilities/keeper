# 17. Turn-active escalation lifecycle and block-instance binding

## Status

Accepted. Amends 0007 (autonomous escalation dispatch): 0007's dispatch-once
latching and paging stages stand; this record replaces its implicit
session-liveness occupancy model.

## Context

Escalation sessions (`unblock::<task>`, `deconflict::<epic>`, and the tier-1
`resolve::<epic>` resolver) are interactive claude sessions launched into
managed tmux windows. Their skills end the turn on success and on decline —
the CLI process never exits — so a finished session idles at its prompt
indefinitely: jobs state `stopped`, backend pane alive.

Every escalation guard (per-key occupancy, per-epic serialization, the global
concurrency cap, and the stage-3 human-notify classifier) keyed on one shared
predicate that counted a `stopped` session with a live backend as live —
conservative in the direction that is safe for `work::`/`close::` workers,
which are legitimately bus-resumable while stopped. For one-shot escalation
sessions it is unboundedly wrong: a succeeded-and-idle session occupied its
epic's only unblock slot forever, silently starving every later escalation for
that epic (observed in production: a task's second block never dispatched a
new unblock session and never paged). A declined session idled identically, so
stage-3 never paged a declined block either, and its `declined` verdict keyed
on an unreachable `ended` state. Nothing reaped the windows: the autoclose
worker's positive-provenance buckets admit only autopilot `work`/`close`
workers and panel legs.

Three questions were being answered by one predicate: is a turn actively
running (occupancy)? was this specific block instance already dispatched
(dispatch-once)? should this idle window be reaped (actuation)?

## Decision

Split the three concerns into orthogonal layers:

1. **Occupancy is turn-activity.** For the escalation verbs only, the
   occupancy/cap/serialization guards and the stage-3 liveness arm count a
   session live iff `jobs.state === 'working'`, unioned with the producer's
   in-flight launch memo at every consumer. `stopped` is done — the skills are
   one-shot, never re-prompted. The shared `isStoppedJobLive` rule is
   untouched for every other verb. Dispatch-once remains the
   `block_escalations` latch — occupancy needs no process-liveness at all.
   The per-epic one-live-unblock serialization is kept: its mass-block dedup
   rationale was sound; only its liveness input was wrong.

2. **Sessions bind to their block instance, jobs-side.** A block instance —
   one entering-blocked episode, keyed by its arming event id — is the unit
   escalation state scopes to. The binding SessionStart fold stamps
   `jobs.dispatch_origin = 'escalation'` and `jobs.escalation_instance` (the
   instance's event id: `block_escalations.blocked_since` for unblock,
   `dispatch_failures.instance_event_id` — the sticky conflict row's
   first-appearance event id, reborn on re-mint — for deconflict/resolve),
   corroborated by those prior deterministic projections, never by the
   `--name` spawn heuristic. The latch fold stays untouched; the job
   references the instance, not the reverse, because the latch is deleted at
   exactly the moment the window becomes reapable.

3. **Stage-3 classifies per instance, from board state.** The job rows the
   classifier reads are scoped to the current latch's instance (NULL-stamped
   rows included, conservatively), so a resolved instance's stale rows can
   neither suppress nor prematurely fire the page for a re-block — required
   even with autoclose on, since a killed window leaves its jobs row behind.
   The verdict derives from board state: declined = session terminal while the
   task is still blocked under an attempted latch; died = killed/ended.

4. **A third autoclose bucket reaps escalation windows.** Membership is the
   `'escalation'` origin stamp plus a non-null instance; rails are identical
   to the autopilot bucket (fail-closed, stopped-only, never prompt-parked,
   blast-capped, grace, `autoclose_enabled`). The done-signal is
   instance-precise: the session's own instance no longer open. Window reaping
   is deliberately independent of slot release — disabling autoclose leaves
   windows open but starves nothing.

5. **Surface-and-stop blocks surface on the board.** The never-escalated
   categories keep their no-agent/no-page contract, but their homed sticky
   `work::` suppression rows join the top-of-board needs-human block and the
   banner count, and the status envelope names them as a subset member of
   `stuck_dispatches` (already in the total — named, never re-added).

Rejected: keying occupancy on the instance stamp alone (a declined-and-idle
session is still its instance's current session, so instance-keyed slots
re-starve the global cap); dropping the per-epic serialization (forfeits
mass-block dedup and lets one epic monopolize the global cap); a
dispatch-intents table for stamp corroboration (heavier than the projection
read; reconsider only if the fast-manual-unblock stamp-miss edge proves real).
