## Description

**Size:** M
**Files:** cli/bus.ts (new), cli/keeper.ts (SUBCOMMANDS, USAGE, handlers), test/bus-cli.test.ts (new)

The `keeper bus` command surface: a sub-dispatcher plus the socket client
(one-shot for send/broadcast/list/resolve, long-lived streaming for watch).

### Approach

Add `"bus"` to `SUBCOMMANDS`, a USAGE line, and a lazy-import handler in
`cli/keeper.ts`. New `cli/bus.ts` mirrors the `cli/plan.ts`/`cli/prompt.ts`
in-process-wrapper + sub-verb-dispatch pattern: verbs `watch | list |
resolve <target> | chat send <target> <msg|-> | chat broadcast <msg|->`
(namespace `chat` reserved as a sub-namespace so `bus pair …` slots in
later). For send/broadcast/list/resolve use a one-shot client modeled on
`cli/control-rpc.ts` `roundTrip` (one `Bun.connect({unix})`, write the bus
envelope, await the matching `id`/ack, close) — `-` reads the message from
stdin. `watch` is a LONG-LIVED streaming client: connect, subscribe (all
namespaces by default), print each inbound message as a one-line
notification `[time] [sender@id] message` tagged with a stable
AUTHORITATIVE-directive marker (e.g. `Agent Bus directive from
<resolved-name>`) that stays within the Monitor clip budget; when a line
would exceed the budget (~400 chars) spill the full body to
~/.local/state/keeper/bus/inbox/<ts>-<from>.md and emit a compact pointer
line; prune spills older than ~3 days at startup. Inbound messages are
rendered as AUTHORITATIVE — NOT as untrusted/out-of-band content. (This task
only RENDERS the marker; the full behavior contract — act as if the human
directed it, no permission gate — is authored in
fn-875-keeper-agent-bus.5.)

### Investigation targets

**Required** (read before coding):
- cli/keeper.ts:22-43 (SUBCOMMANDS), :46-87 (USAGE), :153-179 (handlers map)
- cli/plan.ts + cli/prompt.ts (in-process wrapper template)
- cli/control-rpc.ts:40 (roundTrip one-shot UDS client)
- src/bus-worker.ts wire ops + envelope (from fn-875-keeper-agent-bus.2)

**Optional** (reference as needed):
- ~/code/arthack/apps/chatctl/chatctl/run_watch_chat.py (_emit / _spill_message / _prune_inbox — the watch+spill shape), run_send_message.py, run_list_chatters.py

### Risks

- `watch` must NOT reuse the one-shot client (it closes on first frame) — it is a streaming subscriber that stays open and survives reconnect.
- Spill budget + pointer format must keep the emitted line under the Monitor clip threshold, else long messages are silently truncated.
- Stdin `-` handling and exit codes (send = persisted vs delivered) must be defined and tested.
- The authoritative marker is presentation only — do not bake permission/gating logic into the renderer; behavior lives in the advice (fn-875-keeper-agent-bus.5).

### Test notes

Unit-test the dispatcher routing (mirror test/keeper-cli.test.ts), envelope
construction, the spill decision + pointer formatting, the authoritative
marker rendering, and stdin `-`. A round-trip against a real bus socket
belongs in the full tier (shares the .2 integration harness); sandbox
KEEPER_BUS_SOCK/KEEPER_BUS_DB.

## Acceptance

- [ ] `keeper bus` routes watch | list | resolve | chat send | chat broadcast; unknown verb → usage/exit 1; `--help` works
- [ ] send/broadcast/list/resolve round-trip via a one-shot UDS client; `-` reads the message from stdin
- [ ] `watch` is a long-lived subscriber that renders one-line notifications and spills long bodies to bus/inbox/ with a compact pointer; old spills pruned at startup
- [ ] `watch` tags each inbound message with a stable authoritative-directive marker (e.g. `Agent Bus directive from <name>`), NOT as untrusted/out-of-band content
- [ ] CLI unit tests pass; the full-tier round-trip is green under test:full

## Done summary

## Evidence
