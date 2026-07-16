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

`message` is the captured final assistant message, and `message_found` records whether one was present. `outcome` is one of `completed`, `no_message`, `timed_out`, `no_transcript`, `transcript_ambiguous`, `launch_failed`, or `bad_args`.

## Final-message deliverable

The final assistant message is the captured deliverable. It is one complete, self-contained answer, never a back-reference or an answer-then-follow-up delta. The agent avoids background agents and background tasks; it incorporates results from any already-running one before ending the turn.

`agent run` injects this directive in its one always-on prompt block. That block is the sole injection point: callers and prompt composition do not inject another copy.

## Panel-start idempotency

`keeper agent panel start` is idempotent by slug. Re-issuing the same slug and prompt reconciles the durable run: it reuses terminal legs, leaves running legs in place, and relaunches legs without a result. It never re-fans-out an already-admitted request. A colliding prompt or member set fails with exit `2`.
