# 43. Pi Agent Bus presence uses a session-scoped watcher child

## Status

Accepted.

## Context

Claude loads Keeper's `keeper bus watch` command as an always-on Monitor, which gives each session live Agent Bus presence and injects inbound messages into the model's next turn. Pi has no Monitor primitive, but Keeper already arms one ephemeral, fail-open extension on every tracked Pi launch.

Pi extensions can own long-lived session resources and inject custom messages. The existing bus watcher already owns daemon reconnects, identity enrichment, notification rendering, and oversized-body spill files. Reimplementing the bus socket protocol inside the Pi extension would duplicate those contracts. A plain stdout adapter is insufficient because rendered message bodies may contain physical newlines, and a watcher orphaned by an abrupt parent death would remain falsely present until its socket closes.

## Decision

Keeper's existing Pi extension owns one `keeper bus watch` child per Pi session runtime.

- The child starts on `session_start` and is released on every `session_shutdown` reason. A process-global ownership lease keeps nested Pi AgentSessions from starting competing watchers with the inherited job identity.
- The watcher exposes a machine-framed NDJSON output mode so one bus notification remains one physical record even when its displayed content contains newlines.
- The extension injects each record as a displayed custom message with `deliverAs: "steer"` and `triggerTurn: true`. An idle Pi wakes immediately; a busy Pi receives the message before its next model call without treating it as keyboard input.
- The child holds an stdin lifetime lease. Parent death closes the pipe in the kernel; normal teardown closes it deliberately, followed by bounded TERM and KILL fallbacks. A bounded restart ladder recovers an unexpectedly exited watcher while the owning session remains live.
- The watcher registration carries `KEEPER_JOB_ID` as its client identity floor while server-side process ancestry remains authoritative.
- Pi's Stop snapshot reports the child as an ambient background task. It is visible to monitor health surfaces but never counts as worker-launched occupancy.
- The extension remains keeper-launch-scoped, node-only, and fail-open. Standalone Pi invocations do not load or join through this path.

## Alternatives considered

- **Implement the Agent Bus UDS protocol directly in the extension.** Rejected because it duplicates reconnect, framing, spill, and identity behavior already owned by `keeper bus watch`.
- **Install a second global Pi extension.** Rejected because global installation would affect non-Keeper Pi sessions and split one Keeper lifecycle across independently loaded extensions.
- **Use Pi's inter-extension event bus or a trigger file.** Rejected because neither provides cross-process Agent Bus identity and presence.
- **Inject inbound messages as user messages.** Rejected because peer traffic must not impersonate the human typing at the keyboard.

## Consequences

Tracked Claude and Pi sessions share the same Agent Bus command and server protocol while adapting delivery through their native lifecycle surfaces. Pi session replacement cannot leak a watcher or deliver through an invalidated extension instance. The bus CLI's machine framing and lifetime lease are internal integration contracts covered by pure fast-tier tests.
