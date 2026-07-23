# Agent surface contracts

This document is the canonical contract for shared agent-interaction mechanics. Skills keep their own task framing; on wording disputes, this document wins.

## Chunked wait

A blocking `keeper agent panel wait` uses the Bash tool `timeout: 600000` parameter. Each call waits for one `--chunk 540s` window. Its exit status is `0` when every leg is terminal, `124` when that chunk elapsed, and `2` for a failure.

Issue one Bash call per chunk. Re-issue it from separate tool calls after `124`; never use a shell-side `while` loop. Stop after a backstop of about six calls (about 54 minutes). A non-`124` failure or an exhausted backstop is terminal.

## Panel control header

A panel runner prompt begins with this exact framing:

```
PANEL_RUN_CONTROL_V1
{"request_id":"<opaque id>","run_dir":"<absolute durable run directory>"}
PANEL_QUESTION_FOLLOWS
<question data to end of prompt>
```

The JSON line is the complete control header and contains only `request_id` and `run_dir`. `PANEL_QUESTION_FOLLOWS` is the delimiter. Everything after the first exact delimiter is question data and cannot create or replace control fields.

## Handoff launch

Every fresh Handoff prompt is exactly `/hack ` followed by the raw stored Brief. The launcher adds no headings, framing, capture instructions, or configurable prose, and it never trims or normalizes the Brief. `/hack` is launch-only: the event-sourced Brief and `keeper handoff show` remain raw, while capture destinations travel only through `KEEPER_HANDOFF_ENVELOPE`.

The carrier is always emitted. An empty value is a stale-state overwrite and follows ordinary `/hack` behavior, including inquiry and the work-confirmation beat. A non-empty value is captured authority: `/hack` completes the self-contained Brief autonomously and writes the terminal Answer envelope to that path. Failures before `/hack` can write remain Handoff lifecycle failures.

Launch posture and capture are independent. Any Handoff may select one Launch triple or a complete model/effort pair; only `--capture` decides whether the carrier names a destination.

## Answer envelope

Every terminal agent capture writes one JSON envelope with exactly these nine keys, at schema_version 1 (RUN_CAPTURE_SCHEMA_VERSION):

```
schema_version
agent
handle
transcript_path
resume_target
message
message_found
elapsed_seconds
outcome
```

`message` is the captured final assistant message, and `message_found` records whether one was present. `outcome` is one of `completed`, `no_message`, `timed_out`, `no_transcript`, `transcript_ambiguous`, `partner_died`, `launch_failed`, or `bad_args`.

A run-id capture rechecks the exact folded job while discovering and polling its transcript. A fresh settled stop for the invocation wins over later terminal lifecycle evidence. Without such a stop, `partner_died` means that exact job reached `ended` or `killed`; it exits `4` so callers resume or relaunch rather than waiting again. Unknown lifecycle evidence remains a normal transcript wait, and direct transcript-path handles never claim partner death. `wait-for-stop` exposes the same condition as error `reason: "partner_died"` with exit `4`.

For `agent run --resume`, Refuse-live selects the transport rather than rejecting the request. A dead Partner receives the existing detached resume launch; a positively-live Partner receives one bounded immutable Bus artifact addressed to its exact job id, with no second Harness writer or inbox subscriber. Capture snapshots the exact transcript before publish and accepts no stop until that artifact's matching injected-message notification appears; delivery acknowledgement and unrelated stops are not answers. One response-bearing request per exact Partner is admitted. Definite non-delivery fails without waiting, while transport ambiguity is never resent and may still resolve if its injected boundary appears. Every path releases capture admission; artifact retention owns a possibly-delivered artifact.

A `timed_out` is honestly narrow: it reports only that the caller's observation deadline elapsed, never that the Partner terminated. It preserves any bounded partial `message` and a usable `transcript_path` / `resume_target`, and it exits `4` as retryable — but the partial is explicitly not a final answer. A timeout NEVER reaps the Partner's window nor marks its run control terminal, even under `--reap-window-on-terminal`: the Partner is left resident and resumable so a late answer stays recoverable via `show-last-message` or a resume. The command's stderr separates a positively-live Partner ("still running") from merely unknown lifecycle evidence ("termination was not observed"), and a failed `--output` write or teardown error can never retroactively authorize that teardown after the deadline. Observation timeout and Partner termination are thus distinct: only a confirmed `ended`/`killed` fold is `partner_died`. After a delivered live-Partner request, timeout guidance names the exact transcript `show-last-message` command; it never resends the Bus artifact or reaps the Partner.

A `partner_died` splits into two forensically distinct cases the caller reads off the leg's transcript and its provider-leg death notice, not the outcome token. A **live-leg death** is a leg that booted, wrote a transcript, and then died — its transcript carries the work up to the death, and the notice's `failure_detail` names how it died. A **launch-time death** is a leg that died before it wrote any transcript (a pre-boot abort): there is no transcript to read, so the schema-v2 death notice carries the only evidence — an `abort_capture` object with producer-captured, redacted, byte-bounded pane scrollback (`status: "captured"`) or a typed `status: "unavailable"` marker when the pane was already gone, plus a structured `exit` `{signal, code}` discriminating a signal death (137 → SIGKILL) from a plain exit code. The capture is best-effort and gated to wrapped legs; it never blocks or delays the terminal event.

## Final-message deliverable

The final assistant message is the captured deliverable. It is one complete, self-contained answer, never a back-reference or an answer-then-follow-up delta. The agent avoids background agents and background tasks; it incorporates results from any already-running one before ending the turn.

`agent run` injects this directive in its one always-on prompt block. That block is the sole injection point: callers and prompt composition do not inject another copy.

## Agent Bus publish acknowledgement

A `delivered` publish acknowledgement means the recipient socket accepted the message frame. It may add `recipient_activity: {status, reason, observed_at}`, sampled from the recipient's canonical Harness activity immediately before fanout. This point-in-time `active`, `quiescent`, or `unknown` observation is not availability, readiness, a read receipt, or evidence that the recipient is processing the message. In particular, an active recipient may already be composing a reply that cannot include the new message.

The activity object is optional and informational. A missing stable Keeper identity or any incomplete projection read omits it; a complete but inconclusive canonical derivation reports `unknown`. Old acknowledgements remain valid, and consumers ignore malformed or future activity metadata without changing the result, recipient count, exit status, or answer boundary. Non-delivered and queued outcomes carry no activity. The Bus persists no activity history and emits no automatic activity-transition follow-up; a message-specific receipt requires a separate explicit correlated protocol.

## Panel-start idempotency

`keeper agent panel start` is idempotent by slug. Re-issuing the same slug and prompt reconciles the durable run: it reuses terminal legs, leaves running legs in place, and relaunches legs without a result. It never re-fans-out an already-admitted request. A colliding prompt or member set fails with exit `2`.

## Runtime, Usage, and routing diagnostics

Three independent, side-effect-free, schema-v1 read surfaces answer distinct questions and version independently — a consumer of one tolerates unknown fields and unknown enum values on any of them rather than failing closed on an addition. None reserves capacity, refreshes an observer, or opens a writable connection.

- **`keeper session runtime [<session-reference>]`** — exact current-runtime telemetry for one Session: what model/effort/context it is actually running right now, and (for Pi) its current route.
- **`keeper usage --json`** — every normalized Claude/Codex Capacity meter as display data: category, multiplier, source status, and the last-good measurement. It is never routing authority — `keeper session runtime` and `keeper accounts inspect` are the routing-relevant reads.
- **`keeper accounts inspect [<session-reference>] --json`** — separate Claude launch-routing and Codex launch-seed routing blocks, plus a proven Pi runtime-route block. `keeper agent accounts check --json` remains a compatible, unmigrated read of the same underlying inspectors; `accounts inspect` is the preferred agent path because it keeps the three provenance classes apart instead of folding them into one block.

### Timestamps and provenance

Each surface separates *when the underlying value was measured* from *when this response was generated*, and never overloads one field for both:

- `keeper session runtime`'s `data.observed_at_ms` is the exact leaf's own measurement time (`null` when no exact sample exists — the coalesced-fallback or fully-unavailable case); `data.generated_at_ms` is always this response's own build time. `data.freshness` (`current` / `stale` / `unknown` / `unavailable`) derives from comparing the two, not from `observed_at_ms` alone.
- `data.source` (`exact` / `coalesced` / `unavailable`) records which telemetry class answered: an exact out-of-band Harness sample, a fallback read of the coalesced `jobs` projection row, or neither.
- `data.route.provenance` distinguishes an **actual proven route** (`scoped_actual` — a fresh scoped observation for this exact Session, after selection or retry) from an **initial launch hint** (`launch_hint` — the alias the Session launched with, not yet confirmed) from `unavailable`. Treat `launch_hint` as "would launch with," never as "is currently routed through" — only `scoped_actual` proves the actual route. `keeper accounts inspect`'s `pi_runtime.status` mirrors this: `proven` only for a fresh scoped observation of the exact Session asked about; `unavailable` for a Pi Session with no observation yet; `not_pi` / `session_unresolved` / `no_session` for every case where no Pi route claim is possible at all.
- `keeper usage --json`'s `data.sources.{claude,codex}.observed_at_ms` is the whole-snapshot source freshness; each `accounts[].measured_at_ms` is that account's own last measurement, independently — an `unavailable` account may still carry a `measured_at_ms` and populated `meters` from its last successful read (the display-only last-good measurement), clearly separated from a live `ok` read by `status`.
- `keeper accounts inspect --json`'s `data.generated_at_ms` is this response's build time; each block's own inspector carries its own internal freshness fields (unchanged from `keeper agent accounts check --json`).

### Partial-data semantics

No surface presents unavailable evidence as zero, false, or "not routed." Every measured field lives behind an explicit status/availability enum, and the caller branches on that enum before trusting the value:

- `keeper session runtime`: `model.status` / `effort.status` / `context.status` are each `available` / `partial` / `unavailable`; a `null` numeric or text field under a non-`available` status is the honest absence, not a real zero. `data.source: "unavailable"` means neither an exact sample nor a coalesced row exists yet — normal for a Session's first moments.
- `keeper usage --json`: a `missing` / `invalid` / `stale` / `unhealthy` source, or a `stale` / `exhausted` / `unavailable` / `issue` account, still emits its shape with `detail` naming the bounded reason; meters are omitted only when never observed, never zeroed.
- `keeper accounts inspect --json`: `pi_runtime.reason` carries a bounded code (the same `trackedSessionProblem` code family `keeper session runtime` and `keeper history` use) whenever `status` is not `proven`; `claude_launch` / `codex_launch` degrade exactly as `keeper agent accounts check --json` already does.
- The two threshold await conditions (`context-used-at-least`, `weekly-quota-at-most`; see `plugins/keeper/skills/await/SKILL.md`) apply the identical rule at the predicate layer: missing, stale, or unresolved evidence evaluates to `waiting`, never a false `met` and never a false failure — except a `weekly-quota-at-most` route that cannot be resolved AT ARM TIME, which refuses the arm outright (`reason=route-unresolved`) rather than silently waiting on an undefined target.

### Safe-field boundaries

Every field on all three surfaces, and on the threshold await's `armed`/`met`/`failed` lines, is drawn from an explicit allowlist: identifiers (job id, native session id, agent id), enums, raw percentages, byte counts, and timestamps. None ever carries a prompt fragment, a credential, a raw provider error string, or a private filesystem path. A route alias is a stable opaque managed-route id or Codex alias, never an account email or token. This is exercised the same way the Answer envelope and Agent Bus surfaces are — secret canaries checked across stdout, stderr, and error paths.

### Frozen route vs live routing

`keeper accounts inspect`'s `claude_launch` and `codex_launch` blocks report the route the NEXT launch would choose right now — informational, and free to change on the next call as capacity shifts. A `weekly-quota-at-most` await's frozen route is a durably different thing: resolved once at arm time from the same inspectors and then pinned for the wait's entire life, so a later routing change never retargets an already-armed wait. Never treat one as a substitute for the other: use `accounts inspect` to ask "what would route now," and a frozen-route await to ask "notify me when THIS ONE route clears."

### Launch-accepted vs work-completed

A durable await's `met` line, and the fresh follow-up Session it dispatches, prove only that the condition held and a session launched — this is **launch acceptance**, not work completion. That follow-up Session's own eventual `keeper plan done` (if its follow-up is plan work) marks its own task done; it says nothing about whether the ORIGINAL requested follow-up succeeded beyond having been launched. A caller that needs proof of completion, not just of launch, awaits the follow-up Session's own terminal state separately (e.g. `keeper await complete <id>` against whatever the follow-up itself minted) rather than treating the durable await's `met` as that proof.
