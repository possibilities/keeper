## Description

**Size:** M
**Files:** cli/bus.ts, plugins/keeper/skills/bus/SKILL.md, README.md, test/bus-cli.test.ts

### Approach

Consume the server's new publish-result frame in the CLI, make sends honest and blind, remove the `resolve` subcommand and the client heartbeat, and align the agent-facing docs. The server-side pieces (result frame, server `opResolve` removal) land in `.1`; this task owns cli/bus.ts and the docs only — no `src/bus-worker.ts` edits.

- **`runSend` awaits the result frame** (reuse the `busRoundTrip` `onFrame`→`{type:ack,op:"publish"}` matcher) instead of the register-ack + 50ms `setTimeout` hack. Map the result: `delivered` → print a confirmation, exit 0; every other result (`not_connected`/`unknown_target`/`ambiguous_target`/`delivery_failed`) → a distinct stderr message via `die()`, exit 1. Broadcast → print the recipient count, exit 0.
- **Remove `keeper bus resolve` (client side):** `runResolve`, the parse case, the `BusCommand` union member, the HELP line, the main switch case. The server op is removed in `.1`.
- **Remove the client heartbeat:** `HEARTBEAT_INTERVAL_MS`, `startHeartbeat`/`scheduleHeartbeats`, and its wiring in `watchOnce`/`handleWatchFrame`. `keeper bus watch` stays a long-lived connection; with the server on socket-close liveness it needs no heartbeat traffic — keep the reconnect/backoff loop intact.
- **Rewrite plugins/keeper/skills/bus/SKILL.md:** send blindly by current-or-former name; never pre-check `list`/`resolve` before sending; remove all `keeper bus resolve` mention; document the result/error codes and that a miss is an immediate error; keep `keeper bus list` as informational, never a precondition; delete the false "it'll land when it reconnects" claim.
- **Update README.md Agent Bus paragraph (~2772-2800):** tri-state presence + socket-close liveness (no heartbeat) + the synchronous send result frame; remove resolve-as-subcommand framing; keep `list` as informational. Leave the unrelated git/transcript/plan-worker heartbeat mentions alone.
- **Update cli/bus.ts HELP/JSDoc:** remove the `resolve` line and the now-dead heartbeat rationale.

### Investigation targets

**Required** (read before coding):
- cli/bus.ts:479-498 — `runSend` 50ms hack → await the result frame
- cli/bus.ts:375-460 — `busRoundTrip` `onFrame` matcher pattern (`runList`/`runResolve` examples)
- cli/bus.ts:344-347 — `die()` (exit 1 on stderr) — the fail-loud seam
- cli/bus.ts:781-798 — main send/broadcast cases (exit 0 today)
- cli/bus.ts:73, 116, 141-147, 511-520, 771-779 — `resolve` removal sites (HELP, `BusCommand` member, parse case, `runResolve`, main case)
- cli/bus.ts:62-67, 619-635, 643-647, 701-704 — client heartbeat scheduler + wiring to remove
- plugins/keeper/skills/bus/SKILL.md:66-68 and the Send / See-who sections — rewrite
- README.md ~2772-2800 — Agent Bus paragraph

**Optional** (reference as needed):
- cli/bus.ts:201-217 — `buildPublishFrame` (frame shape unchanged)
- test/bus-cli.test.ts:368-434 — heartbeat / register-ack tests to remove/rewrite

### Risks

- The publish-result matcher must agree with the server's frame discriminator defined in `.1` (`{type:ack,op:"publish"}`).
- Removing heartbeat client wiring must not break the watch reconnect/backoff loop — only the periodic heartbeat send goes, the long-lived connection stays.

### Test notes

Rewrite the bus-cli.test.ts heartbeat/resolve tests. Full-tier: a directed send to a connected vs disconnected agent yields exit 0 vs exit 1 with the right message; `keeper bus resolve` is gone. Sandbox the bus pair; poll with `retryUntil`. Run `bun run test:full`.

## Acceptance

- [ ] `keeper bus chat send <name> "msg"` to a connected agent prints a delivered confirmation and exits 0
- [ ] A send to a disconnected/unknown/ambiguous target prints a distinct error to stderr and exits 1 (fail loud) — no silent exit-0
- [ ] `keeper bus chat broadcast` prints a recipient count and exits 0
- [ ] `keeper bus resolve` no longer exists (subcommand, parse, help all gone); `keeper bus list` still works and is documented as informational, never a precondition
- [ ] The CLI client heartbeat scheduler is removed; `keeper bus watch` stays connected with no heartbeat traffic and still reconnects on drop
- [ ] SKILL.md instructs send-blindly by current-or-former name, documents the result/error codes, removes `resolve`, and drops the false "lands when it reconnects" claim
- [ ] README Agent Bus paragraph describes tri-state presence + socket-close liveness + the send result frame; no heartbeat or resolve-subcommand framing
- [ ] `bun run test:full` passes

## Done summary
CLI bus send now awaits the synchronous publish result: delivered exits 0, every other result (not_connected/unknown_target/ambiguous_target/delivery_failed) is a loud exit-1 on stderr. Removed the resolve subcommand and the client heartbeat; rewrote SKILL.md + README to send-blindly + tri-state presence + socket-close liveness.
## Evidence
