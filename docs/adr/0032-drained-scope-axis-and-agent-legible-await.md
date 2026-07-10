# 32. Drained gains a scope axis (plan default); await terminals become agent-legible

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022.

## Context

`keeper await drained` required the whole board at rest: zero running jobs,
where every tracked session counted — including adopted and external sessions
(an unrelated project's shell, a research agent, the supervising session
itself). An agent arming `drained` invariably means "no open plan work left,"
so the condition was structurally unreachable on any host with a live session,
and watchers waited silently for hours on an empty board. The wait was also
illegible: the predicate computes a rich waiting detail that never surfaced,
there was no one-shot way to ask "would this fire now, and why not," and the
terminal line on timeout carried no diagnosis. Every observed arming of
`drained` on this host intended the plan meaning except one call site — the
watch skill's wedge alarm — which is repo-owned.

## Decision

1. **Bare `drained` means plan scope.** The default counts only keeper-
   dispatched work (positive dispatch provenance — autopilot and escalation
   sessions — never the `plan_verb` whitelist alone, which misses resolver/
   deconflict/repair sessions), excludes the caller's own session, and holds
   while open plan rows or pending dispatches remain. Adopted and external
   sessions never hold it.
2. **`--scope` selects the other meanings.** `--scope inflight` waits only for
   currently-running keeper-dispatched work and pending dispatches to reach
   zero, ignoring ready-but-undispatched rows (the natural pair with a paused
   board). `--scope board` is the prior strict semantics — the full
   board-at-rest gate every session holds — and the watch skill's wedge alarm
   moves to it in the same change. The flip is a deliberate default change:
   an unknown caller wanting strictness must now say `--scope board`.
3. **Waiting and terminals become legible.** Periodic heartbeats (stderr, both
   output modes, size-bounded holder names) name what holds the condition; a
   one-shot probe mode evaluates the predicate against the first painted
   snapshot and exits with a new additive registry code for "evaluated
   cleanly, does not hold" (the frozen 3/4/5 stay; 124 avoided for the GNU
   timeout collision); the terminal envelope on timeout/failure carries the
   last waiting detail and a retryable classification. The stdout contract —
   first `met`/`failed` line is terminal — stays byte-stable.
4. **Reconnect-forever stays the default** (capped backoff with jitter,
   `--connect-timeout` the opt-out), now recorded: it is what let watchers
   survive repeated daemon restarts. Its cost is measured before it is tuned —
   the efficiency work starts from a CPU measurement, and the bounce-soak gate
   grows a CPU metric alongside its flat-RSS assertion.

## Consequences

- Agents arming the natural word get the meaning they intend; the strict
  full-rest gate remains one flag away and keeps its single known consumer.
- A predicate mismatch is visible within one heartbeat interval instead of
  after hours, and a probe answers it before arming at all.
- The scope vocabulary (plan / inflight / board) becomes glossary language;
  prose avoids "unmanaged" per the existing adopted-job term.
