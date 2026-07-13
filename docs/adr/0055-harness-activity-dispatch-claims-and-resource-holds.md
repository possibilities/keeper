# 0055 — Harness activity, dispatch claims, and resource holds

## Status

Accepted (provisional number; fan-in renumber per ADR 0020/0022 applies). Supersedes
[ADR 0031](superseded/0031-finalize-defers-on-occupying-closer.md): its cwd-missing
detect-only belt and fail-closed destructive-cleanup posture remain, while its coupling of
stopped-pane liveness, dispatch occupancy, autoclose, and lane teardown does not. Complements
[ADR 0017](0017-turn-active-escalation-lifecycle.md), whose one-shot escalation policy remains a
consumer-specific rule, and preserves [ADR 0013](0013-canonical-generation-identity.md), whose
Generation continues to mean one tmux server boot.

## Context

Four different questions shared overlapping predicates:

1. Is a Harness session performing work now?
2. Which dispatch attempt may resume or replace one `verb::ref` target?
3. Which live terminal and lane resources must not be destroyed?
4. Has provider-specific transcript evidence settled enough to change lifecycle state?

Readiness already counted an active main turn, an open subagent, and attributable background
work while excluding ambient infrastructure. Dispatch dedupe and finalization instead treated a
`stopped` job with a live pane as occupying. Autoclose then became the normal event that killed
the pane and indirectly released that occupancy. A stopped Claude or Pi session whose only
children were the ambient Agent Bus watcher and language-service processes therefore consumed
no active capacity but could retain same-key dispatch and teardown ownership indefinitely.

Pane or descendant-process existence cannot answer activity. Harnesses retain infrastructure
while idle, and background work can outlive a stopped parent turn. Conversely, a stale or missing
child record cannot prove quiescence. `/work` and `/close` already share the required child-wait
discipline; changing their prompts or child-launch behavior would not repair the downstream
conflation.

Dispatch attribution also lacked an exact attempt boundary. Pending dispatches keyed only on
`(verb, ref)`, so a delayed SessionStart from an older try could consume a newer row. Tmux
Generation cannot fence this race: it identifies a server boot and can contain several attempts
for the same target.

Transcript settlement exposed the same conflation. An intermediate Claude subagent
`tool_use`/null disposition could emit `cut`; SubagentStop could consume that provisional value
before the later clean disposition arrived and stop a parent that still had live work. A later
clean stamp did not make the false stopped interval harmless because readiness, autoclose, or
cleanup could already have consumed it.

## Decision

### Independent lifecycle facts

Keeper derives three independent facts and preserves provider-specific settlement evidence:

- **Harness activity** is `active`, `quiescent`, or `unknown`. An active main turn or an
  attributable work-bearing child makes it active. Explicitly ambient infrastructure never does.
  Positive terminal evidence makes it quiescent. Missing, malformed, contradictory, or stale
  evidence is unknown rather than inferred idle. A terminal parent overrides orphaned open-child
  projection artifacts.
- **Dispatch claim** is the durable exclusive right of one Dispatch attempt to bind, resume, or
  release one dispatch target. A claim may remain parked while its Harness session is quiescent;
  this does not consume active capacity.
- **Resource hold** protects the exact pane, window, lane, worktree, and cwd incarnation a live or
  ambiguously-live session may still use. It is released only by positive, recycle-safe evidence,
  never plan completion or elapsed time alone.

A pending launch or accepted resume is a bounded capacity reservation before Harness activity is
observed. It is not mislabeled as an active turn. `unknown` fails closed for conflicting dispatch,
capacity, autoclose, and destructive cleanup and surfaces a diagnosable reason rather than
silently aging into quiescent.

### Attempt-fenced dispatch claims

The dispatch producer mints a durable, monotonically ordered **Dispatch attempt** identity before
the top-level process starts. It is distinct from Harness session id, process identity, and tmux
Generation. A metadata-only carrier may cross the generic dispatcher and birth/SessionStart
boundary; `/work` and `/close` command semantics, prompts, and child-launch behavior remain
unchanged.

Every claim acquisition, bind, resume acknowledgement, release, and supersession validates the
expected attempt identity atomically. An exact duplicate is idempotent. A stale or concurrent
loser cannot mutate the current claim. A delayed old start cannot consume a newer pending claim.
A fresh attempt may replace a parked owner only after the prior attempt is durably revoked and
fenced so a late bus wake or callback is rejected.

Claim facts are deterministic-replayed state. Pane/process observations remain producer-side
live facts. Existing unfenced rows and sessions are interpreted deterministically as
legacy-unfenced until terminal; keeper never guesses a historical attempt id. Such a session can
still be active and can retain a Resource hold, but cannot consume a newer exact claim.

### Consumer policy

All consumers read the same Harness activity result, then combine it with the fact their decision
actually needs:

| Consumer | Inputs |
|---|---|
| Readiness and active-capacity caps | Harness activity plus launch/resume reservations |
| Same-target dispatch and warm resume | Dispatch claim plus active collision evidence |
| Autoclose | quiescent activity, board completion, released/revoked claim, and exact Resource-hold preconditions |
| Finalize merge | quiescent activity plus completed board metadata |
| Pane/window/lane/worktree teardown | Resource hold and exact resource incarnation |
| Crash recovery | Dispatch claim, Harness activity, and recycle-safe resource identity |

Logical completion and merge may advance once activity is quiescent and board metadata is done.
Physical teardown remains deferred while a Resource hold exists. Autoclose actuates eligible
cleanup; it is never the source of dispatch truth.

The cwd-missing condition remains detect-only. An old cleanup intent must name and validate the
resource incarnation it observed, including canonical tmux Generation and recycle-safe process
identity where applicable; reuse of a path or title is not authority to delete it.

### Transcript settlement

Subagent cut/clean evidence is correlated to the invocation and remains provisional until the
provider-specific terminal boundary settles. An intermediate cut cannot stop the parent or unlock
downstream dispatch, autoclose, finalize, or teardown. Positive terminal evidence may classify a
true `SILENT_STREAM_CUT`; absent or incomplete evidence yields unknown and an operator-visible
reconciliation path, not timeout-derived terminality. Lifecycle transitions continue through the
per-job lifecycle-stamp gate, and transcript cursor advancement remains atomic with its projected
effects.

### Restore and harness boundaries

Autopilot-origin `work` and `close` sessions are reconciler-managed and excluded from generic
restore. Their durable Dispatch claim lets autopilot resume the exact attempt or revoke and fence
it before redispatch. Manual and Adopted sessions retain generic restore behavior. Restore and
cleanup racing for one resource use the same exact-identity preconditions; neither wins by path,
title, or arrival timing alone.

The semantic model is harness-neutral and capability-driven. Claude and Pi are the first and only
adapters changed by this decision; other harnesses retain their existing behavior. A fail-open Pi
adapter that cannot provide ownership evidence yields legacy-unfenced or unknown evidence and
blocks destructive action rather than silently acquiring a claim.

## Consequences

- A stopped session with only ambient infrastructure is quiescent, even while its pane remains
  reachable and its Dispatch claim is parked.
- Long-running attributed children remain active; staleness changes confidence and visibility,
  not terminality. Unknown evidence can hold progress but does so loudly and safely.
- Dispatch ownership survives daemon restart and cannot be stolen by an older SessionStart,
  completion callback, bus wake, or cleanup intent.
- Finalization no longer waits for autoclose merely to make logical ownership false, while
  destructive teardown remains at least as conservative as ADR 0031 required.
- `close` joins `work` under reconciler-managed crash recovery; generic restore does not launch a
  second closer.
- The implementation requires an additive schema/projection step and compatibility handling for
  unfenced history. Its migration version is assigned at merge time.
- `/work` and `/close` launch behavior stays unchanged apart from generic metadata carriage at the
  dispatcher boundary.
