# 12. Agent frame-stream wire contract: bounded NDJSON chunks over rendered-frame diffs

## Status

Accepted. The usage-viewer clauses are superseded by ADR 0097; the frame stream
covers only daemon-derived viewers with Fold cursors.

## Context

An LLM agent supervising the board ("hyper mode" in the watch skill) needs to
see every rendered frame of the TUI viewers — the exact pills, churn, and
flicker a human sees — to judge whether the UI is truthful and legible.
`keeper watch` cannot serve this: its coarse projection deliberately drops
git-status/subagent/dead-letter churn and its flap-settle coalescing suppresses
exactly the flicker a UI auditor exists to catch. The viewers' piped `--watch`
passthrough streams frames but with no delimiter between multi-line frames, no
per-frame metadata, and no way to exit after a bound. Three constraints shape
the contract: the consumer is a tool-calling agent that can only hold bounded
foreground commands or poll a background task's accumulated stdout; frame text
embeds attacker-influenced content (epic slugs, failure reasons, session
titles), so framing must be injection-safe; and keeper's subscribe server
serves current projection state only — there is no historical frame replay, so
no client can truthfully promise gapless coverage across separate invocations.

## Decision

A new top-level `keeper frames --view <viewer>` subcommand streams NDJSON: one
self-delimiting single-line JSON envelope per rendered-frame change —
`{schema_version, type, seq, ts, view, cursor, diff, diff_truncated,
frame_path, state_path, diff_path}` — where `type` distinguishes
`baseline | frame | keepalive | trailer`, the inline unified diff is
size-bounded with an explicit truncation marker, and full frame text / state
JSON / full diff are dereferenced by sidecar pointers. One invocation streams
ONE view; multi-view supervision runs one process per view (the usage viewer
cannot share a process with the shared-shell viewers, so per-view processes
are the only uniform contract). Consumption is bounded-chunked by default —
`--for <dur>` / `--max-frames <n>` block, emit, then exit with a trailer
carrying the resume cursor and a coverage verdict — with `--follow` as the
reconnect-forever alternate. The cursor is the daemon's monotonic fold
cursor (`BootStatus.rev`), an opaque non-unique checkpoint (wall-clock
staleness repaints can share a `rev`), never a wall-clock timestamp. The
trailer always flushes — on `--max-frames`, `--for` timeout, and SIGINT alike.
Sidecar retention is an in-process ring over the emitting process's own files
only; no cross-pid sweep ever runs.

## Consequences

- Coverage is honest by construction: `continuous` is provable only within one
  invocation (contiguous `seq`, no reconnect); across invocations the verdict
  is `gap_possible`, and a fresh chunk may render its baseline as a net diff
  against a prior chunk's last frame. A mid-`--follow` `baseline` envelope is
  itself the reconnect/gap signal. Gapless cross-invocation coverage would
  require a server-side frame ring — a deliberate non-goal until proven needed.
- The frames envelope is a separate versioned schema from the frozen
  snapshot `keeper-meta:` contract; the two never share a version constant.
- Single-line JSON encoding is the transport-layer injection guard; the trust
  boundary stays in the consumer, which treats frame text as untrusted
  evidence, never authority.
- The shared frames emitter is consumed by both `createViewShell` and the
  usage viewer's open-coded shell path, so the wire contract cannot drift
  between them; its diff runs behind an injectable seam so the pure test tier
  covers the multi-frame path without a subprocess.

## Amendment — sidecar usage stays outside frames

`keeper usage` consumes transient Capacity observation files and has no daemon
Fold cursor, reconnect coverage, or historical replay claim. It uses the shared
live/snapshot shell but is not a `keeper frames --view` member. Adding a
sidecar-derived stream requires a separate provenance contract rather than a
null or fabricated cursor.
