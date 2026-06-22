## Overview

The Agent Bus silently drops a directed send when the target is not currently connected: name resolution conflates "known identity" with "deliverable," delivery to a disconnected channel no-ops while the log records `delivered`, and the CLI returns exit 0 with no output — so a drop is indistinguishable from a success. This epic makes a send synchronous and honest (an immediate `delivered`/`not_connected`/`unknown_target`/`ambiguous_target`/`delivery_failed` result, fail-loud in the CLI), gates delivery on an actually-open socket while still resolving current-or-former names, and retires the 90s heartbeat in favor of socket-close detection with NO replacement timer. Agents send blindly — the `resolve` subcommand is removed and `list` is never a precondition.

## Quick commands

- `keeper bus chat send <connected-agent> "hi"`    # prints delivered, exit 0
- `keeper bus chat send <disconnected-agent> "hi"` # prints not_connected to stderr, exit 1
- `bun run test:full`

## Acceptance

- [ ] A send returns an immediate, accurate result; a non-delivery is a loud exit-1, never a silent exit-0
- [ ] A disconnected-but-known agent returns `not_connected` (resolves by identity, delivers to no one); `messages.status` records the true outcome
- [ ] The heartbeat is fully retired with no periodic liveness timer; socket-close is the death signal; boot rehydration still drops dead pids
- [ ] `keeper bus resolve` is gone; agents send blindly by current-or-former name; `keeper bus list` remains informational
- [ ] `bun run test:full` passes

## Early proof point

Task that proves the approach: `.1` (server tri-state presence + honest result frame). If it fails: the result outcome can't be computed reliably from fanout — fall back to a minimal "open-socket count at send time" gate before widening the result vocabulary.

## References

- Originating Agent Bus epic: `fn-875` (closed) — this epic is the canonical record of the new liveness/delivery model; do not edit the closed fn-875/fn-878 specs (forward-facing-docs rule).
- In-repo precedent for process-liveness over heartbeat: `src/server-worker.ts` `reapDeadPeers`/`isPidAlive` — referenced as the boot-only probe; this epic adds NO steady-state sweep.
- Incident forensics: a killed+resumed agent (session 7748d842) had its channel reaped after 90s of no heartbeat; a send during the reconnect gap recorded `status="ok"` with null resolution and was silently dropped, while a later send after rejoin delivered and got a reply — the silent exit-0 hid both.
- Forward path (OUT OF SCOPE): a `not_connected` result is the seam for a future dispatch-resume "wake-on-send" (resume the session via `keeper dispatch`, then deliver). The result vocabulary distinguishing `not_connected` from `unknown_target` is exactly what unlocks it with no later protocol change. L2 end-to-end read-receipts are also deferred.

## Docs gaps

- **README.md (~2772-2800)**: rewrite the Agent Bus paragraph to tri-state presence + socket-close liveness + the send result frame; drop heartbeat and resolve-subcommand framing.
- **plugins/keeper/skills/bus/SKILL.md**: send-blindly rewrite; remove `resolve`; document the result codes; delete the false reconnect-delivery claim.
- **cli/bus.ts help/JSDoc**: remove the `resolve` line and the dead heartbeat rationale.

## Best practices

- **Socket EOF is the primary peer-death signal on local UDS:** a kill/crash closes the peer's fd → kernel FIN → `close()` fires; NOTE_EXIT/pidfd are supplementary and unneeded here.
- **"delivered" = full frame accepted into an open socket (L1), never an end-to-end ack:** check the `write()` return against frame length; a partial write is `delivery_failed`, not `delivered`.
- **Suppress SIGPIPE before writing to a possibly-dead peer on macOS** (no MSG_NOSIGNAL) — but first verify whether `Bun.listen` already surfaces EPIPE as a write return rather than a signal.
- **Key liveness/identity on (pid, start_time), never pid alone** (macOS pid reuse) — already in place; preserve it.
