# 0013 — Jobs lifecycle stamp and the stuck-state sentinel

Status: accepted.

## Context

The jobs projection derived "this session is working" from event *arrival* order.
Hook events come from racing short-lived writer processes, so ingestion order (the
`events.id` the fold processes) can disagree with event time. Two production
incidents in one afternoon shared one shape: the turn-final `Stop` ingested first,
then a straggler `PostToolUse` with an *earlier* timestamp, and the reducer's "bare
un-stop" arm — any current-session tool event proves liveness, no event-time
check — resurrected the correctly-`stopped` row to `working`. The straggler was the
session's last event ever, so the wrong state was permanent ("phantom working"):
autoclose examines only `state='stopped'` rows, the board rendered
`[running:job-running]`, `close::` stayed dep-blocked, and no producer detected the
contradiction — while a harness-authored `idle_prompt` Notification arrived a minute
later and was discarded by the Notification whitelist. The un-stop arm assumed "the
next Stop folds it back," which fails exactly when a session goes idle for good —
the normal end-of-life for autopilot workers.

## Decision

Three layers, one root-cause fix:

1. **Per-job lifecycle stamp in the fold.** `jobs.last_lifecycle_ts` is a monotonic
   per-row event-time high-water mark. Every lifecycle-state-writing arm routes
   through one shared helper: a transition applies only when the event's `ts` has
   not regressed behind the stamp; the stamp advances to `max(stamp, event.ts)` on
   apply. The gate is polarity-aware: quiescing transitions (`→ stopped`) apply at
   `ts >= stamp`, activating ones (`→ working`, including prompt-revival) require
   strictly `ts > stamp` — at an equal-ts tie quiescence wins (remove-biased
   last-write-wins). Equal-ts ties are a hot path on one host, not a rare edge. The
   tiebreak must never be "fixed" into an `event.id` tiebreak: insertion id is
   arrival order, the exact untrusted input — an id tiebreak re-imports the bug.
   Terminal arms (`Killed`, `SessionEnd`) keep their identity guards, are exempt
   from stamp *rejection* (a row pinned by a bogus far-future ts stays healable),
   and still advance the stamp. A `NULL` stamp always applies. Pure over event
   fields: re-fold deterministic, O(1) per event.

2. **`idle_prompt` folds as positive idle evidence.** The Notification arm folds
   `event_type='idle_prompt'` to `working → stopped` behind the same stamp,
   terminal, and subagent-yield guards as `Stop`. Done becomes an explicit
   assertion, not absence-of-events. Helper only: the signal is claude-authored;
   other harnesses never emit it.

3. **Two-tier producer-side stuck-state sentinel.** A periodic producer (pure
   predicate, injected clock/liveness probes; wall-clock never enters the fold)
   watches the contradiction class. Tier one — task marked worker-done, row still
   `working`, events stale, pid alive, no fresh in-flight subagent — is a logical
   contradiction, self-healed by a corrective synthetic quiescence event folding to
   `stopped`. Tier two — any `working` row with stale events and an alive pid, at a
   much longer threshold — is detect-only. Both tiers mint a sticky anomaly distress
   row surviving the heal, cleared only by operator ack (`retry_dispatch`): every
   firing is evidence of a layer-1 gap, and a silently self-tidying corrector is how
   this class stayed invisible for weeks. The corrective event is deliberately not
   `Killed`: the exit-watcher is the sole `Killed` producer, `killed` fails the
   `stopped`-only autoclose gate, and killing mislabels completed work.

## Alternatives rejected

- **Reorder the ingest spool by ts** — a bounded reorder buffer needs a wall-clock
  flush (id order would hinge on a buffering decision, breaking replay determinism),
  and a straggler past the window reintroduces the bug anyway.
- **Let plan-done outrank a live `working` job in readiness** — reopens the race: a
  still-cleaning-up worker declared done, a sibling dispatched into its checkout.
- **Broaden autoclose to reap `working` rows** — kills real workers whenever plan
  completion races ahead of the harness; the gate is correct once state is truthful.
- **Ingest-time ts clamping** — the sentinel flags implausible skew instead.

## Consequences

Schema bump with a **rewinding** migration: the stamp is back-derived by replay
(never SQL back-fill), wiping the full current deterministic-replayed projection set
— enumerated fresh, not copied from an older rewind — so existing phantom rows
self-heal on deploy. Lifecycle correctness no longer depends on arrival order; stale
events annotate but never resurrect. A new producer joins the exit-watcher family; a
new synthetic quiescence event kind joins the fold vocabulary.
