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
