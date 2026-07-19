## Overview

Enrich successful live Agent Bus sends with a conservative, point-in-time snapshot of the recipient's canonical Harness activity. The sender can recognize when a message crossed an already-active response without changing delivery semantics or pretending that lifecycle state proves message consumption.

## Quick commands

- `bun test ./test/bus-worker.test.ts ./test/bus-cli.test.ts ./test/agent-run-capture.test.ts ./test/provider-leg-death-notice.test.ts`

## Acceptance

- [ ] A successful live send can report the recipient's pre-fanout `active`, `quiescent`, or `unknown` Harness activity without changing what `delivered` means.
- [ ] Missing, partial, malformed, stale, or unsupported activity evidence never changes message delivery, recipient count, exit status, or existing non-CLI sender behavior.
- [ ] Sender output explains the send-time timing boundary while making no claim that the recipient read or is processing the message.
- [ ] Agent Bus emits no automatic activity-transition follow-up and persists no recipient-activity history.
- [ ] The focused Agent Bus and shared-consumer tests pass with no database migration or new writer.

## Early proof point

Task that proves the approach: task ordinal 1. If the read-only projection snapshot cannot remain bounded and fail-soft on the Bus serve path, omit enrichment on that send rather than caching, persisting, or delaying delivery.

## References

- `docs/adr/0093-agent-bus-recipient-activity-snapshot.md`
- `docs/adr/0048-file-backed-agent-bus-messages.md`
- `docs/adr/0055-harness-activity-dispatch-claims-and-resource-holds.md`
- `CONTEXT.md` — Agent Bus, Presence, and Harness activity vocabulary
- RabbitMQ publisher-confirm versus consumer-acknowledgement separation: https://www.rabbitmq.com/docs/confirms
- Akka message-delivery reliability boundaries: https://doc.akka.io/libraries/akka-core/current/general/message-delivery-reliability.html

## Docs gaps

- **README.md**: consolidate the Agent Bus summary so state-aware sender feedback is visible without expanding the front door into operational documentation.
- **plugins/keeper/skills/bus/SKILL.md**: define the pre-fanout snapshot, its output, and the no-receipt boundary in sender guidance.
- **docs/agent-surface-contracts.md**: define the additive publish-acknowledgement contract and compatibility behavior.
- **plugins/keeper/skills/watch/SKILL.md**: keep supervisory send-outcome guidance aligned by linking to, rather than duplicating, the canonical Bus contract.

## Best practices

- **Separate transport from consumption:** publisher acknowledgement, recipient activity, notification injection, reading, and processing remain distinct facts.
- **Make uncertainty explicit:** reserve `unknown` for a complete canonical derivation with inconclusive evidence; omit the optional field when no valid snapshot can be produced.
- **Keep enrichment fail-soft:** one indexed read snapshot may enrich a send but cannot gate, retry, or reclassify delivery.
- **Preserve additive compatibility:** old acknowledgements retain their exact rendering and malformed or future metadata is ignored.
